import { randomUUID } from 'node:crypto';
import { ChannelType, type Client } from 'discord.js';
import type { DatabaseHandle } from '../db.js';
import { audit } from '../db.js';
import { AppError } from '../errors.js';
import type { AnnouncementService, AnnouncementInput } from './announcement-service.js';
import type { LockdownService } from './lockdown-service.js';
import type { GuildSettings } from '../settings.js';

interface DueTask { id: string; guild_id: string; kind: string; payload_json: string; created_by: string; }

export class Scheduler {
  private timer: NodeJS.Timeout | undefined;
  private active = false;
  private stopping = false;
  private idleWaiters: Array<() => void> = [];

  constructor(
    private readonly db: DatabaseHandle,
    private readonly client: Client,
    private readonly announcements: AnnouncementService,
    private readonly lockdown: LockdownService,
  ) {}

  async start(): Promise<void> {
    this.stopping = false;
    if (this.timer) clearInterval(this.timer);
    this.db.prepare(`UPDATE scheduled_tasks SET status = 'pending', updated_at = ? WHERE status = 'running'`)
      .run(new Date().toISOString());
    await this.ensureRetentionTasks();
    this.timer = setInterval(() => { void this.tick(); }, 5_000);
    this.timer.unref();
    await this.tick();
  }

  stop(): void { this.stopping = true; if (this.timer) clearInterval(this.timer); this.timer = undefined; }

