import {
  AutoModerationActionType, AutoModerationRuleEventType, AutoModerationRuleTriggerType,
  AuditLogEvent, ChannelType, EmbedBuilder, PermissionFlagsBits, type Client, type Guild, type GuildMember,
  type Message, type TextChannel,
} from 'discord.js';
import type { DatabaseHandle } from '../db.js';
import { audit } from '../db.js';
import { isBlockedDomain, mentionsBlockedInvite, extractUrls, normalizeDomain } from '../security.js';
import { NotFoundError } from '../errors.js';
import type { GuildSettings } from '../settings.js';
import type { LockdownService } from './lockdown-service.js';

interface MessageStamp { at: number; contentHash: string; }
const DISCORD_EPOCH = 1420070400000n;

export class SafetyService {
  private readonly recentMessages = new Map<string, MessageStamp[]>();
  private readonly recentJoins = new Map<string, number[]>();
  private readonly lastJoinAlert = new Map<string, number>();

  constructor(private readonly db: DatabaseHandle, private readonly client: Client, private readonly lockdown: LockdownService) {}

  async handleMessage(message: Message): Promise<void> {
    if (!message.guild || message.author.bot || !message.member) return;
    const settings = this.settings(message.guild.id);
    if (!settings.modules.security || this.lockdown.areAutomationsStopped(message.guild.id)) return;
    const config = settings.security;
    if (config.excludedChannelIds.includes(message.channelId) || this.isExempt(message.member, settings)) return;
    const now = Date.now();
    const signals: string[] = [];
    const urls = extractUrls(message.content);
    if (urls.some((url) => isBlockedDomain(url.hostname, config.blockedDomains, config.allowedDomains))) signals.push('dominio_bloccato');
    if (!config.allowInvites && mentionsBlockedInvite(message.content)) signals.push('invito_non_consentito');
    if (message.mentions.users.size + message.mentions.roles.size > config.mentionLimit || message.mentions.everyone) signals.push('menzioni_eccessive');
    const bucketKey = `${message.guild.id}:${message.author.id}`;
    const cutoff = now - config.duplicateWindowSeconds * 1000;
    const bucket = (this.recentMessages.get(bucketKey) ?? []).filter((entry) => entry.at >= cutoff);
    const normalized = message.content.trim().toLowerCase().replace(/\s+/g, ' ');
    if (normalized.length > 0) {
      const digest = `${normalized.length}:${normalized.slice(0, 400)}`;
      bucket.push({ at: now, contentHash: digest });
      if (bucket.filter((entry) => entry.contentHash === digest).length >= config.duplicateMessageLimit) signals.push('messaggi_ripetuti');
      if (bucket.length >= config.duplicateMessageLimit + 2) signals.push('frequenza_messaggi');
    }
    this.recentMessages.set(bucketKey, bucket.slice(-30));
    const uniqueSignals = [...new Set(signals)];
    if (!uniqueSignals.length) return;
    const enforce = config.mode === 'enforce' && config.automatedActionsEnabled;
    let action = 'nessuna_azione';
    if (enforce && uniqueSignals.some((signal) => ['dominio_bloccato', 'invito_non_consentito', 'menzioni_eccessive', 'messaggi_ripetuti', 'frequenza_messaggi'].includes(signal))) {
      const canDelete = message.channel.isTextBased() && 'permissionsFor' in message.channel && Boolean((message.channel as TextChannel).permissionsFor(this.client.user!.id)?.has(PermissionFlagsBits.ManageMessages));
      if (canDelete) {
        try { await message.delete(); action = 'messaggio_eliminato'; } catch { action = 'eliminazione_non_riuscita'; }
      } else action = 'permesso_cancellazione_mancante';
    }
    audit(this.db, { guildId: message.guild.id, actorId: 'system', action: 'security.detect', targetType: 'user', targetId: message.author.id, result: action === 'eliminazione_non_riuscita' ? 'failed' : 'ok', after: { signals: uniqueSignals, action, channelId: message.channelId, autoActionsEnabled: enforce } });
    if (config.mode !== 'observe') await this.sendAlert(message.guild, settings, uniqueSignals, message.author.id, action);
  }

