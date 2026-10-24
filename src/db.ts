import Database from 'better-sqlite3';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { GuildSettings } from './settings.js';
import { DEFAULT_SETTINGS, parseSettings } from './settings.js';
import { ConflictError, NotFoundError } from './errors.js';

export type DatabaseHandle = Database.Database;

export interface StoredSettings {
  guildId: string;
  settings: GuildSettings;
  version: number;
  updatedAt: string;
  updatedBy: string;
}

export function openDatabase(databasePath: string): DatabaseHandle {
  const absolutePath = databasePath === ':memory:' ? ':memory:' : resolve(process.cwd(), databasePath);
  if (absolutePath !== ':memory:') {
    mkdirSync(resolve(absolutePath, '..'), { recursive: true });
  }
  const db = new Database(absolutePath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

function migrate(db: DatabaseHandle): void {
  const directory = resolve(process.cwd(), 'migrations');
  const files = readdirSync(directory).filter((file) => /^\d+_.*\.sql$/.test(file)).sort();
  let currentVersion = Number(db.pragma('user_version', { simple: true }));
  for (const file of files) {
    const version = Number(file.slice(0, file.indexOf('_')));
    if (version <= currentVersion) continue;
    const sql = readFileSync(resolve(directory, file), 'utf8');
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(sql);
      db.pragma(`user_version = ${version}`);
      db.exec('COMMIT');
      currentVersion = version;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}

export function ensureGuildSettings(db: DatabaseHandle, guildId: string, actorId = 'system'): StoredSettings {
  db.prepare(`INSERT INTO guild_settings(guild_id, settings_json, version, updated_at, updated_by)
    VALUES (?, ?, 1, ?, ?) ON CONFLICT(guild_id) DO NOTHING`)
    .run(guildId, JSON.stringify(DEFAULT_SETTINGS), new Date().toISOString(), actorId);
  return getGuildSettings(db, guildId);
}

export function getGuildSettings(db: DatabaseHandle, guildId: string): StoredSettings {
  const row = db.prepare('SELECT guild_id, settings_json, version, updated_at, updated_by FROM guild_settings WHERE guild_id = ?')
    .get(guildId) as { guild_id: string; settings_json: string; version: number; updated_at: string; updated_by: string } | undefined;
  if (!row) throw new NotFoundError('La configurazione di questo server non è stata inizializzata.');
  return {
    guildId: row.guild_id,
    settings: parseSettings(JSON.parse(row.settings_json) as unknown),
    version: row.version,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}

export function updateGuildSettings(
  db: DatabaseHandle,
  guildId: string,
  settings: GuildSettings,
  actorId: string,
  expectedVersion: number,
): StoredSettings {
  const update = db.transaction(() => {
    const current = getGuildSettings(db, guildId);
    if (current.version !== expectedVersion) throw new ConflictError(`Versione non aggiornata: richiesta ${expectedVersion}, versione corrente ${current.version}.`);
    const now = new Date().toISOString();
    db.prepare(`UPDATE guild_settings SET settings_json = ?, version = version + 1, updated_at = ?, updated_by = ?
      WHERE guild_id = ? AND version = ?`)
      .run(JSON.stringify(settings), now, actorId, guildId, expectedVersion);
    db.prepare(`INSERT INTO audit_log(guild_id, actor_id, action, target_type, target_id, before_json, after_json, result, created_at)
      VALUES (?, ?, 'settings.update', 'guild-settings', ?, ?, ?, 'ok', ?)`)
      .run(guildId, actorId, guildId, JSON.stringify(current.settings), JSON.stringify(settings), now);
    return getGuildSettings(db, guildId);
  }).immediate();
  return update;
}

export function audit(
  db: DatabaseHandle,
  input: { guildId: string; actorId: string; action: string; targetType: string; targetId?: string | null; before?: unknown; after?: unknown; result: 'ok' | 'failed' | 'uncertain'; },
): void {
  db.prepare(`INSERT INTO audit_log(guild_id, actor_id, action, target_type, target_id, before_json, after_json, result, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(input.guildId, input.actorId, input.action, input.targetType, input.targetId ?? null,
      input.before === undefined ? null : JSON.stringify(input.before),
      input.after === undefined ? null : JSON.stringify(input.after), input.result, new Date().toISOString());
}

export function listAuditLog(db: DatabaseHandle, guildId: string, limit = 100): unknown[] {
  return db.prepare(`SELECT id, actor_id AS actorId, action, target_type AS targetType, target_id AS targetId,
      before_json AS before, after_json AS after, result, created_at AS createdAt
    FROM audit_log WHERE guild_id = ? ORDER BY id DESC LIMIT ?`).all(guildId, limit);
}
