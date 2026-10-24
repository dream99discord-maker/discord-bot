import { randomUUID } from 'node:crypto';
import { ChannelType, EmbedBuilder, PermissionFlagsBits, type Client, type Guild, type GuildMember, type TextChannel } from 'discord.js';
import type { DatabaseHandle } from '../db.js';
import { audit } from '../db.js';
import { AppError, AuthorizationError, ConflictError, NotFoundError } from '../errors.js';
import type { GuildSettings } from '../settings.js';

export interface CaseView {
  caseNumber: number; guildId: string; action: string; operatorId: string; targetId: string;
  reason: string; result: string; discordReference: string | null; parentCaseNumber: number | null; createdAt: string;
}
interface CaseRow {
  case_number: number; guild_id: string; action: string; operator_id: string; target_id: string;
  reason: string; result: string; discord_reference: string | null; parent_case_number: number | null; created_at: string;
}
const mapCase = (row: CaseRow): CaseView => ({ caseNumber: row.case_number, guildId: row.guild_id, action: row.action,
  operatorId: row.operator_id, targetId: row.target_id, reason: row.reason, result: row.result,
  discordReference: row.discord_reference, parentCaseNumber: row.parent_case_number, createdAt: row.created_at });

export type ConfirmableAction =
  | { type: 'ban'; targetId: string; reason: string }
  | { type: 'purge'; channelId: string; amount: number };

export class ModerationService {
  constructor(private readonly db: DatabaseHandle, private readonly client: Client) {}

  async canModerate(guildId: string, actorId: string): Promise<boolean> {
    try { await this.assertModerator(guildId, actorId); return true; } catch { return false; }
  }

  async recordExternalAction(guildId: string, actorId: string, targetId: string, action: string, reason: string, result: 'ok' | 'failed' | 'uncertain'): Promise<CaseView> {
    this.validateReason(reason);
    await this.assertModerator(guildId, actorId);
    const caseNumber = this.beginCase(guildId, actorId, targetId, action, reason);
    this.finishCase(guildId, caseNumber, result, targetId);
    audit(this.db, { guildId, actorId, action: `moderation.${action}`, targetType: 'channel', targetId, result, after: { caseNumber, reason } });
    return this.getCase(guildId, caseNumber);
  }