  async handleMemberJoin(member: GuildMember): Promise<void> {
    const settings = this.settings(member.guild.id);
    if (!settings.modules.security || this.lockdown.areAutomationsStopped(member.guild.id)) return;
    const now = Date.now();
    const windowMs = settings.security.joinSpikeWindowSeconds * 1000;
    const joins = (this.recentJoins.get(member.guild.id) ?? []).filter((timestamp) => timestamp >= now - windowMs);
    joins.push(now);
    this.recentJoins.set(member.guild.id, joins);
    const ageMs = Math.max(0, now - Number((BigInt(member.id) >> 22n) + DISCORD_EPOCH));
    const ageDays = Math.floor(ageMs / 86_400_000);
    const recentAccount = ageDays < settings.security.newAccountDays;
    const spike = joins.length >= settings.security.joinSpikeCount;
    const signals = [spike ? 'picco_ingressi' : '', recentAccount ? 'account_recente_segnale' : ''].filter(Boolean);
    if (!signals.length) return;
    audit(this.db, { guildId: member.guild.id, actorId: 'system', action: 'security.join.detect', targetType: 'user', targetId: member.id, result: 'ok', after: { signals, accountAgeDays: ageDays, joinCountInWindow: joins.length, windowSeconds: settings.security.joinSpikeWindowSeconds, action: 'nessuna_sanzione_automatica' } });
    if (settings.security.mode !== 'observe') await this.sendAlert(member.guild, settings, signals, member.id, 'osservazione');
    if (spike && settings.security.mode === 'enforce' && settings.security.automatedActionsEnabled) {
      const lastAlert = this.lastJoinAlert.get(member.guild.id) ?? 0;
      if (now - lastAlert > windowMs) {
        this.lastJoinAlert.set(member.guild.id, now);
        // Non vengono bannati utenti né applicate azioni collettive sulla base dell’età degli account.
      }
    }
  }

  async syncAutoMod(guildId: string, settings = this.settings(guildId)): Promise<{ enabled: boolean; ruleId?: string; message?: string }> {
    const guild = await this.getGuild(guildId);
    const stored = this.db.prepare('SELECT rule_id FROM native_automod_rules WHERE guild_id = ?').get(guildId) as { rule_id: string } | undefined;
    let rule = stored ? await guild.autoModerationRules.fetch(stored.rule_id).catch(() => null) : null;
    if (!settings.security.automod.enabled || settings.security.automod.blockedWords.length === 0 || !settings.modules.security) {
      if (rule?.enabled) await rule.edit({ enabled: false, reason: 'Impostazioni del server aggiornate' });
      return { enabled: false, ...(rule ? { ruleId: rule.id } : {}) };
    }
    if (settings.security.mode === 'observe' || !settings.security.automatedActionsEnabled) {
      // AutoMod blocca nativamente i messaggi, quindi non deve attivarsi in modalità osservazione.
      if (rule?.enabled) await rule.edit({ enabled: false, reason: 'Le azioni automatiche non sono abilitate' });
      return { enabled: false, ...(rule ? { ruleId: rule.id } : {}), message: 'Per attivare AutoMod imposta la modalità enforce e abilita esplicitamente le azioni automatiche.' };
    }
    const bot = await guild.members.fetch(this.client.user!.id).catch(() => null);
    if (!bot?.permissions.has(PermissionFlagsBits.ManageGuild)) throw new Error('Al bot manca Gestisci server per configurare AutoMod nativo.');
    const options = {
      name: 'The Last Pact Guardian · parole bloccate',
      enabled: true,
      eventType: AutoModerationRuleEventType.MessageSend,
      triggerType: AutoModerationRuleTriggerType.Keyword,
      triggerMetadata: {
        keywordFilter: settings.security.automod.blockedWords.map((word) => word.trim()).filter(Boolean),
        allowList: [],
      },
      actions: [{ type: AutoModerationActionType.BlockMessage }],
      exemptChannels: settings.security.excludedChannelIds,
      exemptRoles: settings.security.excludedRoleIds,
      reason: 'Regole AutoMod sincronizzate dalla configurazione del bot',
    } as const;
    if (rule) rule = await rule.edit(options);
    else {
      rule = await guild.autoModerationRules.create(options);
      this.db.prepare(`INSERT INTO native_automod_rules(guild_id, rule_id, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(guild_id) DO UPDATE SET rule_id = excluded.rule_id, updated_at = excluded.updated_at`)
        .run(guildId, rule.id, new Date().toISOString());
    }
    return { enabled: true, ruleId: rule.id };
  }

