import test from 'node:test';
import assert from 'node:assert/strict';
import { ConflictError } from '../src/errors.js';
import { ensureGuildSettings, getGuildSettings, openDatabase, updateGuildSettings } from '../src/db.js';
import { mergeSettings } from '../src/settings.js';

test('Le migrazioni SQLite inizializzano il database e isolano le configurazioni per server', () => {
  const db = openDatabase(':memory:');
  try {
    assert.equal(db.pragma('user_version', { simple: true }), 4);
    const first = ensureGuildSettings(db, '111111111111111111', 'test');
    const second = ensureGuildSettings(db, '222222222222222222', 'test');
    const changed = mergeSettings(first.settings, { general: { name: 'Guardian test' } });
    const saved = updateGuildSettings(db, first.guildId, changed, 'operator', first.version);
    assert.equal(saved.version, 2);
    assert.equal(getGuildSettings(db, first.guildId).settings.general.name, 'Guardian test');
    assert.equal(getGuildSettings(db, second.guildId).settings.general.name, 'The Last Pact Guardian');
    assert.throws(() => updateGuildSettings(db, first.guildId, changed, 'operator', first.version), ConflictError);
  } finally { db.close(); }
});

test('La configurazione rifiuta campi sconosciuti e domini scritti come URL', () => {
  const db = openDatabase(':memory:');
  try {
    const current = ensureGuildSettings(db, '111111111111111111');
    assert.throws(() => mergeSettings(current.settings, { general: { adminPassword: 'no' } }));
    assert.throws(() => mergeSettings(current.settings, { security: { blockedDomains: ['https://example.test/path'] } }));
  } finally { db.close(); }
});
