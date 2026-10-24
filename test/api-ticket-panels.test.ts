import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/db.js';
import { createApiServer } from '../src/api/server.js';
import { deriveKey, encryptSecret, signPayload } from '../src/security.js';
import { TicketService } from '../src/services/ticket-service.js';
import { TicketPanelService, type ManagedTicketPanelInput } from '../src/services/ticket-panel-service.js';
import { ReportService } from '../src/services/report-service.js';
import { ModerationService } from '../src/services/moderation-service.js';
import { AnnouncementService } from '../src/services/announcement-service.js';
import { LockdownService } from '../src/services/lockdown-service.js';
import { SafetyService } from '../src/services/safety-service.js';
import { Scheduler } from '../src/services/scheduler.js';
import { createFakeDiscord, IDS } from './helpers/fake-discord.js';

test('La dashboard crea pannelli tramite API idempotenti e non accede a server diversi', async () => {
  const db = openDatabase(':memory:');
  const { client, channels } = createFakeDiscord();
  const config = loadConfig({
    NODE_ENV: 'test', DATABASE_PATH: ':memory:', APP_BASE_URL: 'http://localhost:5173',
    DISCORD_REDIRECT_URI: 'http://localhost:3000/api/v1/auth/discord/callback', CORS_ORIGINS: 'http://localhost:5173',
    DISCORD_CLIENT_ID: '777777777777777777', DISCORD_CLIENT_SECRET: 'client-secret-test',
    SESSION_SECRET: 's'.repeat(48), OAUTH_TOKEN_ENCRYPTION_KEY: 'e'.repeat(48),
  });
  const token = 'session-token-test';
  const csrf = 'csrf-token-test';
  const idHash = signPayload(token, config.SESSION_SECRET!);
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO web_sessions(id_hash, user_id, access_token_enc, refresh_token_enc, csrf_token, access_expires_at, expires_at, created_at, last_seen_at)
    VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)`)
    .run(idHash, IDS.owner, encryptSecret('oauth-access-test', deriveKey(config.OAUTH_TOKEN_ENCRYPTION_KEY!)), csrf,
      new Date(Date.now() + 60 * 60_000).toISOString(), new Date(Date.now() + 24 * 60 * 60_000).toISOString(), now, now);
  const tickets = new TicketService(db, client);
  const ticketPanels = new TicketPanelService(db, client);
  const reports = new ReportService(db, client);
  const moderation = new ModerationService(db, client);
  const announcements = new AnnouncementService(db, client);
  const lockdown = new LockdownService(db, client, moderation);
  const safety = new SafetyService(db, client, lockdown);
  const scheduler = new Scheduler(db, client, announcements, lockdown);
  const app = await createApiServer({ db, client, config, tickets, ticketPanels, reports, moderation, announcements, lockdown, safety, scheduler });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    if (String(input).includes('/users/@me/guilds')) return new Response(JSON.stringify([
      { id: IDS.guild, name: 'Server test', owner: true, permissions: '0', icon: null },
    ]), { status: 200, headers: { 'content-type': 'application/json' } });
    throw new Error('endpoint non previsto nel test');
  };
  const input: ManagedTicketPanelInput = {
    name: 'Assistenza via API', panelTitle: 'Apri ticket', description: 'Scegli un tipo.', color: '#5865f2', footer: 'Guardian', layout: 'menu',
    panelCategory: { mode: 'create', name: 'supporto' }, panelChannel: { mode: 'create', name: 'apri-ticket' },
    ticketCategory: { mode: 'create', name: 'ticket-privati' }, staffRoleIds: [IDS.staffRole],
    maxOpenPerUser: 1, maxConcurrentTotal: 25, cooldownSeconds: 0,
    categories: [{ key: 'aiuto', label: 'Aiuto', description: 'Richiesta di supporto', staffRoleIds: [], fields: [{ key: 'descrizione', label: 'Descrizione', style: 'paragraph', required: true }] }],
  };
  try {
    const key = randomUUID();
    const request = () => app.inject({ method: 'POST', url: `/api/v1/guilds/${IDS.guild}/tickets/panels`, headers: { cookie: `tlpg_session=${token}`, 'x-csrf-token': csrf, 'idempotency-key': key }, payload: input });
    const [first, retry] = await Promise.all([request(), request()]);
    assert.equal(first.statusCode, 200);
    assert.ok([200, 202].includes(retry.statusCode));
    const firstResult = first.json() as { status: string; panel?: { id: string } };
    assert.equal(firstResult.status, 'completed');
    assert.ok(firstResult.panel?.id);
    const finalRetry = await request();
    assert.equal((finalRetry.json() as { panel: { id: string } }).panel.id, firstResult.panel!.id);
    assert.equal(ticketPanels.list(IDS.guild).length, 1);
    assert.equal(channels.size, 3);

    const listed = await app.inject({ method: 'GET', url: `/api/v1/guilds/${IDS.guild}/tickets/panels`, headers: { cookie: `tlpg_session=${token}` } });
    assert.equal(listed.statusCode, 200);
    const listedPanel = (listed.json() as { panels: Array<{ status: string; health: { missing: string[] } }> }).panels[0];
    assert.equal(listedPanel?.status, 'active');
    assert.deepEqual(listedPanel?.health.missing, []);

    const foreign = await app.inject({ method: 'GET', url: `/api/v1/guilds/222222222222222222/tickets/panels`, headers: { cookie: `tlpg_session=${token}` } });
    assert.equal(foreign.statusCode, 403);
    const noCsrf = await app.inject({ method: 'POST', url: `/api/v1/guilds/${IDS.guild}/tickets/panels`, headers: { cookie: `tlpg_session=${token}`, 'idempotency-key': randomUUID() }, payload: input });
    assert.equal(noCsrf.statusCode, 403);
    assert.equal(ticketPanels.list(IDS.guild).length, 1);
  } finally {
    globalThis.fetch = originalFetch;
    await app.close(); db.close(); client.destroy();
  }
});
