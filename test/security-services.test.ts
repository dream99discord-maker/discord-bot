import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { ensureGuildSettings, openDatabase, updateGuildSettings } from '../src/db.js';
import { LockdownService } from '../src/services/lockdown-service.js';
import { ModerationService } from '../src/services/moderation-service.js';
import { SafetyService } from '../src/services/safety-service.js';
import { createFakeDiscord, fakeMessage, IDS, makeFakeChannel } from './helpers/fake-discord.js';

function configure(db: ReturnType<typeof openDatabase>, securityPatch: Record<string, unknown> = {}) {
  const initial = ensureGuildSettings(db, IDS.guild, 'test');
  const settings = structuredClone(initial.settings);
  Object.assign(settings.security, securityPatch);
  updateGuildSettings(db, IDS.guild, settings, 'test', initial.version);
}

test('Il lockdown ripristina il proprio overwrite se non è stato cambiato manualmente', async () => {
  const db = openDatabase(':memory:');
  const { client, guild, channels } = createFakeDiscord();
  const channel = makeFakeChannel(IDS.guild, '888888888888888880', IDS.guild, [{ id: IDS.guild, allow: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.ViewChannel], type: 0 }]);
  channels.set(channel.id, channel);
  ensureGuildSettings(db, IDS.guild, 'test');
  const moderation = new ModerationService(db, client);
  const lockdown = new LockdownService(db, client, moderation);
  try {
    const locked = await lockdown.activate(IDS.guild, IDS.owner);
    assert.equal(locked.changed, 1);
    assert.equal(channel.permissionOverwrites.cache.get(IDS.guild)?.deny.has(PermissionFlagsBits.SendMessages), true);
    const restored = await lockdown.restore(IDS.guild, IDS.owner);
    assert.equal(restored.changed, 1);
    assert.equal(channel.permissionOverwrites.cache.get(IDS.guild)?.allow.has(PermissionFlagsBits.SendMessages), true);
    assert.equal(channel.permissionOverwrites.cache.get(IDS.guild)?.deny.has(PermissionFlagsBits.SendMessages), false);
  } finally { db.close(); }
});

test('Il ripristino del lockdown salta un overwrite modificato manualmente', async () => {
  const db = openDatabase(':memory:');
  const { client, channels } = createFakeDiscord();
  const channel = makeFakeChannel(IDS.guild, '888888888888888881', IDS.guild, [{ id: IDS.guild, allow: [PermissionFlagsBits.SendMessages], type: 0 }]);
  channels.set(channel.id, channel);
  ensureGuildSettings(db, IDS.guild, 'test');
  const moderation = new ModerationService(db, client);
  const lockdown = new LockdownService(db, client, moderation);
  try {
    await lockdown.activate(IDS.guild, IDS.owner);
    await channel.permissionOverwrites.edit(IDS.guild, { AttachFiles: true });
    const result = await lockdown.restore(IDS.guild, IDS.owner);
    assert.equal(result.skipped, 1);
    assert.equal(channel.permissionOverwrites.cache.get(IDS.guild)?.deny.has(PermissionFlagsBits.SendMessages), true);
    assert.equal(channel.permissionOverwrites.cache.get(IDS.guild)?.allow.has(PermissionFlagsBits.AttachFiles), true);
  } finally { db.close(); }
});

test('Il blocco di un canale è registrato e non sovrascrive cambi manuali successivi', async () => {
  const db = openDatabase(':memory:');
  const { client, channels } = createFakeDiscord();
  const channel = makeFakeChannel(IDS.guild, '888888888888888882', IDS.guild, [{ id: IDS.guild, allow: [PermissionFlagsBits.SendMessages], type: 0 }]);
  channels.set(channel.id, channel);
  ensureGuildSettings(db, IDS.guild, 'test');
  const moderation = new ModerationService(db, client);
  const lockdown = new LockdownService(db, client, moderation);
  try {
    const result = await lockdown.lockChannel(IDS.guild, IDS.owner, channel.id, 'Manutenzione pianificata');
    assert.equal(result.changed, true);
    const blocked = await lockdown.unlockChannel(IDS.guild, IDS.owner, channel.id, 'Manutenzione conclusa');
    assert.equal(blocked.changed, true);
    const relocked = await lockdown.lockChannel(IDS.guild, IDS.owner, channel.id, 'Secondo test');
    assert.equal(relocked.changed, true);
    await channel.permissionOverwrites.edit(IDS.guild, { AttachFiles: true });
    const skipped = await lockdown.unlockChannel(IDS.guild, IDS.owner, channel.id, 'Ripristino dopo il test');
    assert.deepEqual(skipped, { changed: false, skipped: true });
    assert.equal(channel.permissionOverwrites.cache.get(IDS.guild)?.deny.has(PermissionFlagsBits.SendMessages), true);
  } finally { db.close(); }
});

test('Le regole anti-spam non si attivano per parole simili a Roblox e la modalità osservazione non cancella', async () => {
  const db = openDatabase(':memory:');
  const { client, guild } = createFakeDiscord();
  configure(db, { blockedDomains: ['roblox.com', 'malware.example'], mode: 'observe', automatedActionsEnabled: true });
  const moderation = new ModerationService(db, client);
  const lockdown = new LockdownService(db, client, moderation);
  const service = new SafetyService(db, client, lockdown);
  try {
    const similar = fakeMessage(guild, IDS.otherUser, '888888888888888883', 'https://roblox-malware.example/offer');
    await service.handleMessage(similar as never);
    const clean = db.prepare('SELECT COUNT(*) AS amount FROM audit_log WHERE guild_id = ? AND action = \'security.detect\'').get(IDS.guild) as { amount: number };
    assert.equal(clean.amount, 0);

    const blocked = fakeMessage(guild, IDS.otherUser, '888888888888888883', 'https://sub.malware.example/path');
    await service.handleMessage(blocked as never);
    const row = db.prepare('SELECT after_json FROM audit_log WHERE guild_id = ? AND action = \'security.detect\' ORDER BY id DESC LIMIT 1').get(IDS.guild) as { after_json: string };
    assert.match(row.after_json, /dominio_bloccato/);
    assert.match(row.after_json, /nessuna_azione/);
  } finally { db.close(); }
});

test('Un account recente è soltanto un segnale e non produce ban automatici', async () => {
  const db = openDatabase(':memory:');
  const { client, guild } = createFakeDiscord();
  configure(db, { newAccountDays: 3, joinSpikeCount: 100, mode: 'enforce', automatedActionsEnabled: true });
  const moderation = new ModerationService(db, client);
  const lockdown = new LockdownService(db, client, moderation);
  const service = new SafetyService(db, client, lockdown);
  try {
    const timestamp = BigInt(Date.now() - 60 * 60_000 - 1_420_070_400_000);
    const memberId = String(timestamp << 22n);
    const member = { id: memberId, guild, user: { id: memberId } };
    await service.handleMemberJoin(member as never);
    const row = db.prepare('SELECT after_json FROM audit_log WHERE guild_id = ? AND action = \'security.join.detect\'').get(IDS.guild) as { after_json: string };
    assert.match(row.after_json, /account_recente_segnale/);
    assert.match(row.after_json, /nessuna_sanzione_automatica/);
    assert.equal((db.prepare("SELECT COUNT(*) AS amount FROM moderation_cases WHERE guild_id = ? AND action = 'ban'").get(IDS.guild) as { amount: number }).amount, 0);
  } finally { db.close(); }
});
