import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { OperationCoordinator } from '../src/services/operation-coordinator.js';
import { openDatabase } from '../src/db.js';
import { AnnouncementService } from '../src/services/announcement-service.js';
import { LockdownService } from '../src/services/lockdown-service.js';
import { ModerationService } from '../src/services/moderation-service.js';
import { Scheduler } from '../src/services/scheduler.js';
import { createFakeDiscord, IDS } from './helpers/fake-discord.js';

test('Il drain impedisce nuovi lavori, conserva quelli attivi e consente la chiusura dopo l’idle', async () => {
  const coordinator = new OperationCoordinator();
  let finish!: () => void;
  let completed = false;
  const active = coordinator.run(async () => {
    await new Promise<void>((resolve) => { finish = resolve; });
    completed = true;
  });
  await Promise.resolve();
  coordinator.stopAccepting();
  await assert.rejects(() => coordinator.run(async () => undefined), /arrestando/);
  assert.equal(await coordinator.waitForIdle(5), false);
  assert.equal(coordinator.activeCount, 1);
  finish();
  await active;
  await coordinator.whenIdle();
  assert.equal(completed, true);
  assert.equal(coordinator.activeCount, 0);
});

test('Il pianificatore si ferma, drena un annuncio attivo e lo marca completato prima della chiusura DB', async () => {
  const db = openDatabase(':memory:');
  const { client } = createFakeDiscord();
  const announcements = new AnnouncementService(db, client);
  const moderation = new ModerationService(db, client);
  const lockdown = new LockdownService(db, client, moderation);
  const scheduler = new Scheduler(db, client, announcements, lockdown);
  let begin!: () => void;
  let finish!: () => void;
  const started = new Promise<void>((resolve) => { begin = resolve; });
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  announcements.executeScheduled = async () => { begin(); await pending; return 'message-id'; };
  const taskId = randomUUID();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO scheduled_tasks(id, guild_id, kind, payload_json, run_at, status, created_by, created_at, updated_at)
    VALUES (?, ?, 'announcement', ?, ?, 'pending', ?, ?, ?)`)
    .run(taskId, IDS.guild, JSON.stringify({ type: 'annuncio', title: 'Test', content: 'Test', roleIds: [], channelId: '777777777777777778' }), now, IDS.owner, now, now);
  try {
    const start = scheduler.start();
    await started;
    assert.equal(await scheduler.stopAndDrain(5), false);
    finish();
    await start;
    await scheduler.whenIdle();
    const task = db.prepare('SELECT status FROM scheduled_tasks WHERE id = ?').get(taskId) as { status: string };
    assert.equal(task.status, 'completed');
  } finally {
    scheduler.stop(); db.close(); client.destroy();
  }
});
