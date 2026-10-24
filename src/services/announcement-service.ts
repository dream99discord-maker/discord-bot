import { randomUUID } from 'node:crypto';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder, PermissionFlagsBits, type Client, type Guild, type TextChannel } from 'discord.js';
import type { DatabaseHandle } from '../db.js';
import { audit } from '../db.js';
import { AppError, ConflictError, NotFoundError } from '../errors.js';
import type { GuildSettings } from '../settings.js';

export type AnnouncementKind = 'annuncio' | 'manutenzione' | 'aggiornamento' | 'evento';
export interface AnnouncementInput { type: AnnouncementKind; title: string; content: string; roleIds?: string[]; runAt?: string; channelId?: string; }
export interface ScheduledAnnouncement { id: string; guildId: string; input: AnnouncementInput; runAt: string; status: string; createdBy: string; version: number; updatedAt: string; lastError: string | null; }
interface ScheduledRow { id: string; guild_id: string; payload_json: string; run_at: string; status: string; created_by: string; version: number; updated_at: string; last_error: string | null; }
const mapTask = (row: ScheduledRow): ScheduledAnnouncement => ({ id: row.id, guildId: row.guild_id, input: JSON.parse(row.payload_json) as AnnouncementInput,
  runAt: row.run_at, status: row.status, createdBy: row.created_by, version: row.version, updatedAt: row.updated_at, lastError: row.last_error });

export class AnnouncementService {
  constructor(private readonly db: DatabaseHandle, private readonly client: Client) {}

  async preview(guildId: string, input: AnnouncementInput): Promise<{ embed: ReturnType<EmbedBuilder['toJSON']>; mentions: string[] }> {
    this.validateInput(input);
    const settings = this.settings(guildId);
    await this.validateChannel(guildId, settings, input.channelId);
    const roles = await this.validateRoleMentions(guildId, settings, input.roleIds ?? []);
    const embed = this.buildEmbed(settings, input);
    return { embed: embed.toJSON(), mentions: roles };
  }

  async create(guildId: string, actorId: string, input: AnnouncementInput): Promise<{ scheduled: boolean; task?: ScheduledAnnouncement; messageId?: string }> {
    this.validateInput(input);
    const settings = this.settings(guildId);
    if (!settings.modules.announcements) throw new AppError('Il modulo annunci è disattivato.', 409, 'MODULO_DISATTIVATO');
    await this.validateChannel(guildId, settings, input.channelId);
    await this.validateRoleMentions(guildId, settings, input.roleIds ?? []);
    if (input.runAt) {
      const runAt = new Date(input.runAt);
      if (Number.isNaN(runAt.getTime()) || runAt.getTime() < Date.now() + 30_000 || runAt.getTime() > Date.now() + 365 * 86_400_000) {
        throw new AppError('La data di programmazione deve essere tra 30 secondi e un anno da adesso.');
      }
      const id = randomUUID();
      const now = new Date().toISOString();
      this.db.prepare(`INSERT INTO scheduled_tasks(id, guild_id, kind, payload_json, run_at, status, created_by, created_at, updated_at)
        VALUES (?, ?, 'announcement', ?, ?, 'pending', ?, ?, ?)`)
        .run(id, guildId, JSON.stringify(input), runAt.toISOString(), actorId, now, now);
      audit(this.db, { guildId, actorId, action: 'announcement.schedule', targetType: 'scheduled-task', targetId: id, result: 'ok', after: { runAt: runAt.toISOString(), type: input.type } });
      return { scheduled: true, task: this.get(guildId, id) };
    }
    const messageId = await this.send(guildId, input, `direct-${randomUUID()}`);
    audit(this.db, { guildId, actorId, action: 'announcement.send', targetType: 'announcement', targetId: messageId, result: 'ok', after: { type: input.type } });
    return { scheduled: false, messageId };
  }

  async requestConfirmation(guildId: string, actorId: string, input: AnnouncementInput): Promise<{ confirmationId: string; expiresAt: string }> {
    this.validateInput(input);
    await this.validateRoleMentions(guildId, this.settings(guildId), input.roleIds ?? []);
    const confirmationId = randomUUID();
    const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
    this.db.prepare('INSERT INTO confirmations(id, guild_id, actor_id, action_json, expires_at) VALUES (?, ?, ?, ?, ?)')
      .run(confirmationId, guildId, actorId, JSON.stringify({ type: 'announcement', input }), expiresAt);
    return { confirmationId, expiresAt };
  }

