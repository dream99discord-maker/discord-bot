import { loadConfig } from '../src/config.js';
import { ensureGuildSettings, getGuildSettings, openDatabase, updateGuildSettings } from '../src/db.js';
import { DEFAULT_SETTINGS } from '../src/settings.js';

const guildId = process.argv[2];
if (!guildId || !/^\d{17,20}$/.test(guildId)) throw new Error('Uso: npm run config:import -- <ID_SERVER> [--replace]');
const config = loadConfig();
const db = openDatabase(config.DATABASE_PATH);
const existing = db.prepare('SELECT 1 FROM guild_settings WHERE guild_id = ?').get(guildId);
if (!existing) {
  ensureGuildSettings(db, guildId, 'local-import');
  console.info(`Configurazione iniziale importata per il server ${guildId}.`);
} else if (process.argv.includes('--replace')) {
  const current = getGuildSettings(db, guildId);
  updateGuildSettings(db, guildId, DEFAULT_SETTINGS, 'local-import', current.version);
  console.info(`Configurazione iniziale sostituita per il server ${guildId}.`);
} else {
  console.info(`La configurazione per il server ${guildId} esiste già. Usa --replace per sostituirla.`);
}
db.close();
