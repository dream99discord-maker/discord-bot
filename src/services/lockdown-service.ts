import { ChannelType, PermissionFlagsBits, type Client, type Guild, type GuildBasedChannel, type TextChannel } from 'discord.js';
import type { DatabaseHandle } from '../db.js';
import { audit } from '../db.js';
import { AppError, AuthorizationError, ConflictError, NotFoundError } from '../errors.js';
import type { ModerationService } from './moderation-service.js';

interface Snapshot {
  guild_id: string; channel_id: string; previous_allow: string; previous_deny: string;
  applied_allow: string; applied_deny: string; applied_at: string;
}

export interface LockdownResult { changed: number; skipped: number; failed: number; scheduledTaskId?: string; }

export class LockdownService {
  constructor(private readonly db: DatabaseHandle, private readonly client: Client, private readonly moderation: ModerationService) {}

  async activate(guildId: string, actorId: string, durationMinutes?: number): Promise<LockdownResult> {
    if (!(await this.moderation.canModerate(guildId, actorId))) throw new AuthorizationError();
    if (durationMinutes !== undefined && (!Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 1440)) throw new AppError('La durata del lockdown deve essere da 1 a 1440 minuti.');
    const existing = this.db.prepare('SELECT COUNT(*) AS amount FROM lockdown_snapshots WHERE guild_id = ?').get(guildId) as { amount: number };
    if (existing.amount) throw new ConflictError('È già attivo un lockdown per questo server.');
    const guild = await this.getGuild(guildId);
    const bot = await guild.members.fetch(this.client.user!.id).catch(() => null);
    if (!bot?.permissions.has(PermissionFlagsBits.ManageChannels)) throw new AuthorizationError('Al bot manca il permesso Gestisci canali.');
    const channels = [...guild.channels.cache.values()].filter((channel) => channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildAnnouncement) as TextChannel[];
    let changed = 0;
    let skipped = 0;
    let failed = 0;
    for (const channel of channels) {
      const everyone = channel.permissionOverwrites.cache.get(guild.roles.everyone.id);
      if (everyone?.deny.has(PermissionFlagsBits.SendMessages)) { skipped++; continue; }
      if (!channel.permissionsFor(bot)?.has(PermissionFlagsBits.ManageChannels)) { failed++; continue; }
      const previousAllow = everyone?.allow.bitfield.toString() ?? '0';
      const previousDeny = everyone?.deny.bitfield.toString() ?? '0';
      try {
        await channel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: false }, { reason: `Lockdown temporaneo richiesto da ${actorId}` });
        const applied = channel.permissionOverwrites.cache.get(guild.roles.everyone.id);
        if (!applied || !applied.deny.has(PermissionFlagsBits.SendMessages)) throw new Error('Discord non ha applicato il blocco previsto.');
        const appliedAt = new Date().toISOString();
        this.db.prepare(`INSERT INTO lockdown_snapshots(guild_id, channel_id, previous_allow, previous_deny, applied_allow, applied_deny, applied_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(guildId, channel.id, previousAllow, previousDeny, applied.allow.bitfield.toString(), applied.deny.bitfield.toString(), appliedAt);
        changed++;
      } catch {
        failed++;
      }
    }
    let scheduledTaskId: string | undefined;
    if (durationMinutes !== undefined && changed > 0) {
      scheduledTaskId = randomUUID();
      const now = new Date().toISOString();
      const runAt = new Date(Date.now() + durationMinutes * 60_000).toISOString();
      this.db.prepare(`INSERT INTO scheduled_tasks(id, guild_id, kind, payload_json, run_at, status, created_by, created_at, updated_at)
        VALUES (?, ?, 'lockdown-end', '{}', ?, 'pending', ?, ?, ?)`)
        .run(scheduledTaskId, guildId, runAt, actorId, now, now);
    }
    audit(this.db, { guildId, actorId, action: 'security.lockdown.activate', targetType: 'guild', targetId: guildId, result: failed ? 'uncertain' : 'ok', after: { changed, skipped, failed, durationMinutes } });
    await this.moderation.recordExternalAction(guildId, actorId, guildId, 'lockdown', 'Lockdown temporaneo richiesto dall’operatore', failed ? 'uncertain' : 'ok');
    return { changed, skipped, failed, ...(scheduledTaskId ? { scheduledTaskId } : {}) };
  }

  async lockChannel(guildId: string, actorId: string, channelId: string, reason: string): Promise<{ changed: boolean }> {
    if (!(await this.moderation.canModerate(guildId, actorId))) throw new AuthorizationError();
    if (reason.trim().length < 3 || reason.trim().length > 1000) throw new AppError('La motivazione deve contenere da 3 a 1000 caratteri.');
    const active = this.db.prepare('SELECT COUNT(*) AS amount FROM lockdown_snapshots WHERE guild_id = ?').get(guildId) as { amount: number };
    if (active.amount) throw new ConflictError('È già attivo un lockdown o un blocco canale per questo server.');
    const guild = await this.getGuild(guildId);
    const raw = await guild.channels.fetch(channelId).catch(() => null);
    if (!raw || raw.guildId !== guildId || (raw.type !== ChannelType.GuildText && raw.type !== ChannelType.GuildAnnouncement)) throw new NotFoundError('Canale testuale non trovato in questo server.');
    const channel = raw as TextChannel;
    const bot = await guild.members.fetch(this.client.user!.id).catch(() => null);
    if (!bot || !channel.permissionsFor(bot)?.has(PermissionFlagsBits.ManageChannels)) throw new AuthorizationError('Al bot manca Gestisci canali nel canale selezionato.');
    const existing = channel.permissionOverwrites.cache.get(guild.roles.everyone.id);
    if (existing?.deny.has(PermissionFlagsBits.SendMessages)) throw new ConflictError('L’invio è già bloccato per @everyone; non verrà modificato uno stato manuale.');
    const previousAllow = existing?.allow.bitfield.toString() ?? '0';
    const previousDeny = existing?.deny.bitfield.toString() ?? '0';
    await channel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: false }, { reason: `Blocco canale da ${actorId}: ${reason.trim()}` });
    const applied = channel.permissionOverwrites.cache.get(guild.roles.everyone.id);
    if (!applied?.deny.has(PermissionFlagsBits.SendMessages)) throw new AppError('Discord non ha applicato il blocco richiesto.', 502, 'PERMESSI_NON_APPLICATI');
    const now = new Date().toISOString();
    try {
      this.db.prepare(`INSERT INTO lockdown_snapshots(guild_id, channel_id, previous_allow, previous_deny, applied_allow, applied_deny, applied_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(guildId, channelId, previousAllow, previousDeny, applied.allow.bitfield.toString(), applied.deny.bitfield.toString(), now);
    } catch (error) {
      const prior = (BigInt(previousAllow) & PermissionFlagsBits.SendMessages) !== 0n ? true
        : (BigInt(previousDeny) & PermissionFlagsBits.SendMessages) !== 0n ? false : null;
      await channel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: prior }, { reason: 'Ripristino dopo errore di registrazione del blocco' }).catch(() => undefined);
      throw error;
    }
    await this.moderation.recordExternalAction(guildId, actorId, channelId, 'channel-lock', reason, 'ok');
    audit(this.db, { guildId, actorId, action: 'security.channel.lock', targetType: 'channel', targetId: channelId, result: 'ok', after: { reason } });
    return { changed: true };
  }

  async unlockChannel(guildId: string, actorId: string, channelId: string, reason: string): Promise<{ changed: boolean; skipped: boolean }> {
    if (!(await this.moderation.canModerate(guildId, actorId))) throw new AuthorizationError();
    if (reason.trim().length < 3 || reason.trim().length > 1000) throw new AppError('La motivazione deve contenere da 3 a 1000 caratteri.');
    const snapshot = this.db.prepare('SELECT * FROM lockdown_snapshots WHERE guild_id = ? AND channel_id = ?').get(guildId, channelId) as Snapshot | undefined;
    if (!snapshot) throw new NotFoundError('Non esiste un blocco registrato dal bot per questo canale.');
    const guild = await this.getGuild(guildId);
    const raw = await guild.channels.fetch(channelId).catch(() => null);
    if (!raw || raw.guildId !== guildId || (raw.type !== ChannelType.GuildText && raw.type !== ChannelType.GuildAnnouncement)) {
      this.removeSnapshot(guildId, channelId);
      return { changed: false, skipped: true };
    }
    const channel = raw as TextChannel;
    const current = channel.permissionOverwrites.cache.get(guild.roles.everyone.id);
    if (!current || current.allow.bitfield.toString() !== snapshot.applied_allow || current.deny.bitfield.toString() !== snapshot.applied_deny) {
      this.removeSnapshot(guildId, channelId);
      audit(this.db, { guildId, actorId, action: 'security.channel.unlock', targetType: 'channel', targetId: channelId, result: 'uncertain', after: { restored: false, reason: 'permessi modificati dopo il blocco' } });
      await this.moderation.recordExternalAction(guildId, actorId, channelId, 'channel-unlock', reason, 'uncertain');
      return { changed: false, skipped: true };
    }
    const bot = await guild.members.fetch(this.client.user!.id).catch(() => null);
    if (!bot || !channel.permissionsFor(bot)?.has(PermissionFlagsBits.ManageChannels)) throw new AuthorizationError('Al bot manca Gestisci canali nel canale selezionato.');
    const prior = (BigInt(snapshot.previous_allow) & PermissionFlagsBits.SendMessages) !== 0n ? true
      : (BigInt(snapshot.previous_deny) & PermissionFlagsBits.SendMessages) !== 0n ? false : null;
    await channel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: prior }, { reason: `Sblocco canale da ${actorId}: ${reason.trim()}` });
    this.removeSnapshot(guildId, channelId);
    await this.moderation.recordExternalAction(guildId, actorId, channelId, 'channel-unlock', reason, 'ok');
    audit(this.db, { guildId, actorId, action: 'security.channel.unlock', targetType: 'channel', targetId: channelId, result: 'ok', after: { reason } });
    return { changed: true, skipped: false };
  }

  async requestActivation(guildId: string, actorId: string, durationMinutes?: number): Promise<{ confirmationId: string; expiresAt: string }> {
    if (!(await this.moderation.canModerate(guildId, actorId))) throw new AuthorizationError();
    if (durationMinutes !== undefined && (!Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 1440)) throw new AppError('La durata del lockdown deve essere da 1 a 1440 minuti.');
    const confirmationId = randomUUID();
    const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
    this.db.prepare('INSERT INTO confirmations(id, guild_id, actor_id, action_json, expires_at) VALUES (?, ?, ?, ?, ?)')
      .run(confirmationId, guildId, actorId, JSON.stringify({ type: 'lockdown', durationMinutes }), expiresAt);
    return { confirmationId, expiresAt };
  }

  async confirmActivation(guildId: string, actorId: string, confirmationId: string): Promise<LockdownResult> {
    const row = this.db.prepare('SELECT action_json, expires_at, consumed_at FROM confirmations WHERE guild_id = ? AND id = ? AND actor_id = ?')
      .get(guildId, confirmationId, actorId) as { action_json: string; expires_at: string; consumed_at: string | null } | undefined;
    if (!row || row.consumed_at || Date.parse(row.expires_at) <= Date.now()) throw new ConflictError('La conferma non è valida o è scaduta.');
    const action = JSON.parse(row.action_json) as { type: string; durationMinutes?: number };
    if (action.type !== 'lockdown') throw new ConflictError('La conferma non appartiene a un lockdown.');
    const consumed = this.db.prepare(`UPDATE confirmations SET consumed_at = ? WHERE guild_id = ? AND id = ? AND actor_id = ? AND consumed_at IS NULL AND expires_at > ?`)
      .run(new Date().toISOString(), guildId, confirmationId, actorId, new Date().toISOString());
    if (consumed.changes !== 1) throw new ConflictError('La conferma è già stata usata o è scaduta.');
    return this.activate(guildId, actorId, action.durationMinutes);
  }

  cancelConfirmation(guildId: string, actorId: string, confirmationId: string): void {
    const result = this.db.prepare(`UPDATE confirmations SET consumed_at = ? WHERE guild_id = ? AND id = ? AND actor_id = ? AND consumed_at IS NULL`)
      .run(new Date().toISOString(), guildId, confirmationId, actorId);
    if (result.changes !== 1) throw new NotFoundError('Conferma non trovata o già usata.');
  }

  async restore(guildId: string, actorId: string): Promise<LockdownResult> {
    if (actorId !== 'system' && !(await this.moderation.canModerate(guildId, actorId))) throw new AuthorizationError();
    const snapshots = this.db.prepare('SELECT * FROM lockdown_snapshots WHERE guild_id = ?').all(guildId) as Snapshot[];
    if (snapshots.length === 0) return { changed: 0, skipped: 0, failed: 0 };
    const guild = await this.getGuild(guildId);
    let changed = 0;
    let skipped = 0;
    let failed = 0;
    for (const snapshot of snapshots) {
      const raw = await guild.channels.fetch(snapshot.channel_id).catch(() => null);
      if (!raw || raw.guildId !== guildId || (raw.type !== ChannelType.GuildText && raw.type !== ChannelType.GuildAnnouncement)) {
        this.removeSnapshot(guildId, snapshot.channel_id);
        skipped++;
        continue;
      }
      const channel = raw as TextChannel;
      const current = channel.permissionOverwrites.cache.get(guild.roles.everyone.id);
      if (!current || current.allow.bitfield.toString() !== snapshot.applied_allow || current.deny.bitfield.toString() !== snapshot.applied_deny) {
        // Una modifica successiva diversa da quella registrata dal bot ha priorità e non viene sovrascritta.
        this.removeSnapshot(guildId, snapshot.channel_id);
        skipped++;
        audit(this.db, { guildId, actorId, action: 'security.lockdown.restore', targetType: 'channel', targetId: snapshot.channel_id, result: 'uncertain', after: { restored: false, reason: 'permessi modificati dopo il lockdown' } });
        continue;
      }
      const bot = await guild.members.fetch(this.client.user!.id).catch(() => null);
      if (!bot || !channel.permissionsFor(bot)?.has(PermissionFlagsBits.ManageChannels)) { failed++; continue; }
      const previousSendMessages = (BigInt(snapshot.previous_allow) & PermissionFlagsBits.SendMessages) !== 0n
        ? true
        : (BigInt(snapshot.previous_deny) & PermissionFlagsBits.SendMessages) !== 0n ? false : null;
      try {
        await channel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: previousSendMessages }, { reason: `Ripristino lockdown richiesto da ${actorId}` });
        this.removeSnapshot(guildId, snapshot.channel_id);
        changed++;
      } catch { failed++; }
    }
    this.db.prepare(`UPDATE scheduled_tasks SET status = 'cancelled', updated_at = ? WHERE guild_id = ? AND kind = 'lockdown-end' AND status = 'pending'`)
      .run(new Date().toISOString(), guildId);
    audit(this.db, { guildId, actorId, action: 'security.lockdown.restore', targetType: 'guild', targetId: guildId, result: failed ? 'uncertain' : 'ok', after: { changed, skipped, failed } });
    if (actorId !== 'system') {
      await this.moderation.recordExternalAction(guildId, actorId, guildId, 'lockdown-restore', 'Ripristino lockdown richiesto dall’operatore', failed || skipped ? 'uncertain' : 'ok');
    }
    return { changed, skipped, failed };
  }

  stopAutomations(guildId: string, actorId: string): void {
    this.db.prepare(`INSERT INTO automation_state(guild_id, stopped, stopped_by, updated_at) VALUES (?, 1, ?, ?)
      ON CONFLICT(guild_id) DO UPDATE SET stopped = 1, stopped_by = excluded.stopped_by, updated_at = excluded.updated_at`)
      .run(guildId, actorId, new Date().toISOString());
    audit(this.db, { guildId, actorId, action: 'security.automations.stop', targetType: 'guild', targetId: guildId, result: 'ok' });
  }

  startAutomations(guildId: string, actorId: string): void {
    this.db.prepare(`INSERT INTO automation_state(guild_id, stopped, stopped_by, updated_at) VALUES (?, 0, ?, ?)
      ON CONFLICT(guild_id) DO UPDATE SET stopped = 0, stopped_by = excluded.stopped_by, updated_at = excluded.updated_at`)
      .run(guildId, actorId, new Date().toISOString());
    audit(this.db, { guildId, actorId, action: 'security.automations.start', targetType: 'guild', targetId: guildId, result: 'ok' });
  }

  areAutomationsStopped(guildId: string): boolean {
    const row = this.db.prepare('SELECT stopped FROM automation_state WHERE guild_id = ?').get(guildId) as { stopped: number } | undefined;
    return row?.stopped === 1;
  }

  private removeSnapshot(guildId: string, channelId: string): void {
    this.db.prepare('DELETE FROM lockdown_snapshots WHERE guild_id = ? AND channel_id = ?').run(guildId, channelId);
  }

  private async getGuild(guildId: string): Promise<Guild> {
    const guild = await this.client.guilds.fetch(guildId).catch(() => null);
    if (!guild) throw new NotFoundError('Il bot non è presente in questo server.');
    return guild;
  }
}
import { randomUUID } from 'node:crypto';