  async stopAndDrain(timeoutMs: number): Promise<boolean> {
    this.stop();
    if (!this.active) return true;
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (idle: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.idleWaiters = this.idleWaiters.filter((waiter) => waiter !== onIdle);
        resolve(idle);
      };
      const onIdle = () => finish(true);
      this.idleWaiters.push(onIdle);
      const timeout = setTimeout(() => finish(false), timeoutMs);
      timeout.unref();
    });
  }

  async whenIdle(): Promise<void> {
    if (!this.active) return;
    await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  async refreshRetentionTask(guildId: string): Promise<void> {
    const settings = this.settings(guildId);
    if (!settings.retention.automaticCleanupEnabled) {
      this.db.prepare(`UPDATE scheduled_tasks SET status = 'cancelled', version = version + 1, updated_at = ? WHERE guild_id = ? AND kind = 'retention-cleanup' AND status = 'pending'`)
        .run(new Date().toISOString(), guildId);
      return;
    }
    this.enqueueRetentionTask(guildId, 'system');
  }

  private async ensureRetentionTasks(): Promise<void> {
    const rows = this.db.prepare('SELECT guild_id FROM guild_settings').all() as Array<{ guild_id: string }>;
    for (const { guild_id: guildId } of rows) {
      try { if (this.settings(guildId).retention.automaticCleanupEnabled) this.enqueueRetentionTask(guildId, 'system'); } catch { /* Un server non valido non blocca gli altri. */ }
    }
  }

  private enqueueRetentionTask(guildId: string, actorId: string): void {
    const pending = this.db.prepare(`SELECT 1 FROM scheduled_tasks WHERE guild_id = ? AND kind = 'retention-cleanup' AND status = 'pending'`).get(guildId);
    if (pending) return;
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO scheduled_tasks(id, guild_id, kind, payload_json, run_at, status, created_by, created_at, updated_at)
      VALUES (?, ?, 'retention-cleanup', '{}', ?, 'pending', ?, ?, ?)`)
      .run(randomUUID(), guildId, now, actorId, now, now);
  }

  private async tick(): Promise<void> {
    if (this.active) return;
    this.active = true;
    try {
      for (let index = 0; index < 5; index++) {
        if (this.stopping) break;
        const task = this.claimDueTask();
        if (!task) break;
        try {
          if (task.kind === 'announcement') {
            const payload = JSON.parse(task.payload_json) as AnnouncementInput;
            await this.announcements.executeScheduled(task.guild_id, task.id, payload);
          } else if (task.kind === 'lockdown-end') {
            await this.lockdown.restore(task.guild_id, 'system');
          } else if (task.kind === 'retention-cleanup') {
            await this.runRetentionCleanup(task.guild_id, task.id);
          } else {
            throw new Error(`Tipo di attività non supportato: ${task.kind}`);
          }
          this.complete(task.id);
          if (task.kind === 'retention-cleanup' && this.settings(task.guild_id).retention.automaticCleanupEnabled) {
            const now = new Date(); now.setUTCDate(now.getUTCDate() + 1);
            this.insertTask(task.guild_id, 'retention-cleanup', {}, now.toISOString(), 'system');
          }
        } catch (error) {
          this.fail(task, error);
        }
      }
    } finally {
      this.active = false;
      this.idleWaiters.splice(0).forEach((resolve) => resolve());
    }
  }

  private claimDueTask(): DueTask | null {
    const now = new Date().toISOString();
    const claim = this.db.transaction(() => {
      const row = this.db.prepare(`SELECT id, guild_id, kind, payload_json, created_by FROM scheduled_tasks
        WHERE status = 'pending' AND run_at <= ? ORDER BY run_at LIMIT 1`).get(now) as DueTask | undefined;
      if (!row) return null;
      const result = this.db.prepare(`UPDATE scheduled_tasks SET status = 'running', version = version + 1, updated_at = ?
        WHERE id = ? AND status = 'pending'`).run(now, row.id);
      return result.changes === 1 ? row : null;
    }).immediate();
    return claim;
  }

  private complete(taskId: string): void {
    this.db.prepare(`UPDATE scheduled_tasks SET status = 'completed', version = version + 1, updated_at = ?, last_error = NULL WHERE id = ? AND status = 'running'`)
      .run(new Date().toISOString(), taskId);
  }

  private fail(task: DueTask, error: unknown): void {
    const detail = error instanceof AppError ? error.message.slice(0, 500) : 'Discord non ha completato l’attività programmata. Verifica la connessione e i permessi, poi riprova.';
    this.db.prepare(`UPDATE scheduled_tasks SET status = 'failed', version = version + 1, updated_at = ?, last_error = ? WHERE id = ? AND status = 'running'`)
      .run(new Date().toISOString(), detail, task.id);
    audit(this.db, { guildId: task.guild_id, actorId: 'system', action: `scheduled.${task.kind}`, targetType: 'scheduled-task', targetId: task.id, result: 'failed', after: { error: detail } });
  }

  private async runRetentionCleanup(guildId: string, taskId: string): Promise<void> {
    const settings = this.settings(guildId);
    if (!settings.retention.automaticCleanupEnabled) return;
    const guild = await this.client.guilds.fetch(guildId).catch(() => null);
    if (!guild) throw new Error('Il bot non è più presente nel server.');
    const cutoff = new Date(Date.now() - settings.retention.days * 86_400_000).toISOString();
    const oldTickets = this.db.prepare(`SELECT id, channel_id FROM tickets WHERE guild_id = ? AND status = 'closed' AND closed_at < ?`).all(guildId, cutoff) as Array<{ id: string; channel_id: string | null }>;
    let deletedTickets = 0;
    for (const ticket of oldTickets) {
      if (ticket.channel_id) {
        const channel = await guild.channels.fetch(ticket.channel_id).catch(() => null);
        if (channel) {
          const deleted = await channel.delete('Pulizia programmata oltre il periodo di conservazione').then(() => true).catch(() => false);
          if (!deleted) continue;
        }
      }
      this.db.prepare('DELETE FROM tickets WHERE guild_id = ? AND id = ? AND status = \'closed\'').run(guildId, ticket.id);
      deletedTickets++;
    }
    const failedTickets = this.db.prepare(`SELECT id, channel_id FROM tickets WHERE guild_id = ? AND status = 'failed' AND opened_at < ?`).all(guildId, cutoff) as Array<{ id: string; channel_id: string | null }>;
    for (const ticket of failedTickets) {
      if (ticket.channel_id) {
        const channel = await guild.channels.fetch(ticket.channel_id).catch(() => null);
        if (channel && !(await channel.delete('Pulizia di una creazione ticket fallita oltre il periodo di conservazione').then(() => true).catch(() => false))) continue;
      }
      this.db.prepare('DELETE FROM tickets WHERE guild_id = ? AND id = ? AND status = \'failed\'').run(guildId, ticket.id);
      deletedTickets++;
    }
    const deletedReports = this.db.prepare('DELETE FROM reports WHERE guild_id = ? AND created_at < ?').run(guildId, cutoff).changes;
    const deletedWarnings = this.db.prepare('DELETE FROM warnings WHERE guild_id = ? AND created_at < ?').run(guildId, cutoff).changes;
    const deletedCases = this.db.prepare('DELETE FROM moderation_cases WHERE guild_id = ? AND created_at < ?').run(guildId, cutoff).changes;
    this.db.prepare('DELETE FROM audit_log WHERE guild_id = ? AND created_at < ?').run(guildId, cutoff);
    this.db.prepare(`DELETE FROM scheduled_tasks WHERE guild_id = ? AND status IN ('completed','cancelled','failed') AND updated_at < ?`).run(guildId, cutoff);
    this.db.prepare('DELETE FROM web_sessions WHERE expires_at < ?').run(new Date().toISOString());
    this.db.prepare('DELETE FROM oauth_states WHERE expires_at < ?').run(new Date().toISOString());
    audit(this.db, { guildId, actorId: 'system', action: 'retention.cleanup', targetType: 'guild', targetId: guildId, result: 'ok', after: { taskId, deletedTickets, deletedReports, deletedWarnings, deletedCases, cutoff } });
  }

  private insertTask(guildId: string, kind: string, payload: unknown, runAt: string, createdBy: string): void {
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO scheduled_tasks(id, guild_id, kind, payload_json, run_at, status, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`)
      .run(randomUUID(), guildId, kind, JSON.stringify(payload), runAt, createdBy, now, now);
  }

  private settings(guildId: string): GuildSettings {
    const row = this.db.prepare('SELECT settings_json FROM guild_settings WHERE guild_id = ?').get(guildId) as { settings_json: string } | undefined;
    if (!row) throw new Error('Configurazione server non trovata.');
    return JSON.parse(row.settings_json) as GuildSettings;
  }
}
