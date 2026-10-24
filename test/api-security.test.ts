import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/db.js';
import { createApiServer } from '../src/api/server.js';
import { TicketService } from '../src/services/ticket-service.js';
import { ReportService } from '../src/services/report-service.js';
import { ModerationService } from '../src/services/moderation-service.js';
import { AnnouncementService } from '../src/services/announcement-service.js';
import { LockdownService } from '../src/services/lockdown-service.js';
import { SafetyService } from '../src/services/safety-service.js';
import { Scheduler } from '../src/services/scheduler.js';
import { randomToken, signPayload } from '../src/security.js';
import { createFakeDiscord, IDS } from './helpers/fake-discord.js';

const origin = 'https://guardian.example.test';

test('La configurazione di produzione rifiuta origini HTTP o callback OAuth su un host diverso', () => {
  assert.throws(() => loadConfig({ NODE_ENV: 'production', APP_BASE_URL: 'http://guardian.example.test', DISCORD_REDIRECT_URI: 'http://guardian.example.test/api/v1/auth/discord/callback', CORS_ORIGINS: 'http://guardian.example.test' }), /HTTPS/);
  assert.throws(() => loadConfig({ NODE_ENV: 'production', APP_BASE_URL: origin, DISCORD_REDIRECT_URI: 'https://oauth.example.test/api/v1/auth/discord/callback', CORS_ORIGINS: origin }), /stessa origine/);
});

function config(oauth = true, requestBodyLimit = 16_384) {
  return loadConfig({
    NODE_ENV: 'production', DATABASE_PATH: ':memory:', APP_BASE_URL: origin,
    DISCORD_REDIRECT_URI: `${origin}/api/v1/auth/discord/callback`, CORS_ORIGINS: origin,
    REQUEST_BODY_LIMIT_BYTES: String(requestBodyLimit),
    ...(oauth ? {
      DISCORD_CLIENT_ID: '777777777777777777', DISCORD_CLIENT_SECRET: 'client-secret-test',
      SESSION_SECRET: 's'.repeat(48), OAUTH_TOKEN_ENCRYPTION_KEY: 'e'.repeat(48),
    } : {}),
  });
}

function apiServices(db: ReturnType<typeof openDatabase>, client: ReturnType<typeof createFakeDiscord>['client'], appConfig: ReturnType<typeof config>) {
  const tickets = new TicketService(db, client);
  const reports = new ReportService(db, client);
  const moderation = new ModerationService(db, client);
  const announcements = new AnnouncementService(db, client);
  const lockdown = new LockdownService(db, client, moderation);
  const safety = new SafetyService(db, client, lockdown);
  const scheduler = new Scheduler(db, client, announcements, lockdown);
  return { db, client, config: appConfig, tickets, reports, moderation, announcements, lockdown, safety, scheduler };
}

test('Fastify limita body, imposta intestazioni e non pubblica database o percorsi del progetto', async () => {
  const db = openDatabase(':memory:');
  const { client } = createFakeDiscord();
  const app = await createApiServer(apiServices(db, client, config(true)));
  try {
    const health = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(health.statusCode, 200);
    assert.match(String(health.headers['content-security-policy']), /default-src 'self'/);
    assert.ok(health.headers['strict-transport-security']);
    assert.equal(health.headers['x-content-type-options'], 'nosniff');

    for (const url of ['/data/guardian.sqlite', '/../../.env', '/../../src/index.ts']) {
      const response = await app.inject({ method: 'GET', url });
      assert.equal(response.statusCode, 200);
      assert.match(response.body, /<!doctype html>/i);
      assert.doesNotMatch(response.body, /BOT_TOKEN|sqlite format/i);
    }

    const oversized = await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { 'content-type': 'application/json' }, payload: { value: 'x'.repeat(17_000) } });
    assert.equal(oversized.statusCode, 413);
    assert.equal(oversized.json().error.code, 'RICHIESTA_TROPPO_GRANDE');
    const protectedDownload = await app.inject({ method: 'GET', url: `/api/v1/guilds/${IDS.guild}/tickets/${'a3dd8b64-4428-4dd8-8d23-a9c95d5e6789'}/transcript/download` });
    assert.equal(protectedDownload.statusCode, 401);
  } finally {
    await app.close(); db.close(); client.destroy();
  }
});

