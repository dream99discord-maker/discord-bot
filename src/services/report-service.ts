import { randomBytes } from 'node:crypto';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder, PermissionFlagsBits, type Client, type Guild, type TextChannel } from 'discord.js';
import type { DatabaseHandle } from '../db.js';
import { audit } from '../db.js';
import { AppError, AuthorizationError, ConflictError, NotFoundError } from '../errors.js';
import type { PermissionCapability } from '../settings.js';
import type { GuildSettings } from '../settings.js';

export type ReportStatus = 'new' | 'assigned' | 'info_requested' | 'accepted' | 'rejected';
export interface ReportInput {
  guildId: string;
  reporterId: string;
  targetUserId?: string;
  robloxId?: string;
  category: string;
  description: string;
  evidence?: string;
  sourceMessageId?: string;
  confidential?: boolean;
}
export interface ReportView {
  id: string; guildId: string; reporterId: string; targetUserId: string | null; robloxId: string | null;
  category: string; description: string; evidence: string | null; sourceMessageId: string | null;
  confidential: boolean; status: ReportStatus; assignedTo: string | null; resolution: string | null;
  createdAt: string; updatedAt: string;
}
interface ReportRow {
  id: string; guild_id: string; reporter_id: string; target_user_id: string | null; roblox_id: string | null;
  category: string; description: string; evidence: string | null; source_message_id: string | null;
  confidential: number; status: ReportStatus; assigned_to: string | null; resolution: string | null;
  created_at: string; updated_at: string;
}
const mapReport = (row: ReportRow): ReportView => ({
  id: row.id, guildId: row.guild_id, reporterId: row.reporter_id, targetUserId: row.target_user_id,
  robloxId: row.roblox_id, category: row.category, description: row.description, evidence: row.evidence,
  sourceMessageId: row.source_message_id, confidential: row.confidential === 1, status: row.status,
  assignedTo: row.assigned_to, resolution: row.resolution, createdAt: row.created_at, updatedAt: row.updated_at,
});

export class ReportService {
  constructor(private readonly db: DatabaseHandle, private readonly client: Client) {}

  async create(input: ReportInput): Promise<ReportView> {
    const settings = this.settings(input.guildId);
    if (!settings.modules.reports) throw new AppError('Il modulo segnalazioni è disattivato.', 409, 'MODULO_DISATTIVATO');
    const description = input.description.trim();
    const category = input.category.trim();
    if (description.length < 5 || description.length > 2000) throw new AppError('La descrizione deve contenere da 5 a 2000 caratteri.');
    if (category.length < 2 || category.length > 80) throw new AppError('La categoria della segnalazione non è valida.');
    if (input.robloxId && !/^[0-9]{1,20}$/.test(input.robloxId)) throw new AppError('L’identificativo Roblox deve contenere soltanto cifre.');
    if (input.targetUserId && !/^\d{17,20}$/.test(input.targetUserId)) throw new AppError('L’ID Discord segnalato non è valido.');
    if (input.sourceMessageId && !/^\d{17,20}$/.test(input.sourceMessageId)) throw new AppError('L’ID del messaggio segnalato non è valido.');
    if (input.targetUserId && !input.sourceMessageId) {
      const guild = await this.getGuild(input.guildId);
      const target = await guild.members.fetch(input.targetUserId).catch(() => null);
      if (!target) throw new AppError('L’utente segnalato non appartiene a questo server.');
    }
    const id = `RPT-${Date.now().toString(36).toUpperCase()}-${randomBytes(3).toString('hex').toUpperCase()}`;
    const now = new Date().toISOString();
    const confidential = input.confidential === true || await this.targetIsStaff(input.guildId, input.targetUserId, settings);
    this.db.prepare(`INSERT INTO reports(id, guild_id, reporter_id, target_user_id, roblox_id, category, description, evidence, source_message_id, confidential, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?)`)
      .run(id, input.guildId, input.reporterId, input.targetUserId ?? null, input.robloxId ?? null,
        category, description, input.evidence?.slice(0, 1500) ?? null, input.sourceMessageId ?? null, confidential ? 1 : 0, now, now);
    this.addEvent(input.guildId, id, input.reporterId, 'created', JSON.stringify({ category, confidential }));
    audit(this.db, { guildId: input.guildId, actorId: input.reporterId, action: 'report.create', targetType: 'report', targetId: id, result: 'ok', after: { confidential } });
    await this.notifyStaff(input.guildId, id, settings).catch(() => {
      this.addEvent(input.guildId, id, input.reporterId, 'notification_failed', 'La segnalazione è stata registrata, ma la notifica allo staff non è stata consegnata.');
    });
    return this.get(input.guildId, id);
  }