  async confirm(guildId: string, actorId: string, confirmationId: string): Promise<{ scheduled: boolean; task?: ScheduledAnnouncement; messageId?: string }> {
    const row = this.db.prepare('SELECT action_json, expires_at, consumed_at FROM confirmations WHERE guild_id = ? AND id = ? AND actor_id = ?')
      .get(guildId, confirmationId, actorId) as { action_json: string; expires_at: string; consumed_at: string | null } | undefined;
    if (!row || row.consumed_at || Date.parse(row.expires_at) <= Date.now()) throw new AppError('Conferma non trovata, già usata o scaduta.', 409, 'CONFERMA_NON_VALIDA');
    const action = JSON.parse(row.action_json) as { type: string; input?: AnnouncementInput };
    if (action.type !== 'announcement' || !action.input) throw new AppError('La conferma non appartiene a un annuncio.', 400, 'CONFERMA_NON_VALIDA');
    const consumed = this.db.prepare(`UPDATE confirmations SET consumed_at = ? WHERE guild_id = ? AND id = ? AND actor_id = ? AND consumed_at IS NULL AND expires_at > ?`)
      .run(new Date().toISOString(), guildId, confirmationId, actorId, new Date().toISOString());
    if (consumed.changes !== 1) throw new ConflictError('La conferma è già stata usata o è scaduta.');
    return this.create(guildId, actorId, action.input);
  }

  cancelConfirmation(guildId: string, actorId: string, confirmationId: string): void {
    const result = this.db.prepare(`UPDATE confirmations SET consumed_at = ? WHERE guild_id = ? AND id = ? AND actor_id = ? AND consumed_at IS NULL`)
      .run(new Date().toISOString(), guildId, confirmationId, actorId);
    if (result.changes !== 1) throw new NotFoundError('Conferma non trovata o già usata.');
  }

  get(guildId: string, taskId: string): ScheduledAnnouncement {
    const row = this.db.prepare(`SELECT * FROM scheduled_tasks WHERE guild_id = ? AND id = ? AND kind = 'announcement'`).get(guildId, taskId) as ScheduledRow | undefined;
    if (!row) throw new NotFoundError('Annuncio programmato non trovato in questo server.');
    return mapTask(row);
  }

  list(guildId: string, limit = 100): ScheduledAnnouncement[] {
    const rows = this.db.prepare(`SELECT * FROM scheduled_tasks WHERE guild_id = ? AND kind = 'announcement' ORDER BY run_at DESC LIMIT ?`)
      .all(guildId, Math.min(100, Math.max(1, limit))) as ScheduledRow[];
    return rows.map(mapTask);
  }

  async update(guildId: string, actorId: string, taskId: string, expectedVersion: number, patch: Partial<AnnouncementInput>): Promise<ScheduledAnnouncement> {
    const current = this.get(guildId, taskId);
    if (current.status !== 'pending') throw new ConflictError('È possibile modificare soltanto gli annunci ancora programmati.');
    if (current.version !== expectedVersion) throw new ConflictError(`Versione non aggiornata: la versione corrente è ${current.version}.`);
    const next = { ...current.input, ...patch };
    this.validateInput(next);
    const settings = this.settings(guildId);
    await this.validateChannel(guildId, settings, next.channelId);
    await this.validateRoleMentions(guildId, settings, next.roleIds ?? []);
    const runAt = next.runAt ? new Date(next.runAt) : new Date(current.runAt);
    if (Number.isNaN(runAt.getTime()) || runAt.getTime() < Date.now() + 30_000 || runAt.getTime() > Date.now() + 365 * 86_400_000) {
      throw new AppError('La data programmata deve essere tra 30 secondi e un anno da adesso.');
    }
    const now = new Date().toISOString();
    const result = this.db.prepare(`UPDATE scheduled_tasks SET payload_json = ?, run_at = ?, version = version + 1, updated_at = ?
      WHERE guild_id = ? AND id = ? AND status = 'pending' AND version = ?`)
      .run(JSON.stringify(next), runAt.toISOString(), now, guildId, taskId, expectedVersion);
    if (result.changes !== 1) throw new ConflictError('L’annuncio è cambiato durante la modifica.');
    audit(this.db, { guildId, actorId, action: 'announcement.update', targetType: 'scheduled-task', targetId: taskId, result: 'ok', before: current.input, after: next });
    return this.get(guildId, taskId);
  }

  cancel(guildId: string, actorId: string, taskId: string): ScheduledAnnouncement {
    const current = this.get(guildId, taskId);
    if (current.status !== 'pending') throw new ConflictError('È possibile annullare soltanto gli annunci ancora programmati.');
    const now = new Date().toISOString();
    const result = this.db.prepare(`UPDATE scheduled_tasks SET status = 'cancelled', version = version + 1, updated_at = ?
      WHERE guild_id = ? AND id = ? AND kind = 'announcement' AND status = 'pending' AND version = ?`)
      .run(now, guildId, taskId, current.version);
    if (result.changes !== 1) throw new ConflictError('L’annuncio è cambiato durante l’annullamento.');
    audit(this.db, { guildId, actorId, action: 'announcement.cancel', targetType: 'scheduled-task', targetId: taskId, result: 'ok' });
    return this.get(guildId, taskId);
  }

  async executeScheduled(guildId: string, taskId: string, payload: AnnouncementInput): Promise<string> {
    return this.send(guildId, payload, taskId);
  }

