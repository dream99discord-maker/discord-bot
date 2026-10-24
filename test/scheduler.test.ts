import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PermissionFlagsBits } from 'discord.js';
import { ensureGuildSettings, openDatabase, updateGuildSettings } from '../src/db.js';
import { AnnouncementService } from '../src/services/announcement-service.js';
import { LockdownService } from '../src/services/lockdown-service.js';
import { ModerationService } from '../src/services/moderation-service.js';
import { Scheduler } from '../src/services/scheduler.js';
import { createFakeDiscord, IDS, makeFakeChannel } from './helpers/fake-discord.js';

test('Dopo un arresto il pianificatore recupera un annuncio running senza duplicarlo', async () => {
  const db = openDatabase(':memory:');
  const { client, channels } = createFakeDiscord();
  const channel = makeFakeChannel(IDS.guild, '888888888888888884', IDS.guild);
  channels.set(channel.id, channel);
  const initial = ensureGuildSettings(db, IDS.guild, 'test');
  const settings = structuredClone(initial.settings);
  settings.channels.announcements = channel.id;
  updateGuildSettings(db, IDS.guild, settings, 'test', initial.version);
  const announcements = new AnnouncementService(db, client);
  const moderation = new ModerationService(db, client);
  const lockdown = new LockdownService(db, client, moderation);
  const scheduler = new Scheduler(db, client, announcements, lockdown);
  const taskId = randomUUID();
  const now = new Date().toISOString();
  const input = { type: 'evento' as const, title: 'Evento community', content: 'Inizio alle 20:00.', roleIds: [] };
  try {
    const firstMessageId = await announcements.executeScheduled(IDS.guild, taskId, input);
    assert.equal(channel.sent.length, 1);
    db.prepare(`INSERT INTO scheduled_tasks(id, guild_id, kind, payload_json, run_at, status, created_by, created_at, updated_at)
      VALUES (?, ?, 'announcement', ?, ?, 'running', ?, ?, ?)`)
      .run(taskId, IDS.guild, JSON.stringify(input), new Date(Date.now() - 1000).toISOString(), IDS.owner, now, now);

    await scheduler.start();
    scheduler.stop();
    const task = db.prepare('SELECT status FROM scheduled_tasks WHERE id = ?').get(taskId) as { status: string };
    assert.equal(task.status, 'completed');
    assert.equal(channel.sent.length, 1);
    assert.equal(channel.sentMessages[0]?.id, firstMessageId);
  } finally {
    scheduler.stop();
    db.close();
  }
});
