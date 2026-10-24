import test from 'node:test';
import assert from 'node:assert/strict';
import type { Client } from 'discord.js';
import { ensureGuildSettings, openDatabase } from '../src/db.js';
import { NotFoundError } from '../src/errors.js';
import { ReportService } from '../src/services/report-service.js';
import { IDS } from './helpers/fake-discord.js';

test('Le segnalazioni sono associate al server, conservano lo stato e non si leggono da un altro server', async () => {
  const db = openDatabase(':memory:');
  const client = { guilds: { fetch: async () => null }, users: { fetch: async () => null } } as unknown as Client;
  try {
    ensureGuildSettings(db, IDS.guild, 'test');
    const service = new ReportService(db, client);
    const report = await service.create({ guildId: IDS.guild, reporterId: IDS.user, category: 'bug', description: 'Il portale si blocca dopo il caricamento.', evidence: 'https://example.invalid/prova' });
    assert.match(report.id, /^RPT-/);
    assert.equal(report.status, 'new');
    assert.equal(report.confidential, false);
    assert.throws(() => service.get('222222222222222222', report.id), NotFoundError);
    assert.equal(service.history(IDS.guild, report.id)[0]?.eventType, 'created');
  } finally { db.close(); }
});

test('Le segnalazioni riservate sono separate dai risultati ordinari', async () => {
  const db = openDatabase(':memory:');
  const client = { guilds: { fetch: async () => null }, users: { fetch: async () => null } } as unknown as Client;
  try {
    ensureGuildSettings(db, IDS.guild, 'test');
    const service = new ReportService(db, client);
    const report = await service.create({ guildId: IDS.guild, reporterId: IDS.user, category: 'staff', description: 'Segnalazione riservata allo staff.', confidential: true });
    assert.equal(report.confidential, true);
    assert.deepEqual(service.list(IDS.guild).map((item) => item.id), []);
    assert.deepEqual(service.list(IDS.guild, { confidential: true }).map((item) => item.id), [report.id]);
  } finally { db.close(); }
});
