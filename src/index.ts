import { Client, Events, GatewayIntentBits } from 'discord.js';
import { createInterface } from 'node:readline';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from './config.js';
import { ensureGuildSettings, openDatabase } from './db.js';
import { createLogger } from './logger.js';
import { TicketService } from './services/ticket-service.js';
import { TicketPanelService } from './services/ticket-panel-service.js';
import { OperationCoordinator } from './services/operation-coordinator.js';
import { ReportService } from './services/report-service.js';
import { ModerationService } from './services/moderation-service.js';
import { AnnouncementService } from './services/announcement-service.js';
import { LockdownService } from './services/lockdown-service.js';
import { SafetyService } from './services/safety-service.js';
import { Scheduler } from './services/scheduler.js';
import { createApiServer } from './api/server.js';
import { installInteractionHandler } from './bot/handler.js';
import { installGatewayEvents } from './bot/events.js';
import type { GuildSettings } from './settings.js';

export interface Logger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  debug(message: string, fields?: Record<string, unknown>): void;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const processStartedAt = new Date().toISOString();
  const logger = createLogger(config);
  const db = openDatabase(config.DATABASE_PATH);
  const client = new Client({ intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildModeration,
  ] });

  const tickets = new TicketService(db, client);
  const ticketPanels = new TicketPanelService(db, client);
  const reports = new ReportService(db, client);
  const moderation = new ModerationService(db, client);
  const announcements = new AnnouncementService(db, client);
  const lockdown = new LockdownService(db, client, moderation);
  const safety = new SafetyService(db, client, lockdown);
  const scheduler = new Scheduler(db, client, announcements, lockdown);

  const operations = new OperationCoordinator();
  installInteractionHandler({ db, client, tickets, reports, moderation, announcements, lockdown, operations, logger });
  installGatewayEvents(client, db, safety, logger, operations);

  client.once(Events.ClientReady, (readyClient) => {
    void operations.run(async () => {
    logger.info('Bot connesso a Discord', { userId: readyClient.user.id, guildCount: readyClient.guilds.cache.size });
    const legacyPanels = await ticketPanels.importLegacyPanels().catch(() => ({ imported: 0, skipped: 1 }));
    if (legacyPanels.imported || legacyPanels.skipped) logger.info('Pannelli precedenti verificati', { imported: legacyPanels.imported, skipped: legacyPanels.skipped });
    const recoveredPanels = await ticketPanels.recoverIncomplete(processStartedAt).catch(() => ({ resumed: 0, failed: 1 }));
    const recoveredTickets = await tickets.recoverIncomplete(processStartedAt).catch(() => ({ recovered: 0, failed: 1 }));
    logger.info('Ripristino operazioni ticket completato', { panelsResumed: recoveredPanels.resumed, panelsPending: recoveredPanels.failed, ticketsRecovered: recoveredTickets.recovered, ticketsPending: recoveredTickets.failed });
    for (const guild of readyClient.guilds.cache.values()) {
      try {
        const stored = ensureGuildSettings(db, guild.id);
        const access = await tickets.reconcileStaffAccess(guild.id, stored.settings, stored.settings).catch(() => ({ failed: 1 }));
        if (access.failed) logger.warn('Permessi dei ticket esistenti non riallineati', { guildId: guild.id });
        await safety.syncAutoMod(guild.id, stored.settings).catch(() => logger.warn('Sincronizzazione AutoMod non riuscita', { guildId: guild.id }));
        const hasManagedPanels = Boolean(db.prepare('SELECT 1 FROM ticket_panels_managed WHERE guild_id = ? LIMIT 1').get(guild.id));
        if (!hasManagedPanels && stored.settings.modules.tickets && stored.settings.tickets.enabled && stored.settings.channels.ticketPanel) {
          await tickets.createPanel(guild.id, stored.settings).catch(() => logger.warn('Sincronizzazione pannello ticket non riuscita', { guildId: guild.id }));
        }
      } catch { logger.warn('Configurazione server non caricata', { guildId: guild.id }); }
    }
    await scheduler.start().catch(() => logger.error('Pianificatore non avviato'));
    }).catch(() => logger.warn('Preparazione avvio Discord non completata'));
  });

  client.on(Events.GuildCreate, (guild) => {
    void operations.run(async () => {
      const stored = ensureGuildSettings(db, guild.id);
      await safety.syncAutoMod(guild.id, stored.settings).catch(() => logger.warn('Sincronizzazione AutoMod non riuscita', { guildId: guild.id }));
      const hasManagedPanels = Boolean(db.prepare('SELECT 1 FROM ticket_panels_managed WHERE guild_id = ? LIMIT 1').get(guild.id));
      if (!hasManagedPanels && stored.settings.modules.tickets && stored.settings.tickets.enabled && stored.settings.channels.ticketPanel) {
        await tickets.createPanel(guild.id, stored.settings).catch(() => logger.warn('Pannello ticket non creato', { guildId: guild.id }));
      }
    }).catch(() => logger.warn('Preparazione del nuovo server non completata', { guildId: guild.id }));
  });

  const apiServices = { db, client, config, tickets, ticketPanels, reports, moderation, announcements, lockdown, safety, scheduler };
  let api: FastifyInstance | null = null;
  let siteLifecycle = Promise.resolve();
  let terminal: ReturnType<typeof createInterface> | null = null;
  const startSite = async (): Promise<void> => {
    siteLifecycle = siteLifecycle.catch(() => undefined).then(async () => {
      if (api) return;
      const nextApi = await createApiServer(apiServices);
      try {
        await nextApi.listen({ port: config.PORT, host: config.HOST });
        api = nextApi;
        logger.info('Sito e API in ascolto', { host: config.HOST, port: config.PORT, oauthEnabled: config.oauthEnabled });
      } catch (error) {
        await nextApi.close().catch(() => undefined);
        throw error;
      }
    });
    await siteLifecycle;
  };
  const stopSite = async (duringApplicationShutdown = false): Promise<void> => {
    siteLifecycle = siteLifecycle.catch(() => undefined).then(async () => {
      const closing = api;
      if (!closing) return;
      api = null;
      await closing.close();
      if (!duringApplicationShutdown) logger.info('Sito e API arrestati; bot Discord e pianificatore restano attivi');
    });
    await siteLifecycle;
  };
  await startSite();

  if (config.BOT_TOKEN) {
    client.login(config.BOT_TOKEN).catch(() => logger.error('Accesso del bot a Discord non riuscito; controlla il token e gli intent del portale.'));
  } else {
    logger.warn('BOT_TOKEN non configurato: il backend REST è avviato, le funzioni Discord non sono disponibili.');
  }
  if (!config.oauthEnabled) logger.warn('OAuth2 non configurato: tutte le API amministrative sono disabilitate fino alla configurazione dei segreti.');

  let shutdownPromise: Promise<void> | null = null;
  let clientDestroyed = false;
  const shutdown = (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      logger.info('Arresto controllato avviato', { timeoutMs: config.SHUTDOWN_TIMEOUT_MS });
      operations.stopAccepting();
      scheduler.stop();
      const apiClose = stopSite(true).catch((error: unknown) => { logger.warn('Chiusura HTTP in attesa di completamento', { name: error instanceof Error ? error.name : 'UnknownError' }); });
      const [apiDrained, interactionsDrained, schedulerDrained] = await Promise.all([
        completesWithin(apiClose, config.SHUTDOWN_TIMEOUT_MS),
        operations.waitForIdle(config.SHUTDOWN_TIMEOUT_MS),
        scheduler.stopAndDrain(config.SHUTDOWN_TIMEOUT_MS),
      ]);
      if (!apiDrained || !interactionsDrained || !schedulerDrained) {
        const pendingPanels = (db.prepare(`SELECT COUNT(*) AS amount FROM ticket_operations WHERE status IN ('in_progress','recovery_needed')`).get() as { amount: number }).amount;
        const pendingTickets = (db.prepare(`SELECT COUNT(*) AS amount FROM tickets WHERE status IN ('creating','closing')`).get() as { amount: number }).amount;
        const pendingTasks = (db.prepare(`SELECT COUNT(*) AS amount FROM scheduled_tasks WHERE status = 'running'`).get() as { amount: number }).amount;
        logger.warn('Arresto oltre il limite configurato: lo stato incompleto resta nel database; attendo che i componenti terminino prima di chiuderlo.', { pendingPanels, pendingTickets, pendingTasks });
        client.destroy();
        clientDestroyed = true;
        await Promise.all([apiClose, operations.whenIdle(), scheduler.whenIdle()]);
      }
      if (!clientDestroyed) client.destroy();
      if (db.open) db.close();
      terminal?.close();
      logger.info('Applicazione arrestata in modo ordinato');
    })();
    return shutdownPromise;
  };
  process.on('SIGINT', () => { void shutdown(); });
  process.on('SIGTERM', () => { void shutdown(); });
  if (process.platform === 'win32') process.on('SIGBREAK', () => { void shutdown(); });
  else {
    process.on('SIGUSR2', () => { void stopSite().catch(() => logger.warn('Arresto del solo sito non completato')); });
  }
  if (process.stdin.isTTY) {
    const readline = createInterface({ input: process.stdin, output: process.stdout });
    terminal = readline;
    readline.setPrompt('guardian> ');
    readline.prompt();
    readline.on('line', (line) => {
      const command = line.trim().toLowerCase();
      if (command === 'sito stop') void stopSite().catch(() => logger.warn('Arresto del solo sito non completato'));
      else if (command === 'sito avvia') void startSite().catch(() => logger.warn('Avvio del sito non completato'));
      else if (command === 'app stop') void shutdown();
      else if (command === 'aiuto') logger.info('Comandi terminale: sito stop, sito avvia, app stop. Ctrl+C arresta l’intera applicazione.');
      else logger.warn('Comando non riconosciuto. Digita aiuto per i comandi terminale disponibili.');
      if (!shutdownPromise) readline.prompt();
    });
  }
  process.on('unhandledRejection', () => logger.error('Operazione asincrona non completata'));
}

async function completesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (completed: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(completed);
    };
    const timeout = setTimeout(() => finish(false), timeoutMs);
    timeout.unref();
    void promise.then(() => finish(true), () => finish(true));
  });
}

void main().catch((error: unknown) => {
  console.error(JSON.stringify({ livello: 'error', message: 'Avvio del servizio non riuscito', name: error instanceof Error ? error.name : 'UnknownError' }));
  process.exitCode = 1;
});
