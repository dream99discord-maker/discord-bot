import test from 'node:test';
import assert from 'node:assert/strict';
import type { GuildMember } from 'discord.js';
import { ensureGuildSettings, openDatabase, updateGuildSettings } from '../src/db.js';
import { AuthorizationError, ConflictError, NotFoundError } from '../src/errors.js';
import { ModerationService } from '../src/services/moderation-service.js';
import { createFakeDiscord, IDS } from './helpers/fake-discord.js';

test('I permessi di moderazione vengono ricontrollati e un ruolo revocato perde subito accesso', async () => {
  const db = openDatabase(':memory:');
  const { client, members } = createFakeDiscord();
  const initial = ensureGuildSettings(db, IDS.guild, 'test');
  const configured = structuredClone(initial.settings);
  configured.permissions.roles.moderate = [IDS.staffRole];
  updateGuildSettings(db, IDS.guild, configured, 'test', initial.version);
  const service = new ModerationService(db, client);
  try {
    assert.equal(await service.canModerate(IDS.guild, IDS.user), true);
    const guild = await client.guilds.fetch(IDS.guild);
    const actor = await guild!.members.fetch(IDS.user) as unknown as GuildMember;
    actor.roles.cache.clear();
    assert.equal(await service.canModerate(IDS.guild, IDS.user), false);
    const role = await guild!.roles.fetch(IDS.staffRole);
    actor.roles.cache.set(IDS.staffRole, role as never);
    assert.equal(await service.canModerate(IDS.guild, IDS.user), true);
    const current = ensureGuildSettings(db, IDS.guild, 'test');
    const revoked = structuredClone(current.settings);
    revoked.permissions.roles.moderate = [];
    updateGuildSettings(db, IDS.guild, revoked, 'test', current.version);
    assert.equal(await service.canModerate(IDS.guild, IDS.user), false);
  } finally { db.close(); }
});

test('Gerarchia insufficiente e conferme scadute o usate da altri operatori bloccano l’azione', async () => {
  const db = openDatabase(':memory:');
  const { client, guild } = createFakeDiscord();
  const initial = ensureGuildSettings(db, IDS.guild, 'test');
  const settings = structuredClone(initial.settings);
  settings.permissions.roles.moderate = [IDS.staffRole];
  updateGuildSettings(db, IDS.guild, settings, 'test', initial.version);
  const service = new ModerationService(db, client);
  try {
    const target = await guild.members.fetch(IDS.otherUser) as unknown as GuildMember;
    (target.roles as unknown as { highest: { id: string; position: number; comparePositionTo: (other: { position?: number }) => number } }).highest = {
      id: '999999999999999999', position: 20, comparePositionTo: (other) => 20 - (other.position ?? 0),
    };
    await assert.rejects(() => service.timeout(IDS.guild, IDS.user, IDS.otherUser, 5, 'Motivo di prova'), AuthorizationError);

    const expiredId = '99999999-9999-4999-8999-999999999999';
    db.prepare('INSERT INTO confirmations(id, guild_id, actor_id, action_json, expires_at) VALUES (?, ?, ?, ?, ?)')
      .run(expiredId, IDS.guild, IDS.user, JSON.stringify({ type: 'ban', targetId: IDS.otherUser, reason: 'Motivo' }), new Date(Date.now() - 1000).toISOString());
    await assert.rejects(() => service.confirm(IDS.guild, IDS.user, expiredId), ConflictError);
    await assert.rejects(() => service.confirm(IDS.guild, IDS.otherUser, expiredId), NotFoundError);
  } finally { db.close(); }
});