test('OAuth verifica state, usa cookie Secure in produzione e logout revoca davvero la sessione', async () => {
  const db = openDatabase(':memory:');
  const { client } = createFakeDiscord();
  const appConfig = config(true);
  const app = await createApiServer(apiServices(db, client, appConfig));
  const originalFetch = globalThis.fetch;
  try {
    const badCallback = await app.inject({ method: 'GET', url: '/api/v1/auth/discord/callback?code=codice&state=stato&iss=https%3A%2F%2Fdiscord.com' });
    assert.equal(badCallback.statusCode, 401);
    assert.equal(badCallback.json().error.code, 'OAUTH_STATE_NON_VALIDO');

    const authorizationStart = await app.inject({ method: 'GET', url: '/api/v1/auth/discord' });
    assert.equal(authorizationStart.statusCode, 302);
    const authorizationUrl = new URL(authorizationStart.headers.location!);
    const state = authorizationUrl.searchParams.get('state')!;
    const stateCookie = String(authorizationStart.headers['set-cookie']);
    assert.match(stateCookie, /HttpOnly/);
    assert.match(stateCookie, /Secure/);
    assert.match(stateCookie, /SameSite=Lax/i);

    globalThis.fetch = async (input) => {
      const requestUrl = String(input);
      if (requestUrl.includes('/oauth2/token')) return new Response(JSON.stringify({
        access_token: 'oauth-access-test', token_type: 'Bearer', expires_in: 3600, refresh_token: 'oauth-refresh-test', scope: 'identify guilds',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
      if (requestUrl.endsWith('/users/@me')) return new Response(JSON.stringify({ id: IDS.owner, username: 'proprietario', global_name: 'Proprietario' }), { status: 200, headers: { 'content-type': 'application/json' } });
      throw new Error('endpoint non previsto nel test');
    };
    const callback = await app.inject({ method: 'GET', url: `/api/v1/auth/discord/callback?code=codice&state=${encodeURIComponent(state)}&iss=https%3A%2F%2Fdiscord.com`, headers: { cookie: stateCookie.split(';')[0] } });
    assert.equal(callback.statusCode, 302);
    const sessionCookie = String(callback.headers['set-cookie']).split(',').find((cookie) => cookie.includes('tlpg_session='));
    assert.ok(sessionCookie);
    assert.match(sessionCookie!, /HttpOnly/);
    assert.match(sessionCookie!, /Secure/);
    assert.match(sessionCookie!, /SameSite=Lax/i);

    const rawSession = sessionCookie!.match(/tlpg_session=([^;]+)/)?.[1];
    assert.ok(rawSession);
    const idHash = signPayload(rawSession!, appConfig.SESSION_SECRET!);
    const csrf = (db.prepare('SELECT csrf_token FROM web_sessions WHERE id_hash = ?').get(idHash) as { csrf_token: string }).csrf_token;

    const rejectedLogout = await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { cookie: `tlpg_session=${rawSession}`, 'x-csrf-token': 'wrong' } });
    assert.equal(rejectedLogout.statusCode, 403);
    assert.ok(db.prepare('SELECT 1 FROM web_sessions WHERE id_hash = ?').get(idHash));

    const logout = await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { cookie: `tlpg_session=${rawSession}`, 'x-csrf-token': csrf } });
    assert.equal(logout.statusCode, 204);
    assert.equal(db.prepare('SELECT 1 FROM web_sessions WHERE id_hash = ?').get(idHash), undefined);
    const afterLogout = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: `tlpg_session=${rawSession}` } });
    assert.equal(afterLogout.statusCode, 401);
  } finally {
    globalThis.fetch = originalFetch;
    await app.close(); db.close(); client.destroy();
  }
});

test('La sessione scaduta viene rimossa dal database', async () => {
  const db = openDatabase(':memory:');
  const { client } = createFakeDiscord();
  const appConfig = config(true);
  const app = await createApiServer(apiServices(db, client, appConfig));
  try {
    const rawSession = randomToken(32);
    const idHash = signPayload(rawSession, appConfig.SESSION_SECRET!);
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO web_sessions(id_hash, user_id, access_token_enc, refresh_token_enc, csrf_token, access_expires_at, expires_at, created_at, last_seen_at)
      VALUES (?, ?, 'non-usato', NULL, 'csrf-test', ?, ?, ?, ?)`)
      .run(idHash, IDS.owner, now, new Date(Date.now() - 1000).toISOString(), now, now);
    const response = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: `tlpg_session=${rawSession}` } });
    assert.equal(response.statusCode, 401);
    assert.equal(db.prepare('SELECT 1 FROM web_sessions WHERE id_hash = ?').get(idHash), undefined);
  } finally {
    await app.close(); db.close(); client.destroy();
  }
});