  get(guildId: string, reportId: string): ReportView {
    const row = this.db.prepare('SELECT * FROM reports WHERE guild_id = ? AND id = ?').get(guildId, reportId) as ReportRow | undefined;
    if (!row) throw new NotFoundError('Segnalazione non trovata in questo server.');
    return mapReport(row);
  }

  list(guildId: string, options: { confidential?: boolean; status?: ReportStatus; search?: string; limit?: number; offset?: number } = {}): ReportView[] {
    const conditions = ['guild_id = ?', 'confidential = ?'];
    const values: (string | number)[] = [guildId, options.confidential ? 1 : 0];
    if (options.status) { conditions.push('status = ?'); values.push(options.status); }
    if (options.search) {
      conditions.push('(id LIKE ? OR category LIKE ? OR reporter_id LIKE ? OR target_user_id LIKE ?)');
      const search = `%${options.search.slice(0, 100)}%`;
      values.push(search, search, search, search);
    }
    values.push(Math.min(100, Math.max(1, options.limit ?? 50)), Math.max(0, Math.min(10000, options.offset ?? 0)));
    const rows = this.db.prepare(`SELECT * FROM reports WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...values) as ReportRow[];
    return rows.map(mapReport);
  }

  async transition(guildId: string, reportId: string, actorId: string, status: ReportStatus, reason?: string): Promise<ReportView> {
    const current = this.get(guildId, reportId);
    if (current.status === 'accepted' || current.status === 'rejected') throw new ConflictError('La segnalazione è già conclusa.');
    if (status === 'rejected' || status === 'accepted') {
      if (!reason || reason.trim().length < 3 || reason.trim().length > 1000) throw new AppError('Per concludere una segnalazione inserisci una motivazione da 3 a 1000 caratteri.');
    }
    const nextAssignee = status === 'assigned' || status === 'info_requested' ? actorId : current.assignedTo;
    const now = new Date().toISOString();
    const result = this.db.prepare(`UPDATE reports SET status = ?, assigned_to = ?, resolution = ?, updated_at = ? WHERE guild_id = ? AND id = ? AND status = ?`)
      .run(status, nextAssignee, reason?.trim() ?? null, now, guildId, reportId, current.status);
    if (result.changes !== 1) throw new ConflictError('Un’altra richiesta ha modificato la segnalazione.');
    this.addEvent(guildId, reportId, actorId, status, reason?.trim() ?? null);
    audit(this.db, { guildId, actorId, action: `report.${status}`, targetType: 'report', targetId: reportId, result: 'ok', before: { status: current.status }, after: { status, reason } });
    const recipient = await this.client.users.fetch(current.reporterId).catch(() => null);
    if (recipient) {
      const notice = status === 'info_requested'
        ? `Lo staff richiede altre informazioni per la segnalazione ${reportId}: ${reason?.trim() || 'rispondi a questo messaggio contattando lo staff.'}`
        : status === 'accepted'
          ? `La segnalazione ${reportId} è stata accettata. Nota dello staff: ${reason?.trim()}`
          : status === 'rejected'
            ? `La segnalazione ${reportId} è stata respinta. Motivo: ${reason?.trim()}`
            : null;
      if (notice) {
        try { await recipient.send({ content: notice, allowedMentions: { parse: [] } }); }
        catch { this.addEvent(guildId, reportId, actorId, 'dm_failed', `Il messaggio privato per lo stato ${status} non è stato consegnato.`); }
      }
    } else if (status !== 'assigned') {
      this.addEvent(guildId, reportId, actorId, 'dm_failed', `Utente non disponibile per il messaggio privato dello stato ${status}.`);
    }
    return this.get(guildId, reportId);
  }

  async canRead(guildId: string, reportId: string, userId: string): Promise<boolean> {
    const report = this.get(guildId, reportId);
    const capability: PermissionCapability = report.confidential ? 'confidentialReportStaff' : 'reportStaff';
    return this.hasStaffRole(guildId, userId, capability);
  }

  async hasStaffRole(guildId: string, userId: string, capability: PermissionCapability): Promise<boolean> {
    const settings = this.settings(guildId);
    const guild = await this.getGuild(guildId);
    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) return false;
    const ids = settings.permissions.roles[capability];
    return member.id === guild.ownerId || member.permissions.has(PermissionFlagsBits.ManageGuild) || member.roles.cache.some((role) => ids.includes(role.id));
  }

  async hasDashboardStaffRole(guildId: string, userId: string, confidential = false): Promise<boolean> {
    const settings = this.settings(guildId);
    const ids = confidential ? settings.permissions.roles.confidentialReportStaff : settings.permissions.roles.reportStaff;
    if (!ids.length) return false;
    const guild = await this.getGuild(guildId);
    const member = await guild.members.fetch(userId).catch(() => null);
    return Boolean(member && member.roles.cache.some((role) => ids.includes(role.id)));
  }

  history(guildId: string, reportId: string): Array<{ actorId: string; eventType: string; detail: string | null; createdAt: string }> {
    if (!this.db.prepare('SELECT 1 FROM reports WHERE guild_id = ? AND id = ?').get(guildId, reportId)) throw new NotFoundError('Segnalazione non trovata in questo server.');
    return this.db.prepare(`SELECT actor_id AS actorId, event_type AS eventType, detail, created_at AS createdAt
      FROM report_events WHERE guild_id = ? AND report_id = ? ORDER BY id`).all(guildId, reportId) as Array<{ actorId: string; eventType: string; detail: string | null; createdAt: string }>;
  }

  private async targetIsStaff(guildId: string, targetId: string | undefined, settings: GuildSettings): Promise<boolean> {
    if (!targetId) return false;
    const guild = await this.getGuild(guildId);
    const member = await guild.members.fetch(targetId).catch(() => null);
    if (!member) return false;
    const staffIds = new Set([...settings.permissions.roles.reportStaff, ...settings.permissions.roles.confidentialReportStaff,
      ...settings.permissions.roles.ticketStaff, ...settings.permissions.roles.moderate]);
    return member.roles.cache.some((role) => staffIds.has(role.id)) || member.permissions.has(PermissionFlagsBits.ManageGuild);
  }

  private async notifyStaff(guildId: string, reportId: string, settings: GuildSettings): Promise<void> {
    const report = this.get(guildId, reportId);
    const channelId = report.confidential ? settings.channels.confidentialReports : settings.channels.reports;
    if (!channelId) return;
    const guild = await this.getGuild(guildId);
    const rawChannel = await guild.channels.fetch(channelId).catch(() => null);
    if (!rawChannel || rawChannel.guildId !== guildId || rawChannel.type !== ChannelType.GuildText) throw new NotFoundError('Il canale riservato delle segnalazioni non è disponibile in questo server.');
    const channel = rawChannel as TextChannel;
    const bot = this.client.user;
    if (!bot || !channel.permissionsFor(bot.id)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
      throw new AuthorizationError('Il bot non può inviare nel canale riservato delle segnalazioni.');
    }
    if (channel.permissionsFor(guild.roles.everyone)?.has(PermissionFlagsBits.ViewChannel)) {
      throw new AuthorizationError('Il canale segnalazioni è visibile a @everyone: la notifica non è stata pubblicata.');
    }
    const requiredRoles = report.confidential ? settings.permissions.roles.confidentialReportStaff : settings.permissions.roles.reportStaff;
    if (requiredRoles.length === 0 || requiredRoles.some((id) => !channel.permissionsFor(id)?.has(PermissionFlagsBits.ViewChannel))) {
      throw new AuthorizationError('Il canale non garantisce accesso a tutti i ruoli di staff autorizzati.');
    }
    const embed = new EmbedBuilder().setColor(Number.parseInt(settings.general.color.slice(1), 16)).setAuthor({ name: settings.general.name }).setTitle(report.confidential ? 'Nuova segnalazione riservata' : 'Nuova segnalazione')
      .setDescription(`ID: **${report.id}**\nCategoria: **${this.escape(report.category)}**\nStato: **Nuova**`)
      .setFooter({ text: 'I dettagli sono disponibili agli operatori autorizzati tramite la dashboard.' });
    const actions = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`report:assign:${report.id}`).setLabel('Prendi in carico').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`report:info:${report.id}`).setLabel('Richiedi informazioni').setStyle(ButtonStyle.Secondary),
    );
    await channel.send({ embeds: [embed], components: [actions], allowedMentions: { parse: [] } });
  }

  private addEvent(guildId: string, reportId: string, actorId: string, eventType: string, detail: string | null): void {
    this.db.prepare('INSERT INTO report_events(guild_id, report_id, actor_id, event_type, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(guildId, reportId, actorId, eventType, detail?.slice(0, 2000) ?? null, new Date().toISOString());
  }

  private settings(guildId: string): GuildSettings {
    const row = this.db.prepare('SELECT settings_json FROM guild_settings WHERE guild_id = ?').get(guildId) as { settings_json: string } | undefined;
    if (!row) throw new NotFoundError('Configurazione del server non trovata.');
    return JSON.parse(row.settings_json) as GuildSettings;
  }

  private async getGuild(guildId: string): Promise<Guild> {
    const guild = await this.client.guilds.fetch(guildId).catch(() => null);
    if (!guild) throw new NotFoundError('Il bot non è presente in questo server.');
    return guild;
  }

  private escape(value: string): string { return value.replace(/@/g, '@\u200b').replace(/[\u0000-\u001f]/g, ' ').slice(0, 100); }
}