  async observeAuditChange(guildId: string, targetId: string, actionName: string, executorId?: string | null, happenedAt?: number, auditAction?: AuditLogEvent): Promise<void> {
    const guild = await this.getGuild(guildId);
    const recent = happenedAt !== undefined && Date.now() - happenedAt <= 120_000;
    let actor = executorId ?? null;
    let result: 'ok' | 'uncertain' = actor && recent ? 'ok' : 'uncertain';
    if (!actor || !recent) {
      try {
        const logs = await guild.fetchAuditLogs({ limit: 10, ...(auditAction ? { type: auditAction } : {}) });
        const matches = [...logs.entries.values()].filter((entry) => entry.targetId === targetId && (!auditAction || entry.action === auditAction) && Date.now() - entry.createdTimestamp <= 120_000);
        if (matches.length === 1 && matches[0]?.executorId) { actor = matches[0].executorId; result = 'ok'; }
        else { actor = null; result = 'uncertain'; }
      } catch { actor = null; result = 'uncertain'; }
    }
    audit(this.db, { guildId, actorId: actor ?? 'unknown', action: `security.audit.${actionName}`, targetType: actionName, targetId, result, after: { attribution: result === 'ok' ? 'audit_log' : 'incerta o non disponibile' } });
    const settings = this.settings(guildId);
    if (settings.security.mode !== 'observe') await this.sendAlert(guild, settings, [result === 'ok' ? `modifica_${actionName}` : `modifica_${actionName}_attribuzione_incerta`], targetId, actor ?? 'attribuzione incerta');
  }

  private isExempt(member: GuildMember, settings: GuildSettings): boolean {
    return settings.security.excludedUserIds.includes(member.id) || member.roles.cache.some((role) => settings.security.excludedRoleIds.includes(role.id));
  }

  private async sendAlert(guild: Guild, settings: GuildSettings, signals: string[], targetId: string, action: string): Promise<void> {
    const channelId = settings.channels.securityAlerts;
    if (!channelId) return;
    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (!channel || channel.guildId !== guild.id || channel.type !== ChannelType.GuildText) return;
    const bot = this.client.user;
    if (!bot || !channel.permissionsFor(bot.id)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) return;
    if (channel.permissionsFor(guild.roles.everyone)?.has(PermissionFlagsBits.ViewChannel)) return;
    const staffRoles = [...new Set([...settings.permissions.roles.moderate, ...settings.permissions.roles.configure])];
    if (!staffRoles.length || staffRoles.some((id) => !channel.permissionsFor(id)?.has(PermissionFlagsBits.ViewChannel))) return;
    const embed = new EmbedBuilder().setColor(Number.parseInt(settings.general.color.slice(1), 16)).setAuthor({ name: settings.general.name }).setTitle('Avviso di sicurezza')
      .setDescription(`Segnale: **${signals.join(', ')}**\nUtente o risorsa: **${targetId}**\nEsito: **${action}**`)
      .setFooter({ text: 'Il rilevamento è indicativo; non prova un abuso o una compromissione.' });
    await (channel as TextChannel).send({ embeds: [embed], allowedMentions: { parse: [] } }).catch(() => undefined);
  }

  private async getGuild(guildId: string): Promise<Guild> {
    const guild = await this.client.guilds.fetch(guildId).catch(() => null);
    if (!guild) throw new NotFoundError('Il bot non è presente in questo server.');
    return guild;
  }

  private settings(guildId: string): GuildSettings {
    const row = this.db.prepare('SELECT settings_json FROM guild_settings WHERE guild_id = ?').get(guildId) as { settings_json: string } | undefined;
    if (!row) throw new NotFoundError('Configurazione del server non trovata.');
    return JSON.parse(row.settings_json) as GuildSettings;
  }
}
