import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, MessageFlags,
  ModalBuilder, PermissionFlagsBits, TextInputBuilder, TextInputStyle,
  type ButtonInteraction, type ChatInputCommandInteraction, type Client, type Interaction, type MessageContextMenuCommandInteraction,
} from 'discord.js';
import type { DatabaseHandle } from '../db.js';
import { AppError, AuthorizationError } from '../errors.js';
import type { GuildSettings } from '../settings.js';
import type { TicketService } from '../services/ticket-service.js';
import type { ReportService } from '../services/report-service.js';
import type { ModerationService } from '../services/moderation-service.js';
import type { AnnouncementInput, AnnouncementService } from '../services/announcement-service.js';
import type { LockdownService } from '../services/lockdown-service.js';
import type { OperationCoordinator } from '../services/operation-coordinator.js';
import type { Logger } from '../index.js';

export interface BotInteractionServices {
  db: DatabaseHandle;
  client: Client;
  tickets: TicketService;
  reports: ReportService;
  moderation: ModerationService;
  announcements: AnnouncementService;
  lockdown: LockdownService;
  operations?: OperationCoordinator;
  logger: Logger;
}

export function installInteractionHandler(services: BotInteractionServices): void {
  const { db, client, tickets, reports, moderation, announcements, lockdown, operations, logger } = services;
  client.on('interactionCreate', (interaction) => {
    const handle = async () => {
    try {
      if (interaction.isChatInputCommand()) await handleChat(interaction);
      else if (interaction.isMessageContextMenuCommand()) await handleMessageContext(interaction);
      else if (interaction.isStringSelectMenu() && (interaction.customId === 'ticket:select' || interaction.customId.startsWith('ticket:select:'))) {
        const panelId = interaction.customId.split(':')[2];
        await tickets.showTicketModal(interaction, interaction.values[0] ?? '', panelId);
      }
      else if (interaction.isButton()) await handleButton(interaction);
      else if (interaction.isModalSubmit()) await handleModal(interaction);
    } catch (error) {
      logger.error('Interazione Discord non riuscita', { name: error instanceof Error ? error.name : 'UnknownError' });
      await respondError(interaction, error);
    }
    };
    void (operations ? operations.run(handle) : handle()).catch((error: unknown) => {
      logger.warn('Interazione rifiutata durante l’arresto controllato', { name: error instanceof Error ? error.name : 'UnknownError' });
      void respondError(interaction, error);
    });
  });

  async function handleChat(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.inGuild() || !interaction.guildId) throw new AppError('Questo comando è disponibile soltanto in un server.');
    const guildId = interaction.guildId;
    const actorId = interaction.user.id;
    if (interaction.commandName === 'segnala') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const category = interaction.options.getString('categoria', true);
      const target = interaction.options.getUser('utente');
      const report = await reports.create({ guildId, reporterId: actorId,
        category, description: interaction.options.getString('descrizione', true),
        ...(target ? { targetUserId: target.id } : {}),
        ...(interaction.options.getString('id_roblox') ? { robloxId: interaction.options.getString('id_roblox')! } : {}),
        ...(interaction.options.getString('prove') ? { evidence: interaction.options.getString('prove')! } : {}),
        confidential: category === 'staff' || interaction.options.getBoolean('riservata') === true,
      });
      await interaction.editReply(`Segnalazione inviata in forma privata. Codice: **${report.id}**.`);
      return;
    }
    if (interaction.commandName === 'ticket') {
      const ticket = tickets.findByChannel(guildId, interaction.channelId);
      const sub = interaction.options.getSubcommand();
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      if (sub === 'assegna') {
        await tickets.assign(guildId, ticket.id, actorId);
        await interaction.editReply(`Hai preso in carico il ticket ${ticket.id}.`);
      } else if (sub === 'aggiungi' || sub === 'rimuovi') {
        const target = interaction.options.getUser('utente', true);
        await tickets.addParticipant(guildId, ticket.id, actorId, target.id, sub === 'rimuovi');
        await interaction.editReply(sub === 'aggiungi' ? 'Partecipante aggiunto.' : 'Partecipante rimosso.');
      } else if (sub === 'chiudi') {
        const closed = await tickets.close(guildId, ticket.id, actorId, interaction.options.getString('motivo', true));
        await interaction.editReply(`Ticket ${closed.id} chiuso. La trascrizione privata è disponibile agli autorizzati tramite API.`);
      }
      return;
    }
    if (interaction.commandName === 'moderazione') {
      const sub = interaction.options.getSubcommand();
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      if (sub === 'avverti') {
        const result = await moderation.warn(guildId, actorId, interaction.options.getUser('utente', true).id, interaction.options.getString('motivo', true));
        await interaction.editReply(`Avvertimento registrato nel caso **#${result.case.caseNumber}**. Avvertimenti attivi: ${result.warningCount}.`);
      } else if (sub === 'avvertimenti') {
        const targetId = interaction.options.getUser('utente', true).id;
        const warnings = moderation.warnings(guildId, targetId);
        const lines = warnings.length ? warnings.slice(0, 20).map((warning) => `#${warning.caseNumber} · ${warning.revokedAt ? 'revocato' : 'attivo'} · ${warning.reason}`).join('\n') : 'Nessun avvertimento registrato.';
        await interaction.editReply(`Avvertimenti per ${targetId}:\n${safeText(lines).slice(0, 1900)}`);
      } else if (sub === 'revoca-avvertimento') {
        const row = await moderation.revokeWarning(guildId, actorId, interaction.options.getInteger('caso', true), interaction.options.getString('motivo', true));
        await interaction.editReply(`Avvertimento revocato. La revoca è registrata nel caso **#${row.caseNumber}**.`);
      } else if (sub === 'timeout') {
        const result = await moderation.timeout(guildId, actorId, interaction.options.getUser('utente', true).id, interaction.options.getInteger('minuti', true), interaction.options.getString('motivo', true));
        await interaction.editReply(`Timeout applicato. Caso **#${result.case.caseNumber}**.`);
      } else if (sub === 'rimuovi-timeout') {
        const row = await moderation.removeTimeout(guildId, actorId, interaction.options.getUser('utente', true).id, interaction.options.getString('motivo', true));
        await interaction.editReply(`Timeout rimosso. Caso **#${row.caseNumber}**.`);
      } else if (sub === 'espelli') {
        const result = await moderation.kick(guildId, actorId, interaction.options.getUser('utente', true).id, interaction.options.getString('motivo', true));
        await interaction.editReply(`Utente espulso. Caso **#${result.case.caseNumber}**.`);
      } else if (sub === 'ban') {
        const target = interaction.options.getUser('utente', true);
        const reason = interaction.options.getString('motivo', true);
        const confirmation = await moderation.requestBan(guildId, actorId, target.id, reason);
        await interaction.editReply({ content: `Conferma il ban di **${safeText(target.tag)}**. Motivo: ${safeText(reason)}. La conferma scade tra cinque minuti.`, components: [confirmationButtons(confirmation.confirmationId)] });
      } else if (sub === 'sban') {
        const row = await moderation.unban(guildId, actorId, interaction.options.getString('id_utente', true), interaction.options.getString('motivo', true));
        await interaction.editReply(`Ban rimosso. Caso **#${row.caseNumber}**.`);
      } else if (sub === 'pulisci') {
        if (interaction.channel?.type !== ChannelType.GuildText) throw new AppError('Usa questo comando in un canale testuale del server.');
        const confirmation = await moderation.requestPurge(guildId, actorId, interaction.channelId, interaction.options.getInteger('quantita', true));
        await interaction.editReply({ content: `Stai per eliminare fino a ${interaction.options.getInteger('quantita', true)} messaggi recenti in questo canale. Confermi? La conferma scade tra cinque minuti.`, components: [confirmationButtons(confirmation.confirmationId)] });
      } else if (sub === 'slowmode') {
        if (interaction.channel?.type !== ChannelType.GuildText) throw new AppError('Usa questo comando in un canale testuale del server.');
        const row = await moderation.slowmode(guildId, actorId, interaction.channelId, interaction.options.getInteger('secondi', true), interaction.options.getString('motivo', true));
        await interaction.editReply(`Slowmode aggiornato. Caso **#${row.caseNumber}**.`);
      } else if (sub === 'blocca-canale') {
        if (interaction.channel?.type !== ChannelType.GuildText) throw new AppError('Usa questo comando in un canale testuale del server.');
        await lockdown.lockChannel(guildId, actorId, interaction.channelId, interaction.options.getString('motivo', true));
        await interaction.editReply('Canale bloccato. Il ripristino modificherà i permessi soltanto se non sono stati cambiati manualmente.');
      } else if (sub === 'sblocca-canale') {
        if (interaction.channel?.type !== ChannelType.GuildText) throw new AppError('Usa questo comando in un canale testuale del server.');
        const result = await lockdown.unlockChannel(guildId, actorId, interaction.channelId, interaction.options.getString('motivo', true));
        await interaction.editReply(result.skipped ? 'Ripristino saltato perché i permessi sono cambiati manualmente o il canale non esiste più.' : 'Canale sbloccato e permessi precedenti ripristinati.');
      } else if (sub === 'casi') {
        const targetId = interaction.options.getUser('utente')?.id;
        const cases = await moderation.listCases(guildId, { ...(targetId ? { targetId } : {}), limit: 15 });
        const lines = cases.length ? cases.map((item) => `#${item.caseNumber} · ${item.action} · ${item.targetId} · ${item.result} · ${item.reason}`).join('\n') : 'Nessun caso trovato.';
        await interaction.editReply(safeText(lines).slice(0, 1950));
      }
      return;
    }
    if (interaction.commandName === 'lockdown') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const duration = interaction.options.getInteger('minuti') ?? undefined;
      const confirmation = await lockdown.requestActivation(guildId, actorId, duration);
      await interaction.editReply({ content: `Il lockdown bloccherà l’invio nei canali testuali configurati.${duration ? ` Ripristino automatico tra ${duration} minuti.` : ' Il ripristino dovrà essere avviato dallo staff.'} Confermi?`, components: [confirmationButtons(confirmation.confirmationId)] });
      return;
    }
    if (interaction.commandName === 'lockdown-ripristina') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const result = await lockdown.restore(guildId, actorId);
      await interaction.editReply(`Ripristino completato: ${result.changed} canali ripristinati, ${result.skipped} modifiche manuali rispettate, ${result.failed} errori.`);
      return;
    }
    if (interaction.commandName === 'sicurezza-stop' || interaction.commandName === 'sicurezza-avvia') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await requireCapability(db, interaction, 'moderate');
      if (interaction.commandName === 'sicurezza-stop') {
        lockdown.stopAutomations(guildId, actorId);
        await interaction.editReply('Le automazioni di sicurezza sono state arrestate. I controlli in modalità osservazione continuano a registrare gli eventi.');
      } else {
        lockdown.startAutomations(guildId, actorId);
        await interaction.editReply('Le automazioni di sicurezza sono state riabilitate secondo le impostazioni correnti.');
      }
      return;
    }
    if (interaction.commandName === 'annuncio') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await requireCapability(db, interaction, 'configure');
      const role = interaction.options.getRole('menzione_ruolo');
      const rawDate = interaction.options.getString('data');
      let runAt: string | undefined;
      if (rawDate) {
        const date = new Date(rawDate);
        if (Number.isNaN(date.getTime())) throw new AppError('La data deve essere una data ISO 8601 valida.');
        runAt = date.toISOString();
      }
      const input: AnnouncementInput = {
        type: interaction.options.getString('tipo', true) as AnnouncementInput['type'],
        title: interaction.options.getString('titolo', true),
        content: interaction.options.getString('testo', true),
        ...(role ? { roleIds: [role.id] } : {}),
        ...(runAt ? { runAt } : {}),
      };
      const preview = await announcements.preview(guildId, input);
      const confirmation = await announcements.requestConfirmation(guildId, actorId, input);
      await interaction.editReply({
        content: input.runAt ? `Anteprima dell’annuncio programmato per <t:${Math.floor(new Date(input.runAt).getTime() / 1000)}:F>. Confermi?` : 'Anteprima dell’annuncio. Confermi la pubblicazione?',
        embeds: [preview.embed], components: [confirmationButtons(confirmation.confirmationId)] });
      return;
    }
  }

  async function handleMessageContext(interaction: MessageContextMenuCommandInteraction): Promise<void> {
    if (!interaction.guildId || !interaction.inGuild()) throw new AppError('Le segnalazioni sono disponibili soltanto in un server.');
    const message = interaction.targetMessage;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const report = await reports.create({ guildId: interaction.guildId, reporterId: interaction.user.id,
      targetUserId: message.author.id, category: 'messaggio',
      description: `Segnalazione del messaggio ${message.id} nel canale ${message.channelId}.`,
      evidence: [message.content.slice(0, 1200), ...message.attachments.map((file) => `[allegato omesso: ${file.name}]`)].filter(Boolean).join('\n').slice(0, 1500),
      sourceMessageId: message.id,
    });
    await interaction.editReply(`Segnalazione del messaggio inviata in forma privata. Codice: **${report.id}**.`);
  }

  async function handleButton(interaction: ButtonInteraction): Promise<void> {
    if (interaction.customId.startsWith('confirm:yes:') || interaction.customId.startsWith('confirm:no:')) {
      if (!interaction.guildId) throw new AppError('La conferma è valida soltanto nel server in cui è stata richiesta.');
      const [prefix, decision, confirmationId] = interaction.customId.split(':');
      if (prefix !== 'confirm' || !confirmationId) throw new AppError('Conferma non valida.');
      const row = db.prepare('SELECT action_json FROM confirmations WHERE guild_id = ? AND id = ? AND actor_id = ?')
        .get(interaction.guildId, confirmationId, interaction.user.id) as { action_json: string } | undefined;
      if (!row) throw new AuthorizationError('Questa conferma appartiene a un altro operatore o è scaduta.');
      const action = JSON.parse(row.action_json) as { type?: string };
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      if (decision === 'no') {
        if (action.type === 'announcement') announcements.cancelConfirmation(interaction.guildId, interaction.user.id, confirmationId);
        else if (action.type === 'lockdown') lockdown.cancelConfirmation(interaction.guildId, interaction.user.id, confirmationId);
        else moderation.cancelConfirmation(interaction.guildId, interaction.user.id, confirmationId);
        await interaction.editReply('Operazione annullata.');
        await interaction.message.edit({ components: [] }).catch(() => undefined);
        return;
      }
      if (action.type === 'announcement') {
        const result = await announcements.confirm(interaction.guildId, interaction.user.id, confirmationId);
        await interaction.editReply(result.scheduled ? `Annuncio programmato. Codice: **${result.task?.id}**.` : 'Annuncio pubblicato.');
      } else if (action.type === 'lockdown') {
        const result = await lockdown.confirmActivation(interaction.guildId, interaction.user.id, confirmationId);
        await interaction.editReply(`Lockdown avviato: ${result.changed} canali bloccati, ${result.skipped} già protetti, ${result.failed} non modificati.${result.scheduledTaskId ? ` Ripristino programmato: ${result.scheduledTaskId}.` : ''}`);
      } else {
        const result = await moderation.confirm(interaction.guildId, interaction.user.id, confirmationId);
        await interaction.editReply(`Operazione completata nel caso **#${result.caseNumber}**.`);
      }
      await interaction.message.edit({ components: [] }).catch(() => undefined);
      return;
    }

    if (!interaction.guildId) throw new AppError('Il pulsante è valido soltanto in un server.');
    const [prefix, action, id] = interaction.customId.split(':');
    if (!id) throw new AppError('Pulsante non valido o scaduto.');
    if (prefix === 'ticket') {
      if (action === 'type') {
        const categoryKey = interaction.customId.split(':')[3];
        if (!categoryKey) throw new AppError('Tipologia ticket non valida.');
        await tickets.showTicketModal(interaction, categoryKey, id);
        return;
      }
      const ticket = tickets.get(interaction.guildId, id);
      if (ticket.channelId !== interaction.channelId) throw new AuthorizationError('Questo pulsante non appartiene al ticket corrente.');
      if (action === 'close') {
        const modal = new ModalBuilder().setCustomId(`ticket:close-submit:${id}`).setTitle('Chiudi ticket');
        modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('reason').setLabel('Motivo della chiusura').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(500)));
        await interaction.showModal(modal);
      } else if (action === 'assign') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const assigned = await tickets.assign(interaction.guildId, id, interaction.user.id);
        await interaction.editReply(`Ticket ${assigned.id} preso in carico.`);
      }
      return;
    }
    if (prefix === 'report') {
      const report = reports.get(interaction.guildId, id);
      const settings = getSettings(db, interaction.guildId);
      const expectedChannel = report.confidential ? settings.channels.confidentialReports : settings.channels.reports;
      if (expectedChannel !== interaction.channelId) throw new AuthorizationError('Questa segnalazione non appartiene al canale corrente.');
      const capability = report.confidential ? 'confidentialReportStaff' : 'reportStaff';
      if (action === 'assign') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        if (!await reports.hasStaffRole(interaction.guildId, interaction.user.id, capability)) throw new AuthorizationError('Il tuo ruolo non può gestire questa segnalazione.');
        await reports.transition(interaction.guildId, id, interaction.user.id, 'assigned');
        await interaction.editReply(`Segnalazione ${id} assegnata a te.`);
      } else if (action === 'info' || action === 'accept' || action === 'reject') {
        const title = action === 'info' ? 'Richiedi informazioni' : action === 'accept' ? 'Accetta segnalazione' : 'Respingi segnalazione';
        const modal = new ModalBuilder().setCustomId(`report:decision:${action}:${id}`).setTitle(title);
        modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('reason').setLabel(action === 'info' ? 'Quali informazioni servono?' : 'Motivazione').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1000)));
        await interaction.showModal(modal);
      }
      return;
    }
  }

  async function handleModal(interaction: Interaction): Promise<void> {
    if (!interaction.isModalSubmit() || !interaction.guildId) throw new AppError('Il modulo è scaduto o non è valido per questo server.');
    const parts = interaction.customId.split(':');
    if (parts[0] === 'ticket' && parts[1] === 'submit') {
      const managedPanel = parts[2] === 'p';
      const panelId = managedPanel ? parts[3] : undefined;
      const panelMessageId = managedPanel ? undefined : parts[2];
      const categoryKey = managedPanel ? parts[4] : parts[3];
      if ((!panelId && !panelMessageId) || !categoryKey) throw new AppError('Il pannello ticket non è più valido.');
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const fields = Object.fromEntries([...interaction.fields.fields].map(([key, field]) => [key, 'value' in field && typeof field.value === 'string' ? field.value : '']));
      const ticket = await tickets.openFromModal({ guildId: interaction.guildId, userId: interaction.user.id, ...(panelId ? { panelId } : {}), ...(panelMessageId ? { panelMessageId } : {}), interactionId: interaction.id, categoryKey, fields });
      await interaction.editReply(`Ticket aperto: <#${ticket.channelId}>. Il canale è visibile soltanto a te e allo staff autorizzato.`);
      return;
    }    if (parts[0] === 'ticket' && parts[1] === 'close-submit') {
      const ticketId = parts[2];
      if (!ticketId) throw new AppError('Ticket non valido.');
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const ticket = await tickets.close(interaction.guildId, ticketId, interaction.user.id, interaction.fields.getTextInputValue('reason'));
      await interaction.editReply(`Ticket ${ticket.id} chiuso. La trascrizione è archiviata privatamente.`);
      return;
    }
    if (parts[0] === 'report' && parts[1] === 'decision') {
      const decision = parts[2]; const reportId = parts[3];
      if (!reportId || !['info', 'accept', 'reject'].includes(decision ?? '')) throw new AppError('Modulo segnalazione non valido.');
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const report = reports.get(interaction.guildId, reportId);
      const capability = report.confidential ? 'confidentialReportStaff' : 'reportStaff';
      if (!await reports.hasStaffRole(interaction.guildId, interaction.user.id, capability)) throw new AuthorizationError();
      const reason = interaction.fields.getTextInputValue('reason');
      const status = decision === 'info' ? 'info_requested' : decision === 'accept' ? 'accepted' : 'rejected';
      await reports.transition(interaction.guildId, reportId, interaction.user.id, status, reason);
      await interaction.editReply(`Stato della segnalazione ${reportId} aggiornato.`);
      return;
    }
  }
}