  private async send(guildId: string, input: AnnouncementInput, marker: string): Promise<string> {
    const settings = this.settings(guildId);
    const channelId = input.channelId ?? settings.channels.announcements;
    if (!channelId) throw new AppError('Configura un canale per gli annunci.', 409, 'CANALE_NON_CONFIGURATO');
    const guild = await this.getGuild(guildId);
    const rawChannel = await guild.channels.fetch(channelId).catch(() => null);
    if (!rawChannel || rawChannel.guildId !== guildId || (rawChannel.type !== ChannelType.GuildText && rawChannel.type !== ChannelType.GuildAnnouncement)) throw new NotFoundError('Il canale annunci non esiste o non è testuale.');
    const channel = rawChannel as TextChannel;
    const bot = this.client.user;
    const requiredPermissions = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks,
      ...(!marker.startsWith('direct-') ? [PermissionFlagsBits.ReadMessageHistory] : [])];
    if (!bot || !channel.permissionsFor(bot.id)?.has(requiredPermissions)) {
      throw new AppError('Al bot mancano i permessi effettivi per pubblicare nel canale annunci.', 403, 'PERMESSO_BOT_MANCANTE');
    }
    const allowedRoles = await this.validateRoleMentions(guildId, settings, input.roleIds ?? []);
    if (!marker.startsWith('direct-')) {
      let before: string | undefined;
      let historyExhausted = false;
      for (let pageIndex = 0; pageIndex < 10; pageIndex++) {
        const recent = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
        const duplicate = recent.find((message) => message.embeds.some((embed) => embed.footer?.text.includes(`pianificazione:${marker}`)));
        if (duplicate) return duplicate.id;
        if (recent.size < 100) { historyExhausted = true; break; }
        before = recent.last()?.id;
        if (!before) { historyExhausted = true; break; }
      }
      if (!historyExhausted) throw new AppError('Non è possibile escludere un duplicato cercando gli ultimi 1000 messaggi. L’annuncio è stato bloccato per revisione manuale.', 409, 'VERIFICA_DUPLICATO_INCOMPLETA');
    }
    const content = allowedRoles.map((roleId) => `<@&${roleId}>`).join(' ');
    const embed = this.buildEmbed(settings, input);
    const foot = settings.general.footer;
    embed.setFooter({ text: `${foot} · pianificazione:${marker}`.slice(0, 2048) });
    const message = await channel.send({ ...(content ? { content } : {}), embeds: [embed], allowedMentions: { parse: [], roles: allowedRoles } });
    return message.id;
  }

  private buildEmbed(settings: GuildSettings, input: AnnouncementInput): EmbedBuilder {
    const titles: Record<AnnouncementKind, string> = { annuncio: 'Annuncio', manutenzione: 'Avviso di manutenzione', aggiornamento: 'Aggiornamento', evento: 'Evento' };
    return new EmbedBuilder().setColor(Number.parseInt(settings.general.color.slice(1), 16)).setAuthor({ name: settings.general.name }).setTitle(input.title.trim() || titles[input.type])
      .setDescription(input.content.trim()).setFooter({ text: settings.general.footer });
  }

  private validateInput(input: AnnouncementInput): void {
    if (!['annuncio', 'manutenzione', 'aggiornamento', 'evento'].includes(input.type)) throw new AppError('Tipo di annuncio non valido.');
    if (input.title.trim().length < 1 || input.title.trim().length > 100) throw new AppError('Il titolo deve contenere da 1 a 100 caratteri.');
    if (input.content.trim().length < 1 || input.content.trim().length > 4000) throw new AppError('Il testo deve contenere da 1 a 4000 caratteri.');
    if ((input.roleIds?.length ?? 0) > 10 || new Set(input.roleIds ?? []).size !== (input.roleIds?.length ?? 0)) throw new AppError('Puoi menzionare fino a 10 ruoli, senza duplicati.');
    if (input.channelId && !/^\d{17,20}$/.test(input.channelId)) throw new AppError('ID canale non valido.');
  }

  private async validateRoleMentions(guildId: string, settings: GuildSettings, roleIds: string[]): Promise<string[]> {
    const allowed = new Set(settings.announcements.allowedRoleMentions);
    const guild = await this.getGuild(guildId);
    for (const roleId of roleIds) {
      if (!allowed.has(roleId)) throw new AppError(`La menzione del ruolo ${roleId} non è autorizzata dalla configurazione.`, 403, 'MENZIONE_NON_AUTORIZZATA');
      if (!await guild.roles.fetch(roleId).catch(() => null)) throw new NotFoundError('Un ruolo da menzionare non esiste in questo server.');
    }
    return roleIds;
  }

  private async validateChannel(guildId: string, settings: GuildSettings, channelOverride?: string): Promise<void> {
    const channelId = channelOverride ?? settings.channels.announcements;
    if (!channelId) throw new AppError('Seleziona o configura un canale per gli annunci.', 409, 'CANALE_NON_CONFIGURATO');
    const guild = await this.getGuild(guildId);
    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (!channel || channel.guildId !== guildId || (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement)) {
      throw new NotFoundError('Il canale annunci non esiste o appartiene a un altro server.');
    }
    const bot = this.client.user;
    if (!bot || !channel.permissionsFor(bot.id)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
      throw new AppError('Il bot non può pubblicare nel canale scelto: verifica i permessi effettivi.', 403, 'PERMESSO_BOT_MANCANTE');
    }
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