  async warn(guildId: string, actorId: string, targetId: string, reason: string): Promise<{ case: CaseView; warningCount: number; dmDelivered: boolean }> {
    this.validateReason(reason);
    const { guild, target } = await this.authorizeTarget(guildId, actorId, targetId);
    const caseNumber = this.beginCase(guildId, actorId, targetId, 'warning', reason);
    try {
      const now = new Date().toISOString();
      this.db.prepare('INSERT INTO warnings(guild_id, case_number, target_id, operator_id, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(guildId, caseNumber, targetId, actorId, reason.trim(), now);
      const active = this.db.prepare('SELECT COUNT(*) AS amount FROM warnings WHERE guild_id = ? AND target_id = ? AND revoked_at IS NULL').get(guildId, targetId) as { amount: number };
      const delivered = await this.sendDm(target, `Hai ricevuto un avvertimento nel server **${guild.name}**. Motivo: ${reason.trim()}`);
      this.finishCase(guildId, caseNumber, delivered ? 'ok' : 'ok; messaggio privato non consegnato', null);
      audit(this.db, { guildId, actorId, action: 'moderation.warning', targetType: 'user', targetId, result: 'ok', after: { caseNumber, warningCount: active.amount, dmDelivered: delivered } });
      await this.applyWarningEscalation(guildId, actorId, target, active.amount, caseNumber);
      return { case: this.getCase(guildId, caseNumber), warningCount: active.amount, dmDelivered: delivered };
    } catch (error) {
      this.finishCase(guildId, caseNumber, `failed: ${this.errorText(error)}`, null);
      throw error;
    }
  }

  warnings(guildId: string, targetId: string): Array<{ caseNumber: number; operatorId: string; reason: string; createdAt: string; revokedAt: string | null; revocationReason: string | null }> {
    return this.db.prepare(`SELECT case_number AS caseNumber, operator_id AS operatorId, reason, created_at AS createdAt,
        revoked_at AS revokedAt, revocation_reason AS revocationReason
      FROM warnings WHERE guild_id = ? AND target_id = ? ORDER BY created_at DESC LIMIT 100`).all(guildId, targetId) as Array<{ caseNumber: number; operatorId: string; reason: string; createdAt: string; revokedAt: string | null; revocationReason: string | null }>;
  }

  async revokeWarning(guildId: string, actorId: string, caseNumber: number, reason: string): Promise<CaseView> {
    this.validateReason(reason);
    await this.assertModerator(guildId, actorId);
    const warning = this.db.prepare('SELECT target_id, revoked_at FROM warnings WHERE guild_id = ? AND case_number = ?').get(guildId, caseNumber) as { target_id: string; revoked_at: string | null } | undefined;
    if (!warning) throw new NotFoundError('Avvertimento non trovato.');
    if (warning.revoked_at) throw new ConflictError('Questo avvertimento è già stato revocato.');
    const revokeCase = this.beginCase(guildId, actorId, warning.target_id, 'warning-revoked', reason, caseNumber);
    const now = new Date().toISOString();
    const update = this.db.prepare(`UPDATE warnings SET revoked_at = ?, revoked_by = ?, revocation_reason = ?
      WHERE guild_id = ? AND case_number = ? AND revoked_at IS NULL`).run(now, actorId, reason.trim(), guildId, caseNumber);
    if (update.changes !== 1) {
      this.finishCase(guildId, revokeCase, 'failed: avvertimento modificato da un’altra richiesta', null);
      throw new ConflictError('L’avvertimento è stato modificato da un’altra richiesta.');
    }
    this.finishCase(guildId, revokeCase, 'ok', String(caseNumber));
    audit(this.db, { guildId, actorId, action: 'moderation.warning.revoke', targetType: 'warning', targetId: String(caseNumber), result: 'ok', after: { revokeCase, reason } });
    return this.getCase(guildId, revokeCase);
  }

  async timeout(guildId: string, actorId: string, targetId: string, durationMinutes: number, reason: string): Promise<{ case: CaseView; dmDelivered: boolean }> {
    this.validateReason(reason);
    if (!Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 40320) throw new AppError('La durata deve essere compresa fra 1 minuto e 28 giorni.');
    const { guild, target } = await this.authorizeTarget(guildId, actorId, targetId, PermissionFlagsBits.ModerateMembers);
    const caseNumber = this.beginCase(guildId, actorId, targetId, 'timeout', reason);
    try {
      await target.timeout(durationMinutes * 60_000, reason.trim());
      const delivered = await this.sendDm(target, `Hai ricevuto un timeout nel server **${guild.name}** per ${durationMinutes} minuti. Motivo: ${reason.trim()}`);
      this.finishCase(guildId, caseNumber, delivered ? 'ok' : 'ok; messaggio privato non consegnato', targetId);
      audit(this.db, { guildId, actorId, action: 'moderation.timeout', targetType: 'user', targetId, result: 'ok', after: { caseNumber, durationMinutes, dmDelivered: delivered } });
      return { case: this.getCase(guildId, caseNumber), dmDelivered: delivered };
    } catch (error) { this.finishCase(guildId, caseNumber, `failed: ${this.errorText(error)}`, null); throw error; }
  }

  async removeTimeout(guildId: string, actorId: string, targetId: string, reason: string): Promise<CaseView> {
    this.validateReason(reason);
    const { target } = await this.authorizeTarget(guildId, actorId, targetId, PermissionFlagsBits.ModerateMembers);
    const caseNumber = this.beginCase(guildId, actorId, targetId, 'untimeout', reason);
    try {
      await target.timeout(null, reason.trim());
      this.finishCase(guildId, caseNumber, 'ok', targetId);
      audit(this.db, { guildId, actorId, action: 'moderation.untimeout', targetType: 'user', targetId, result: 'ok', after: { caseNumber } });
      return this.getCase(guildId, caseNumber);
    } catch (error) { this.finishCase(guildId, caseNumber, `failed: ${this.errorText(error)}`, null); throw error; }
  }

  async kick(guildId: string, actorId: string, targetId: string, reason: string): Promise<{ case: CaseView; dmDelivered: boolean }> {
    this.validateReason(reason);
    const { guild, target } = await this.authorizeTarget(guildId, actorId, targetId, PermissionFlagsBits.KickMembers);
    const caseNumber = this.beginCase(guildId, actorId, targetId, 'kick', reason);
    try {
      await target.kick(reason.trim());
      const delivered = await this.sendDm(target, `Sei stato espulso dal server **${guild.name}**. Motivo: ${reason.trim()}`);
      this.finishCase(guildId, caseNumber, delivered ? 'ok' : 'ok; messaggio privato non consegnato', targetId);
      audit(this.db, { guildId, actorId, action: 'moderation.kick', targetType: 'user', targetId, result: 'ok', after: { caseNumber, dmDelivered: delivered } });
      return { case: this.getCase(guildId, caseNumber), dmDelivered: delivered };
    } catch (error) { this.finishCase(guildId, caseNumber, `failed: ${this.errorText(error)}`, null); throw error; }
  }

  async unban(guildId: string, actorId: string, targetId: string, reason: string): Promise<CaseView> {
    this.validateReason(reason);
    if (!/^\d{17,20}$/.test(targetId)) throw new AppError('L’ID Discord non è valido.');
    const actor = await this.assertModerator(guildId, actorId);
    const guild = actor.guild;
    const bot = await guild.members.fetch(this.client.user!.id).catch(() => null);
    if (!bot?.permissions.has(PermissionFlagsBits.BanMembers)) throw new AuthorizationError('Al bot manca il permesso Ban membri.');
    const ban = await guild.bans.fetch(targetId).catch(() => null);
    if (!ban) throw new NotFoundError('Questo utente non è bannato nel server.');
    const caseNumber = this.beginCase(guildId, actorId, targetId, 'unban', reason);
    try {
      await guild.members.unban(targetId, reason.trim());
      this.finishCase(guildId, caseNumber, 'ok', targetId);
      audit(this.db, { guildId, actorId, action: 'moderation.unban', targetType: 'user', targetId, result: 'ok', after: { caseNumber } });
      return this.getCase(guildId, caseNumber);
    } catch (error) { this.finishCase(guildId, caseNumber, `failed: ${this.errorText(error)}`, null); throw error; }
  }

  async requestBan(guildId: string, actorId: string, targetId: string, reason: string): Promise<{ confirmationId: string; expiresAt: string }> {
    this.validateReason(reason);
    await this.authorizeTarget(guildId, actorId, targetId, PermissionFlagsBits.BanMembers);
    const confirmationId = randomUUID();
    const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
    this.db.prepare('INSERT INTO confirmations(id, guild_id, actor_id, action_json, expires_at) VALUES (?, ?, ?, ?, ?)')
      .run(confirmationId, guildId, actorId, JSON.stringify({ type: 'ban', targetId, reason } satisfies ConfirmableAction), expiresAt);
    return { confirmationId, expiresAt };
  }

  async requestPurge(guildId: string, actorId: string, channelId: string, amount: number): Promise<{ confirmationId: string; expiresAt: string }> {
    await this.assertModerator(guildId, actorId);
    if (!Number.isInteger(amount) || amount < 2 || amount > 100) throw new AppError('Puoi eliminare da 2 a 100 messaggi per volta.');
    const guild = await this.getGuild(guildId);
    const channel = await this.getTextChannel(guild, channelId);
    await this.assertChannelPermission(guild, channel, actorId, PermissionFlagsBits.ManageMessages);
    const confirmationId = randomUUID();
    const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
    this.db.prepare('INSERT INTO confirmations(id, guild_id, actor_id, action_json, expires_at) VALUES (?, ?, ?, ?, ?)')
      .run(confirmationId, guildId, actorId, JSON.stringify({ type: 'purge', channelId, amount } satisfies ConfirmableAction), expiresAt);
    return { confirmationId, expiresAt };
  }

  async confirm(guildId: string, actorId: string, confirmationId: string): Promise<CaseView> {
    const row = this.db.prepare('SELECT action_json, expires_at, consumed_at FROM confirmations WHERE guild_id = ? AND id = ? AND actor_id = ?')
      .get(guildId, confirmationId, actorId) as { action_json: string; expires_at: string; consumed_at: string | null } | undefined;
    if (!row) throw new NotFoundError('Conferma non trovata.');
    if (row.consumed_at) throw new ConflictError('Questa conferma è già stata usata.');
    if (Date.parse(row.expires_at) <= Date.now()) throw new ConflictError('La conferma è scaduta.');
    const action = JSON.parse(row.action_json) as ConfirmableAction;
    if (action.type !== 'ban' && action.type !== 'purge') throw new ConflictError('Questa conferma non appartiene a un’operazione di moderazione.');
    const consumed = this.db.prepare('UPDATE confirmations SET consumed_at = ? WHERE id = ? AND actor_id = ? AND consumed_at IS NULL AND expires_at > ?')
      .run(new Date().toISOString(), confirmationId, actorId, new Date().toISOString());
    if (consumed.changes !== 1) throw new ConflictError('La conferma è stata usata da un’altra richiesta o è scaduta.');
    if (action.type === 'ban') return this.executeBan(guildId, actorId, action.targetId, action.reason);
    return this.executePurge(guildId, actorId, action.channelId, action.amount);
  }

  cancelConfirmation(guildId: string, actorId: string, confirmationId: string): void {
    const result = this.db.prepare(`UPDATE confirmations SET consumed_at = ? WHERE guild_id = ? AND id = ? AND actor_id = ? AND consumed_at IS NULL`)
      .run(new Date().toISOString(), guildId, confirmationId, actorId);
    if (result.changes !== 1) throw new NotFoundError('Conferma non trovata o già usata.');
  }

  async slowmode(guildId: string, actorId: string, channelId: string, seconds: number, reason: string): Promise<CaseView> {
    this.validateReason(reason);
    if (!Number.isInteger(seconds) || seconds < 0 || seconds > 21600) throw new AppError('Lo slowmode deve essere compreso fra 0 e 21600 secondi.');
    await this.assertModerator(guildId, actorId);
    const guild = await this.getGuild(guildId);
    const channel = await this.getTextChannel(guild, channelId);
    await this.assertChannelPermission(guild, channel, actorId, PermissionFlagsBits.ManageChannels);
    const caseNumber = this.beginCase(guildId, actorId, channelId, 'slowmode', reason);
    try {
      await channel.setRateLimitPerUser(seconds, reason.trim());
      this.finishCase(guildId, caseNumber, 'ok', channelId);
      audit(this.db, { guildId, actorId, action: 'moderation.slowmode', targetType: 'channel', targetId: channelId, result: 'ok', after: { caseNumber, seconds } });
      return this.getCase(guildId, caseNumber);
    } catch (error) { this.finishCase(guildId, caseNumber, `failed: ${this.errorText(error)}`, null); throw error; }
  }

  async listCases(guildId: string, options: { targetId?: string; limit?: number } = {}): Promise<CaseView[]> {
    const limit = Math.min(100, Math.max(1, options.limit ?? 50));
    const rows = options.targetId
      ? this.db.prepare('SELECT * FROM moderation_cases WHERE guild_id = ? AND target_id = ? ORDER BY case_number DESC LIMIT ?').all(guildId, options.targetId, limit) as CaseRow[]
      : this.db.prepare('SELECT * FROM moderation_cases WHERE guild_id = ? ORDER BY case_number DESC LIMIT ?').all(guildId, limit) as CaseRow[];
    return rows.map(mapCase);
  }

  private async executeBan(guildId: string, actorId: string, targetId: string, reason: string): Promise<CaseView> {
    this.validateReason(reason);
    const { guild } = await this.authorizeTarget(guildId, actorId, targetId, PermissionFlagsBits.BanMembers);
    const caseNumber = this.beginCase(guildId, actorId, targetId, 'ban', reason);
    try {
      const user = await this.client.users.fetch(targetId).catch(() => null);
      if (!user) throw new NotFoundError('Utente Discord non trovato.');
      await guild.members.ban(targetId, { reason: reason.trim(), deleteMessageSeconds: 0 });
      const delivered = await this.sendDm(user, `Sei stato bannato dal server **${guild.name}**. Motivo: ${reason.trim()}`);
      this.finishCase(guildId, caseNumber, delivered ? 'ok' : 'ok; messaggio privato non consegnato', targetId);
      audit(this.db, { guildId, actorId, action: 'moderation.ban', targetType: 'user', targetId, result: 'ok', after: { caseNumber, dmDelivered: delivered } });
      return this.getCase(guildId, caseNumber);
    } catch (error) { this.finishCase(guildId, caseNumber, `failed: ${this.errorText(error)}`, null); throw error; }
  }

  private async executePurge(guildId: string, actorId: string, channelId: string, amount: number): Promise<CaseView> {
    if (!Number.isInteger(amount) || amount < 2 || amount > 100) throw new AppError('Il limite di eliminazione non è valido.');
    await this.assertModerator(guildId, actorId);
    const guild = await this.getGuild(guildId);
    const channel = await this.getTextChannel(guild, channelId);
    await this.assertChannelPermission(guild, channel, actorId, PermissionFlagsBits.ManageMessages);
    const caseNumber = this.beginCase(guildId, actorId, channelId, 'purge', `Eliminazione confermata di ${amount} messaggi`);
    try {
      await channel.bulkDelete(amount, true);
      this.finishCase(guildId, caseNumber, 'ok', channelId);
      audit(this.db, { guildId, actorId, action: 'moderation.purge', targetType: 'channel', targetId: channelId, result: 'ok', after: { caseNumber, amount } });
      return this.getCase(guildId, caseNumber);
    } catch (error) { this.finishCase(guildId, caseNumber, `failed: ${this.errorText(error)}`, null); throw error; }
  }

  private async applyWarningEscalation(guildId: string, actorId: string, target: GuildMember, count: number, parentCase: number): Promise<void> {
    const settings = this.settings(guildId);
    if (!settings.moderation.warningEscalationEnabled) return;
    const escalation = settings.moderation.warningEscalations.find((item) => item.count === count);
    if (!escalation || target.communicationDisabledUntilTimestamp && target.communicationDisabledUntilTimestamp > Date.now()) return;
    const caseNumber = this.beginCase(guildId, actorId, target.id, 'warning-escalation-timeout', `Escalazione configurata dopo ${count} avvertimenti`, parentCase);
    try {
      const authorized = await this.authorizeTarget(guildId, actorId, target.id, PermissionFlagsBits.ModerateMembers);
      await authorized.target.timeout(escalation.durationMinutes * 60_000, `Escalazione configurata dopo ${count} avvertimenti`);
      this.finishCase(guildId, caseNumber, 'ok', target.id);
      audit(this.db, { guildId, actorId, action: 'moderation.warning.escalation', targetType: 'user', targetId: target.id, result: 'ok', after: { caseNumber, durationMinutes: escalation.durationMinutes } });
    } catch (error) {
      this.finishCase(guildId, caseNumber, `failed: ${this.errorText(error)}`, null);
    }
  }

  private async authorizeTarget(guildId: string, actorId: string, targetId: string, requiredBotPermission?: bigint): Promise<{ guild: Guild; actor: GuildMember; target: GuildMember }> {
    if (!/^\d{17,20}$/.test(targetId) || targetId === actorId) throw new AppError('Il destinatario non è valido.');
    const actor = await this.assertModerator(guildId, actorId);
    const guild = actor.guild;
    const target = await guild.members.fetch(targetId).catch(() => null);
    if (!target) throw new NotFoundError('Il destinatario non appartiene al server.');
    if (target.id === guild.ownerId) throw new AuthorizationError('Non è possibile applicare questa azione al proprietario del server.');
    if (actor.id !== guild.ownerId && actor.roles.highest.comparePositionTo(target.roles.highest) <= 0) throw new AuthorizationError('Il tuo ruolo deve essere più alto di quello del destinatario.');
    const bot = await guild.members.fetch(this.client.user!.id).catch(() => null);
    if (!bot) throw new AuthorizationError('Il bot non è presente nel server.');
    if (bot.roles.highest.comparePositionTo(target.roles.highest) <= 0) throw new AuthorizationError('Il ruolo del bot deve essere più alto di quello del destinatario.');
    if (requiredBotPermission && !bot.permissions.has(requiredBotPermission)) throw new AuthorizationError('Al bot manca il permesso Discord necessario.');
    return { guild, actor, target };
  }

  private async assertModerator(guildId: string, actorId: string): Promise<GuildMember> {
    const guild = await this.getGuild(guildId);
    const member = await guild.members.fetch(actorId).catch(() => null);
    if (!member) throw new AuthorizationError('Devi appartenere al server per usare la moderazione.');
    const staff = this.settings(guildId).permissions.roles.moderate;
    if (member.id !== guild.ownerId && !member.permissions.has(PermissionFlagsBits.ManageGuild) && !member.roles.cache.some((role) => staff.includes(role.id))) {
      throw new AuthorizationError('Il tuo ruolo non è autorizzato a moderare questo server.');
    }
    return member;
  }

  private async assertChannelPermission(guild: Guild, channel: TextChannel, actorId: string, permission: bigint): Promise<void> {
    const actor = await guild.members.fetch(actorId).catch(() => null);
    const botId = this.client.user?.id;
    if (!actor || !actor.permissions.has(PermissionFlagsBits.ManageGuild) && actor.id !== guild.ownerId && !actor.roles.cache.some((role) => this.settings(guild.id).permissions.roles.moderate.includes(role.id))) throw new AuthorizationError();
    if (!channel.permissionsFor(actor)?.has(permission)) throw new AuthorizationError('Non hai il permesso effettivo per gestire questo canale.');
    if (!botId || !channel.permissionsFor(botId)?.has(permission)) throw new AuthorizationError('Al bot manca il permesso effettivo nel canale.');
  }

  private async assertBotGuildPermission(guild: Guild, permission: bigint): Promise<void> {
    const bot = await guild.members.fetch(this.client.user!.id).catch(() => null);
    if (!bot || !bot.permissions.has(permission)) throw new AuthorizationError('Al bot manca il permesso Discord necessario.');
  }

  private async getTextChannel(guild: Guild, channelId: string): Promise<TextChannel> {
    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (!channel || channel.guildId !== guild.id || channel.type !== ChannelType.GuildText) throw new NotFoundError('Canale testuale non trovato in questo server.');
    return channel as TextChannel;
  }

  private async sendDm(target: { send: (content: string) => Promise<unknown> }, content: string): Promise<boolean> {
    try { await target.send(content); return true; } catch { return false; }
  }

  private beginCase(guildId: string, actorId: string, targetId: string, action: string, reason: string, parentCaseNumber?: number): number {
    const transaction = this.db.transaction(() => {
      this.db.prepare('INSERT INTO guild_case_sequences(guild_id, last_case_number) VALUES (?, 0) ON CONFLICT(guild_id) DO NOTHING').run(guildId);
      this.db.prepare('UPDATE guild_case_sequences SET last_case_number = last_case_number + 1 WHERE guild_id = ?').run(guildId);
      const row = this.db.prepare('SELECT last_case_number AS next FROM guild_case_sequences WHERE guild_id = ?').get(guildId) as { next: number };
      this.db.prepare(`INSERT INTO moderation_cases(guild_id, case_number, action, operator_id, target_id, reason, result, parent_case_number, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`)
        .run(guildId, row.next, action, actorId, targetId, reason.trim().slice(0, 1000), parentCaseNumber ?? null, new Date().toISOString());
      return row.next;
    }).immediate();
    return transaction;
  }

  private finishCase(guildId: string, caseNumber: number, result: string, reference: string | null): void {
    this.db.prepare('UPDATE moderation_cases SET result = ?, discord_reference = ? WHERE guild_id = ? AND case_number = ?')
      .run(result.slice(0, 500), reference, guildId, caseNumber);
    void this.publishCaseLog(guildId, caseNumber).catch(() => undefined);
  }

  private async publishCaseLog(guildId: string, caseNumber: number): Promise<void> {
    const settings = this.settings(guildId);
    const channelId = settings.channels.logs;
    if (!channelId) return;
    const guild = await this.getGuild(guildId);
    const rawChannel = await guild.channels.fetch(channelId).catch(() => null);
    if (!rawChannel || rawChannel.guildId !== guildId || rawChannel.type !== ChannelType.GuildText) return;
    const channel = rawChannel as TextChannel;
    const botId = this.client.user?.id;
    if (!botId || !channel.permissionsFor(botId)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) return;
    if (channel.permissionsFor(guild.roles.everyone)?.has(PermissionFlagsBits.ViewChannel)) return;
    const staffRoles = [...new Set([...settings.permissions.roles.moderate, ...settings.permissions.roles.configure])];
    if (!staffRoles.length || staffRoles.some((id) => !channel.permissionsFor(id)?.has(PermissionFlagsBits.ViewChannel))) return;
    const item = this.getCase(guildId, caseNumber);
    const embed = new EmbedBuilder().setColor(Number.parseInt(settings.general.color.slice(1), 16))
      .setAuthor({ name: settings.general.name }).setTitle(`Caso di moderazione #${caseNumber}`)
      .setDescription(`Azione: **${item.action}**\nDestinatario: **${item.targetId}**\nOperatore: **${item.operatorId}**\nEsito: **${item.result}**\nMotivo: ${item.reason.replace(/@/g, '@\u200b').slice(0, 1500)}`)
      .setTimestamp(new Date(item.createdAt)).setFooter({ text: settings.general.footer });
    await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
  }

  private getCase(guildId: string, caseNumber: number): CaseView {
    const row = this.db.prepare('SELECT * FROM moderation_cases WHERE guild_id = ? AND case_number = ?').get(guildId, caseNumber) as CaseRow | undefined;
    if (!row) throw new NotFoundError('Caso di moderazione non trovato.');
    return mapCase(row);
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

  private validateReason(reason: string): void {
    if (reason.trim().length < 3 || reason.trim().length > 1000) throw new AppError('La motivazione deve contenere da 3 a 1000 caratteri.');
  }

  private errorText(error: unknown): string { return error instanceof AppError ? error.message.slice(0, 300) : 'Discord non ha completato l’azione. Verifica i permessi e riprova.'; }
}
