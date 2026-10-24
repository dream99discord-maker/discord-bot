import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { ensureGuildSettings, openDatabase } from '../src/db.js';
import { createApiServer } from '../src/api/server.js';
import { TicketService } from '../src/services/ticket-service.js';
import { ReportService } from '../src/services/report-service.js';
import { ModerationService } from '../src/services/moderation-service.js';
import { AnnouncementService } from '../src/services/announcement-service.js';
import { LockdownService } from '../src/services/lockdown-service.js';
import { SafetyService } from '../src/services/safety-service.js';
import { Scheduler } from '../src/services/scheduler.js';
import { createFakeDiscord, IDS } from './helpers/fake-discord.js';

test('Senza credenziali OAuth le API amministrative restano inaccessibili', async () => {
  const db = openDatabase(':memory:');
  const { client } = createFakeDiscord();
  const config = loadConfig({ NODE_ENV: 'test', DATABASE_PATH: ':memory:', CORS_ORIGINS: 'http://localhost:5173' });
  ensureGuildSettings(db, IDS.guild, 'test');
  const tickets = new TicketService(db, client);
  const reports = new ReportService(db, client);
  const moderation = new ModerationService(db, client);
  const announcements = new AnnouncementService(db, client);
  const lockdown = new LockdownService(db, client, moderation);
  const safety = new SafetyService(db, client, lockdown);
  const scheduler = new Scheduler(db, client, announcements, lockdown);
  const app = await createApiServer({ db, client, config, tickets, reports, moderation, announcements, lockdown, safety, scheduler });
  try {
    const health = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(health.statusCode, 200);
    assert.equal(health.json().oauthEnabled, false);

    const login = await app.inject({ method: 'GET', url: '/api/v1/auth/discord' });
    assert.equal(login.statusCode, 503);

    const install = await app.inject({ method: 'GET', url: '/api/v1/auth/discord/install' });
    assert.equal(install.statusCode, 503);

    const guildList = await app.inject({ method: 'GET', url: '/api/v1/guilds' });
    assert.equal(guildList.statusCode, 503);
    assert.equal(guildList.json().error.code, 'OAUTH_NON_CONFIGURATO');

    const publicShutdown = await app.inject({ method: 'POST', url: '/api/v1/shutdown' });
    assert.equal(publicShutdown.statusCode, 404);

    const adminSettings = await app.inject({ method: 'GET', url: `/api/v1/guilds/${IDS.guild}/settings` });
    assert.equal(adminSettings.statusCode, 503);

    const mutation = await app.inject({ method: 'PATCH', url: `/api/v1/guilds/${IDS.guild}/settings`, payload: { expectedVersion: 1, settings: { general: { name: 'non autorizzato' } } } });
    assert.equal(mutation.statusCode, 503);
    assert.equal((db.prepare('SELECT version FROM guild_settings WHERE guild_id = ?').get(IDS.guild) as { version: number }).version, 1);

    const spec = await app.inject({ method: 'GET', url: '/docs/openapi.yaml' });
    assert.equal(spec.statusCode, 200);
    assert.match(spec.body, /openapi: 3\.1\.0/);
  } finally {
    await app.close();
    db.close();
    client.destroy();
  }
});

test('L’invito bot usa code grant, PKCE e callback registrato', async () => {
  const db = openDatabase(':memory:');
  const { client } = createFakeDiscord();
  const config = loadConfig({
    NODE_ENV: 'test', DATABASE_PATH: ':memory:', CORS_ORIGINS: 'http://localhost:5173',
    DISCORD_CLIENT_ID: '777777777777777777', DISCORD_CLIENT_SECRET: 'client-secret-test',
    SESSION_SECRET: 's'.repeat(48), OAUTH_TOKEN_ENCRYPTION_KEY: 'e'.repeat(48),
  });
  const tickets = new TicketService(db, client);
  const reports = new ReportService(db, client);
  const moderation = new ModerationService(db, client);
  const announcements = new AnnouncementService(db, client);
  const lockdown = new LockdownService(db, client, moderation);
  const safety = new SafetyService(db, client, lockdown);
  const scheduler = new Scheduler(db, client, announcements, lockdown);
  const app = await createApiServer({ db, client, config, tickets, reports, moderation, announcements, lockdown, safety, scheduler });
  try {
    const response = await app.inject({ method: 'GET', url: `/api/v1/auth/discord/install?guild_id=${IDS.guild}` });
    assert.equal(response.statusCode, 302);
    const authorization = new URL(response.headers.location!);
    assert.equal(authorization.searchParams.get('client_id'), '777777777777777777');
    assert.equal(authorization.searchParams.get('response_type'), 'code');
    assert.equal(authorization.searchParams.get('redirect_uri'), config.DISCORD_REDIRECT_URI);
    assert.deepEqual(new Set(authorization.searchParams.get('scope')!.split(' ')), new Set(['bot', 'applications.commands', 'identify', 'guilds']));
    assert.equal(authorization.searchParams.get('guild_id'), IDS.guild);
    assert.equal(authorization.searchParams.get('disable_guild_select'), 'true');
    assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
    assert.ok(authorization.searchParams.get('code_challenge'));
    const stateCookie = String(response.headers['set-cookie']);
    assert.match(stateCookie, /tlpg_oauth_state=[^;]+/);
    assert.match(stateCookie, /Path=\/api\/v1\/auth\/discord\/callback/);
    assert.match(stateCookie, /HttpOnly/);
  } finally {
    await app.close();
    db.close();
    client.destroy();
  }
});