function getSettings(db: DatabaseHandle, guildId: string): GuildSettings {
  const row = db.prepare('SELECT settings_json FROM guild_settings WHERE guild_id = ?').get(guildId) as { settings_json: string } | undefined;
  if (!row) throw new AppError('La configurazione del server non è stata inizializzata.', 404);
  return JSON.parse(row.settings_json) as GuildSettings;
}

async function requireCapability(db: DatabaseHandle, interaction: ChatInputCommandInteraction, capability: 'moderate' | 'configure'): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId || !interaction.guild) throw new AppError('Questo comando è disponibile soltanto in un server.');
  const settings = getSettings(db, guildId);
  const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
  if (!member) throw new AuthorizationError();
  const allowedRoles = settings.permissions.roles[capability];
  if (member.id !== interaction.guild.ownerId && !member.permissions.has(PermissionFlagsBits.ManageGuild) && !member.roles.cache.some((role) => allowedRoles.includes(role.id))) {
    throw new AuthorizationError(capability === 'configure' ? 'Serve Gestisci server o un ruolo di configurazione autorizzato.' : 'Il tuo ruolo non è autorizzato alla moderazione.');
  }
}

function confirmationButtons(id: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`confirm:yes:${id}`).setLabel('Conferma').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`confirm:no:${id}`).setLabel('Annulla').setStyle(ButtonStyle.Secondary),
  );
}

function safeText(value: string): string { return value.replace(/@/g, '@\u200b').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim(); }

async function respondError(interaction: Interaction, error: unknown): Promise<void> {
  const message = error instanceof AppError ? error.message : 'Operazione non riuscita. Verifica permessi e configurazione, poi riprova.';
  const payload = { content: safeText(message).slice(0, 1900), flags: MessageFlags.Ephemeral as const };
  try {
    if (interaction.isRepliable()) {
      if (interaction.deferred || interaction.replied) await interaction.followUp(payload);
      else await interaction.reply(payload);
    }
  } catch { /* L’interazione è scaduta: i dettagli non vengono inviati in un canale pubblico. */ }
}
