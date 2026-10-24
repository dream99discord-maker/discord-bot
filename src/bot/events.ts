import { AuditLogEvent, ChannelType, EmbedBuilder, Events, PermissionFlagsBits, type Client, type GuildMember, type TextChannel } from 'discord.js';
import type { DatabaseHandle } from '../db.js';
import type { SafetyService } from '../services/safety-service.js';
import type { GuildSettings } from '../settings.js';
import type { OperationCoordinator } from '../services/operation-coordinator.js';
import type { Logger } from '../index.js';

export function installGatewayEvents(client: Client, db: DatabaseHandle, safety: SafetyService, logger: Logger, operations?: OperationCoordinator): void {
  const run = (job: () => Promise<unknown>, failed: () => void) => {
    if (operations && !operations.isAccepting) return;
    void (operations ? operations.run(job) : job()).catch(failed);
  };
  client.on(Events.MessageCreate, (message) => { run(() => safety.handleMessage(message), () => logger.warn('Controllo di sicurezza messaggio non riuscito')); });
  client.on(Events.GuildMemberAdd, (member) => {
    run(async () => Promise.allSettled([safety.handleMemberJoin(member), welcome(member, db)]).then((results) => {
      if (results.some((result) => result.status === 'rejected')) logger.warn('Evento nuovo membro gestito con avvisi');
    }), () => undefined);
  });
  client.on(Events.GuildAuditLogEntryCreate, (entry, guild) => {
    const monitored = new Map<AuditLogEvent, string>([
      [AuditLogEvent.ChannelCreate, 'canale'], [AuditLogEvent.ChannelUpdate, 'canale'], [AuditLogEvent.ChannelDelete, 'canale'],
      [AuditLogEvent.ChannelOverwriteCreate, 'permessi-canale'],
      [AuditLogEvent.ChannelOverwriteUpdate, 'permessi-canale'], [AuditLogEvent.ChannelOverwriteDelete, 'permessi-canale'],
      [AuditLogEvent.RoleCreate, 'ruolo'], [AuditLogEvent.RoleUpdate, 'ruolo'], [AuditLogEvent.RoleDelete, 'ruolo'],
      [AuditLogEvent.MemberRoleUpdate, 'ruoli-membro'], [AuditLogEvent.WebhookCreate, 'webhook'],
      [AuditLogEvent.WebhookUpdate, 'webhook'], [AuditLogEvent.WebhookDelete, 'webhook'],
    ]);
    const actionName = monitored.get(entry.action);
    if (!actionName || !entry.targetId) return;
    run(() => safety.observeAuditChange(guild.id, entry.targetId!, actionName, entry.executorId, entry.createdTimestamp, entry.action),
      () => logger.warn('Attribuzione audit log non riuscita', { action: actionName }));
  });
  client.on(Events.Error, () => logger.error('Connessione Discord ha segnalato un errore di rete'));
}

async function welcome(member: GuildMember, db: DatabaseHandle): Promise<void> {
  const row = db.prepare('SELECT settings_json FROM guild_settings WHERE guild_id = ?').get(member.guild.id) as { settings_json: string } | undefined;
  if (!row) return;
  const settings = JSON.parse(row.settings_json) as GuildSettings;
  const channelId = settings.channels.welcome;
  if (!channelId) return;
  const rawChannel = await member.guild.channels.fetch(channelId).catch(() => null);
  if (!rawChannel || rawChannel.guildId !== member.guild.id || rawChannel.type !== ChannelType.GuildText) return;
  const channel = rawChannel as TextChannel;
  const bot = member.client.user;
  if (!bot || !channel.permissionsFor(bot.id)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) return;
  const safeUsername = member.user.username.replace(/@/g, '@\u200b').slice(0, 80);
  const safeServerName = member.guild.name.replace(/@/g, '@\u200b').slice(0, 100);
  const welcomeText = settings.messages.welcomeContent.replaceAll('{user}', safeUsername).replaceAll('{server}', safeServerName).replace(/@/g, '@\u200b');
  const embed = new EmbedBuilder().setColor(Number.parseInt(settings.general.color.slice(1), 16)).setAuthor({ name: settings.general.name }).setTitle(settings.messages.welcomeTitle)
    .setDescription(welcomeText.slice(0, 4000))
    .setFooter({ text: settings.general.footer });
  await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
}
