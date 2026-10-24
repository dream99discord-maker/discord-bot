import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import helmet from '@fastify/helmet';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z, ZodError, type ZodType } from 'zod';
import { ChannelType, PermissionFlagsBits, PermissionsBitField, type Client } from 'discord.js';
import type { AppConfig } from '../config.js';
import { ensureGuildSettings, getGuildSettings, listAuditLog, updateGuildSettings, type DatabaseHandle } from '../db.js';
import { AppError, AuthorizationError, NotFoundError } from '../errors.js';
import { decryptSecret, deriveKey, encryptSecret, randomToken, safeEqual, sha256, signPayload } from '../security.js';
import { mergeSettings, type GuildSettings } from '../settings.js';
import type { TicketService } from '../services/ticket-service.js';
import { TicketPanelService, managedTicketPanelInputSchema } from '../services/ticket-panel-service.js';
import type { ReportService, ReportStatus } from '../services/report-service.js';
import type { ModerationService } from '../services/moderation-service.js';
import type { AnnouncementService, AnnouncementInput } from '../services/announcement-service.js';
import type { LockdownService } from '../services/lockdown-service.js';
import type { SafetyService } from '../services/safety-service.js';
import type { Scheduler } from '../services/scheduler.js';

const SESSION_COOKIE = 'tlpg_session';
const OAUTH_STATE_COOKIE = 'tlpg_oauth_state';
const COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const DISCORD_API = 'https://discord.com/api/v10';
const DISCORD_OAUTH_TOKEN_URL = 'https://discord.com/api/oauth2/token';
const SNOWFLAKE = /^\d{17,20}$/;
const guildParamsSchema = z.object({ guildId: z.string().regex(SNOWFLAKE) }).strict();
const ticketParamsSchema = guildParamsSchema.extend({ ticketId: z.string().uuid() }).strict();
const panelParamsSchema = guildParamsSchema.extend({ panelId: z.string().regex(/^(?:[0-9a-f-]{36}|legacy-\d{17,20})$/i) }).strict();
const reportParamsSchema = guildParamsSchema.extend({ reportId: z.string().min(8).max(80) }).strict();
const taskParamsSchema = guildParamsSchema.extend({ taskId: z.string().uuid() }).strict();

interface SessionRow {
  id_hash: string; user_id: string; access_token_enc: string; refresh_token_enc: string | null;
  csrf_token: string; access_expires_at: string; expires_at: string; created_at: string; last_seen_at: string;
}
interface DiscordGuildPermission {
  id: string; name: string; owner: boolean; permissions: string; icon: string | null;
}
interface OAuthSession {
  userId: string; accessToken: string; csrfToken: string; idHash: string;
}
interface DiscordTokenResponse {
  access_token: string; token_type: 'Bearer'; expires_in: number; refresh_token: string; scope: string;
}

declare module 'fastify' {
  interface FastifyRequest { guardianSession: OAuthSession | null; }
}

export interface ApiServices {
  db: DatabaseHandle;
  client: Client;
  config: AppConfig;
  tickets: TicketService;
  ticketPanels?: TicketPanelService;
  reports: ReportService;
  moderation: ModerationService;
  announcements: AnnouncementService;
  lockdown: LockdownService;
  safety: SafetyService;
  scheduler: Scheduler;
}

function parse<T>(schema: ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new AppError(result.error.issues[0]?.message ?? 'Dati della richiesta non validi.', 400, 'DATI_NON_VALIDI');
  return result.data;
}

function getParam<T>(schema: ZodType<T>, params: unknown): T { return parse(schema, params); }

function discordFailure(response: Response): AppError {
  if (response.status === 401 || response.status === 403) return new AppError('Discord ha revocato o limitato le autorizzazioni. Accedi di nuovo e verifica i permessi del server.', 401, 'OAUTH_REVOCATO');
  if (response.status === 429 || response.status >= 500) return new AppError('Discord non è momentaneamente disponibile. Riprova tra poco.', 503, 'DISCORD_NON_DISPONIBILE');
  return new AppError('Discord non ha autorizzato questa richiesta.', 403, 'DISCORD_ACCESSO_NEGATO');
}

export async function createApiServer(services: ApiServices): Promise<FastifyInstance> {
  const { config, db, client, tickets, reports, moderation, announcements, lockdown, safety, scheduler } = services;
  const ticketPanels = services.ticketPanels ?? new TicketPanelService(db, client);
  const trustedProxies = config.TRUST_PROXY.split(',').map((item) => item.trim()).filter(Boolean);
  const app = Fastify({ logger: false, trustProxy: trustedProxies.length ? trustedProxies : false, bodyLimit: config.REQUEST_BODY_LIMIT_BYTES });
  const tokenKey = config.oauthEnabled ? deriveKey(config.OAUTH_TOKEN_ENCRYPTION_KEY!) : null;
  const secureCookie = config.NODE_ENV === 'production';
  const origins = config.CORS_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean);
  if (!origins.length || origins.includes('*')) throw new Error('CORS_ORIGINS deve contenere origini esplicite e non può usare * .');
  app.decorateRequest('guardianSession', null);
  await app.register(cookie);
  await app.register(cors, { origin: origins, credentials: true, methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'], allowedHeaders: ['Content-Type', 'X-CSRF-Token', 'If-Match'] });
  await app.register(rateLimit, { max: 120, timeWindow: '15 minutes', errorResponseBuilder: () => ({ error: { code: 'LIMITE_RICHIESTE', message: 'Hai raggiunto il limite di richieste. Riprova più tardi.' } }) });
  await app.register(helmet, {
    hsts: config.NODE_ENV === 'production',
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    contentSecurityPolicy: { directives: {
      defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'"], imgSrc: ["'self'", 'data:', 'https://cdn.discordapp.com'],
      fontSrc: ["'self'", 'data:'], connectSrc: ["'self'"], objectSrc: ["'none'"], baseUri: ["'self'"], frameAncestors: ["'none'"],
    } },
  });
  app.addHook('onSend', async (request, reply, payload) => {
    if (request.url.startsWith('/api/v1/')) reply.header('Cache-Control', 'no-store');
    return payload;
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
    if (error instanceof ZodError) return reply.code(400).send({ error: { code: 'DATI_NON_VALIDI', message: error.issues[0]?.message ?? 'Dati della richiesta non validi.' } });
    const statusCode = typeof error === 'object' && error !== null && 'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : 500;
    if (statusCode >= 400 && statusCode < 500) {
      const tooLarge = statusCode === 413;
      return reply.code(statusCode).send({ error: {
        code: tooLarge ? 'RICHIESTA_TROPPO_GRANDE' : 'RICHIESTA_NON_VALIDA',
        message: tooLarge ? 'La richiesta supera la dimensione massima consentita.' : 'La richiesta non è valida o non può essere completata.',
      } });
    }
    console.error(JSON.stringify({ livello: 'error', evento: 'api.exception', route: request.routeOptions.url, name: error instanceof Error ? error.name : 'UnknownError' }));
    return reply.code(500).send({ error: { code: 'ERRORE_INTERNO', message: 'Si è verificato un errore interno. Riprova più tardi.' } });
  });

  const requireOAuth = async (): Promise<void> => {
    if (!config.oauthEnabled || !tokenKey) throw new AppError('Le API amministrative sono disabilitate finché OAuth2 non è configurato.', 503, 'OAUTH_NON_CONFIGURATO');
  };

  const getSession = async (request: FastifyRequest, reply: FastifyReply): Promise<OAuthSession> => {
    await requireOAuth();
    const opaqueId = request.cookies[SESSION_COOKIE];
    if (!opaqueId) throw new AppError('Accedi con Discord per continuare.', 401, 'AUTENTICAZIONE_RICHIESTA');
    const idHash = signPayload(opaqueId, config.SESSION_SECRET!);
    const row = db.prepare('SELECT * FROM web_sessions WHERE id_hash = ?').get(idHash) as SessionRow | undefined;
    if (!row || Date.parse(row.expires_at) <= Date.now()) {
      if (row) db.prepare('DELETE FROM web_sessions WHERE id_hash = ?').run(idHash);
      reply.clearCookie(SESSION_COOKIE, { path: '/api/v1' });
      throw new AppError('La sessione è scaduta. Accedi di nuovo con Discord.', 401, 'SESSIONE_SCADUTA');
    }
    let accessToken = decryptSecret(row.access_token_enc, tokenKey!);
    let refreshToken = row.refresh_token_enc ? decryptSecret(row.refresh_token_enc, tokenKey!) : null;
    if (Date.parse(row.access_expires_at) <= Date.now() + 60_000) {
      if (!refreshToken) {
        db.prepare('DELETE FROM web_sessions WHERE id_hash = ?').run(idHash);
        throw new AppError('La sessione Discord è stata revocata. Accedi di nuovo.', 401, 'OAUTH_REVOCATO');
      }
      try {
        const token = await requestToken({ grant_type: 'refresh_token', refresh_token: refreshToken }, config);
        accessToken = token.access_token;
        refreshToken = token.refresh_token;
        const accessExpires = new Date(Date.now() + token.expires_in * 1000).toISOString();
        db.prepare(`UPDATE web_sessions SET access_token_enc = ?, refresh_token_enc = ?, access_expires_at = ?, expires_at = ?, last_seen_at = ? WHERE id_hash = ?`)
          .run(encryptSecret(accessToken, tokenKey!), encryptSecret(refreshToken, tokenKey!), accessExpires,
            new Date(Date.now() + COOKIE_MAX_AGE_SECONDS * 1000).toISOString(), new Date().toISOString(), idHash);
      } catch {
        db.prepare('DELETE FROM web_sessions WHERE id_hash = ?').run(idHash);
        reply.clearCookie(SESSION_COOKIE, { path: '/api/v1' });
        throw new AppError('La sessione Discord non è più valida. Accedi di nuovo.', 401, 'OAUTH_REVOCATO');
      }
    } else {
      db.prepare('UPDATE web_sessions SET last_seen_at = ? WHERE id_hash = ?').run(new Date().toISOString(), idHash);
    }
    return { userId: row.user_id, accessToken, csrfToken: row.csrf_token, idHash };
  };

  const sessionPreHandler = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => { request.guardianSession = await getSession(request, reply); };
  const csrfPreHandler = async (request: FastifyRequest): Promise<void> => {
    const session = request.guardianSession;
    if (!session) throw new AppError('Sessione richiesta.', 401, 'AUTENTICAZIONE_RICHIESTA');
    const token = request.headers['x-csrf-token'];
    if (typeof token !== 'string' || !safeEqual(token, session.csrfToken)) throw new AppError('Token CSRF non valido o scaduto.', 403, 'CSRF_NON_VALIDO');
  };

  const discordJson = async <T>(url: string, accessToken: string, schema?: ZodType<T>, retries = 0): Promise<T> => {
    let response: Response;
    try {
      response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}`, 'User-Agent': 'The-Last-Pact-Guardian/1.0' }, signal: AbortSignal.timeout(10_000) });
    } catch { throw new AppError('Non è stato possibile verificare i permessi con Discord.', 503, 'DISCORD_NON_DISPONIBILE'); }
    if (response.status === 429 && retries < 1) {
      const retryAfter = Number(response.headers.get('retry-after') ?? response.headers.get('x-ratelimit-reset-after'));
      if (Number.isFinite(retryAfter) && retryAfter >= 0 && retryAfter <= 5) {
        await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, Math.ceil(retryAfter * 1000) + 50));
        return discordJson<T>(url, accessToken, schema, retries + 1);
      }
    }
    if (!response.ok) throw discordFailure(response);
    const body: unknown = await response.json();
    return schema ? parse(schema, body) : body as T;
  };

  const tokenResponseSchema = z.object({ access_token: z.string().min(1), token_type: z.literal('Bearer'), expires_in: z.number().positive(), refresh_token: z.string().min(1), scope: z.string() });
  const requestToken = async (fields: Record<string, string>, appConfig: AppConfig): Promise<DiscordTokenResponse> => {
    if (!appConfig.DISCORD_CLIENT_ID || !appConfig.DISCORD_CLIENT_SECRET) throw new AppError('OAuth2 Discord non configurato.', 503, 'OAUTH_NON_CONFIGURATO');
    let response: Response;
    try {
      const body = new URLSearchParams({ ...fields, client_id: appConfig.DISCORD_CLIENT_ID, client_secret: appConfig.DISCORD_CLIENT_SECRET });
      if (fields['grant_type'] === 'authorization_code') body.set('redirect_uri', appConfig.DISCORD_REDIRECT_URI);
      response = await fetch(DISCORD_OAUTH_TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'The-Last-Pact-Guardian/1.0' }, body, signal: AbortSignal.timeout(10_000) });
    } catch { throw new AppError('Discord non è momentaneamente disponibile.', 503, 'DISCORD_NON_DISPONIBILE'); }
    if (!response.ok) throw discordFailure(response);
    return parse(tokenResponseSchema, await response.json());
  };

  const oauthGuildFlights = new Map<string, Promise<DiscordGuildPermission[]>>();
  const fetchOAuthGuilds = async (session: OAuthSession): Promise<DiscordGuildPermission[]> => {
    const active = oauthGuildFlights.get(session.idHash);
    if (active) return active;
    const pending = (async () => {
      const guilds: DiscordGuildPermission[] = [];
      let after: string | undefined;
      for (let pageIndex = 0; pageIndex < 5; pageIndex++) {
        const params = new URLSearchParams({ limit: '200' });
        if (after) params.set('after', after);
        const page = await discordJson<DiscordGuildPermission[]>(`${DISCORD_API}/users/@me/guilds?${params.toString()}`, session.accessToken,
          z.array(z.object({ id: z.string().regex(SNOWFLAKE), name: z.string().max(100), owner: z.boolean().default(false), permissions: z.string(), icon: z.string().nullable() })));
        guilds.push(...page);
        if (page.length < 200) break;
        after = page.at(-1)?.id;
        if (!after) break;
      }
      return guilds;
    })();
    oauthGuildFlights.set(session.idHash, pending);
    try { return await pending; }
    finally { if (oauthGuildFlights.get(session.idHash) === pending) oauthGuildFlights.delete(session.idHash); }
  };
  const oauthGuild = async (session: OAuthSession, guildId: string): Promise<DiscordGuildPermission | null> =>
    (await fetchOAuthGuilds(session)).find((guild) => guild.id === guildId) ?? null;

  const requireGuildMember = async (request: FastifyRequest, guildId: string): Promise<{ session: OAuthSession; guild: DiscordGuildPermission }> => {
    const session = request.guardianSession;
    if (!session) throw new AppError('Accedi con Discord per continuare.', 401, 'AUTENTICAZIONE_RICHIESTA');
    const guild = await oauthGuild(session, guildId);
    if (!guild) throw new AuthorizationError('Non appartieni più a questo server o Discord ha revocato il tuo accesso.');
    if (!client.isReady()) throw new AppError('Il bot è offline. Le operazioni Discord non sono disponibili adesso.', 503, 'BOT_NON_CONNESSO');
    const botGuild = await client.guilds.fetch(guildId).catch(() => null);
    if (!botGuild) throw new AppError('Il bot non è presente in questo server.', 403, 'BOT_NON_PRESENTE');
    return { session, guild };
  };

  const requireGuildAdmin = async (request: FastifyRequest, guildId: string): Promise<{ session: OAuthSession; guild: DiscordGuildPermission }> => {
    const access = await requireGuildMember(request, guildId);
    const canManage = access.guild.owner === true || (BigInt(access.guild.permissions) & (PermissionFlagsBits.ManageGuild | PermissionFlagsBits.Administrator)) !== 0n;
    if (!canManage) throw new AuthorizationError('Per configurare il bot devi essere proprietario del server o avere Gestisci server.');
    ensureGuildSettings(db, guildId, access.session.userId);
    return access;
  };

  const requireGuildPanelManager = async (request: FastifyRequest, guildId: string): Promise<{ session: OAuthSession; guild: DiscordGuildPermission }> => {
    const access = await requireGuildMember(request, guildId);
    const permissions = BigInt(access.guild.permissions);
    const canManageChannels = access.guild.owner || (permissions & (PermissionFlagsBits.ManageChannels | PermissionFlagsBits.Administrator)) !== 0n;
    if (!canManageChannels) throw new AuthorizationError('Per configurare i pannelli ticket serve Gestisci canali o essere proprietario del server.');
    return access;
  };

  const validateGuildSettingsResources = async (guildId: string, settings: GuildSettings): Promise<void> => {
    const guild = await client.guilds.fetch(guildId).catch(() => null);
    if (!guild) throw new AppError('Il bot non è presente in questo server.', 403, 'BOT_NON_PRESENTE');
    const channelSpecs = [
      ['logs', settings.channels.logs, [ChannelType.GuildText]],
      ['announcements', settings.channels.announcements, [ChannelType.GuildText, ChannelType.GuildAnnouncement]],
      ['welcome', settings.channels.welcome, [ChannelType.GuildText]],
      ['ticketParent', settings.channels.ticketParent, [ChannelType.GuildCategory]],
      ['ticketPanel', settings.channels.ticketPanel, [ChannelType.GuildText]],
      ['reports', settings.channels.reports, [ChannelType.GuildText]],
      ['confidentialReports', settings.channels.confidentialReports, [ChannelType.GuildText]],
      ['securityAlerts', settings.channels.securityAlerts, [ChannelType.GuildText]],
    ] as const;
    const channelResults = await Promise.all(channelSpecs.flatMap((spec) => {
      const [name, id, types] = spec;
      if (!id) return [];
      return [guild.channels.fetch(id).catch(() => null).then((channel) => ({
        name, valid: Boolean(channel && channel.guildId === guildId && types.includes(channel.type as never)),
      }))];
    }));
    const badChannel = channelResults.find((result) => !result.valid);
    if (badChannel) throw new AppError(`Il canale configurato per “${badChannel.name}” non esiste o appartiene a un altro server.`, 400, 'CANALE_NON_VALIDO');
    const roleIds = new Set([
      ...Object.values(settings.permissions.roles).flat(),
      ...settings.tickets.categories.flatMap((category) => category.staffRoleIds),
      ...settings.announcements.allowedRoleMentions,
      ...settings.security.excludedRoleIds,
    ]);
    const roles = await Promise.all([...roleIds].map(async (id) => await guild.roles.fetch(id).catch(() => null)));
    if (roles.some((role) => !role || role.guild.id !== guildId)) throw new AppError('Un ruolo configurato non esiste o appartiene a un altro server.', 400, 'RUOLO_NON_VALIDO');
    const exceptions = await Promise.all(settings.security.excludedUserIds.map(async (id) => await guild.members.fetch(id).catch(() => null)));
    if (exceptions.some((member) => !member || member.guild.id !== guildId)) throw new AppError('Un utente nelle eccezioni non appartiene a questo server.', 400, 'UTENTE_NON_VALIDO');
  };

  app.get('/health', async () => ({ status: 'ok', service: 'the-last-pact-guardian', apiVersion: 'v1', oauthEnabled: config.oauthEnabled, botReady: client.isReady() }));
  app.get('/docs/openapi.yaml', async (_request, reply) => reply.type('application/yaml; charset=utf-8').send(readFileSync(resolve(process.cwd(), 'docs/openapi.yaml'), 'utf8')));

  app.get('/api/v1/auth/discord', { config: { rateLimit: { max: 8, timeWindow: '15 minutes' } } }, async (_request, reply) => {
    await requireOAuth();
    const state = randomToken(32);
    const verifier = randomToken(48);
    const challenge = Buffer.from(await crypto.subtle.digest('SHA-256', Buffer.from(verifier))).toString('base64url');
    const now = new Date().toISOString();
    db.prepare('INSERT INTO oauth_states(state_hash, code_verifier, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(sha256(state), verifier, now, new Date(Date.now() + 10 * 60_000).toISOString());
    reply.setCookie(OAUTH_STATE_COOKIE, state, { httpOnly: true, secure: secureCookie, sameSite: 'lax', path: '/api/v1/auth/discord/callback', maxAge: 600 });
    const url = new URL(`${DISCORD_API.replace('/api/v10', '')}/oauth2/authorize`);
    url.searchParams.set('client_id', config.DISCORD_CLIENT_ID!);
    url.searchParams.set('redirect_uri', config.DISCORD_REDIRECT_URI);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'identify guilds');
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    return reply.redirect(url.toString());
  });

  app.get('/api/v1/auth/discord/install', { config: { rateLimit: { max: 8, timeWindow: '15 minutes' } } }, async (request, reply) => {
    await requireOAuth();
    const query = parse(z.object({ guild_id: z.string().regex(SNOWFLAKE).optional() }).strict(), request.query);
    const state = randomToken(32);
    const verifier = randomToken(48);
    const challenge = Buffer.from(await crypto.subtle.digest('SHA-256', Buffer.from(verifier))).toString('base64url');
    db.prepare('INSERT INTO oauth_states(state_hash, code_verifier, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(sha256(state), verifier, new Date().toISOString(), new Date(Date.now() + 10 * 60_000).toISOString());
    reply.setCookie(OAUTH_STATE_COOKIE, state, { httpOnly: true, secure: secureCookie, sameSite: 'lax', path: '/api/v1/auth/discord/callback', maxAge: 600 });
    const url = new URL(`${DISCORD_API.replace('/api/v10', '')}/oauth2/authorize`);
    url.searchParams.set('client_id', config.DISCORD_CLIENT_ID!);
    url.searchParams.set('redirect_uri', config.DISCORD_REDIRECT_URI);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'bot applications.commands identify guilds');
    url.searchParams.set('integration_type', '0');
    url.searchParams.set('permissions', botPermissions().toString());
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    if (query.guild_id) {
      url.searchParams.set('guild_id', query.guild_id);
      url.searchParams.set('disable_guild_select', 'true');
    }
    return reply.redirect(url.toString());
  });

  app.get('/api/v1/auth/discord/callback', async (request, reply) => {
    await requireOAuth();
    const query = parse(z.object({
      code: z.string().optional(), state: z.string().optional(), error: z.string().optional(),
      error_description: z.string().max(1000).optional(), error_uri: z.string().url().optional(),
      guild_id: z.string().regex(SNOWFLAKE).optional(), permissions: z.string().optional(),
      iss: z.literal('https://discord.com'),
    }).strict(), request.query);
    const cookieState = request.cookies[OAUTH_STATE_COOKIE];
    reply.clearCookie(OAUTH_STATE_COOKIE, { path: '/api/v1/auth/discord/callback' });
    if (query.error || !query.code || !query.state || !cookieState || !safeEqual(query.state, cookieState)) throw new AppError('La verifica OAuth2 è fallita. Riavvia l’accesso da Discord.', 401, 'OAUTH_STATE_NON_VALIDO');
    const stateRow = db.prepare('SELECT code_verifier, expires_at FROM oauth_states WHERE state_hash = ?').get(sha256(query.state)) as { code_verifier: string; expires_at: string } | undefined;
    db.prepare('DELETE FROM oauth_states WHERE state_hash = ?').run(sha256(query.state));
    if (!stateRow || Date.parse(stateRow.expires_at) <= Date.now()) throw new AppError('La richiesta di accesso OAuth2 è scaduta.', 401, 'OAUTH_STATE_SCADUTO');
    const token = await requestToken({ grant_type: 'authorization_code', code: query.code, code_verifier: stateRow.code_verifier }, config);
    const grantedScopes = new Set(token.scope.split(/\s+/).filter(Boolean));
    if (!grantedScopes.has('identify') || !grantedScopes.has('guilds')) throw new AppError('Discord non ha concesso gli scope identify e guilds richiesti.', 403, 'OAUTH_SCOPE_INSUFFICIENTI');
    const who = await discordJson<{ id: string; username: string; global_name: string | null }>(`${DISCORD_API}/users/@me`, token.access_token,
      z.object({ id: z.string().regex(SNOWFLAKE), username: z.string(), global_name: z.string().nullable() }));
    const rawSession = randomToken(32);
    const idHash = signPayload(rawSession, config.SESSION_SECRET!);
    const now = new Date().toISOString();
    const csrfToken = randomToken(32);
    db.prepare(`INSERT INTO web_sessions(id_hash, user_id, access_token_enc, refresh_token_enc, csrf_token, access_expires_at, expires_at, created_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(idHash, who.id, encryptSecret(token.access_token, tokenKey!), encryptSecret(token.refresh_token, tokenKey!), csrfToken,
        new Date(Date.now() + token.expires_in * 1000).toISOString(), new Date(Date.now() + COOKIE_MAX_AGE_SECONDS * 1000).toISOString(), now, now);
    reply.setCookie(SESSION_COOKIE, rawSession, { httpOnly: true, secure: secureCookie, sameSite: 'lax', path: '/api/v1', maxAge: COOKIE_MAX_AGE_SECONDS });
    return reply.redirect(config.APP_BASE_URL);
  });

  app.get('/api/v1/auth/me', { preHandler: sessionPreHandler }, async (request) => {
    const session = request.guardianSession!;
    const user = await discordJson<{ id: string; username: string; global_name: string | null }>(`${DISCORD_API}/users/@me`, session.accessToken,
      z.object({ id: z.string(), username: z.string(), global_name: z.string().nullable() }));
    return { user, csrfToken: session.csrfToken };
  });

  app.post('/api/v1/auth/logout', { preHandler: [sessionPreHandler, csrfPreHandler] }, async (request, reply) => {
    db.prepare('DELETE FROM web_sessions WHERE id_hash = ?').run(request.guardianSession!.idHash);
    reply.clearCookie(SESSION_COOKIE, { path: '/api/v1' });
    return reply.code(204).send();
  });

  app.get('/api/v1/guilds', { preHandler: sessionPreHandler }, async (request) => {
    const session = request.guardianSession!;
    const guilds = await fetchOAuthGuilds(session);
    const manageable = guilds.flatMap((guild) => {
      const permissions = BigInt(guild.permissions);
      const canManageGuild = (permissions & (PermissionFlagsBits.ManageGuild | PermissionFlagsBits.Administrator)) !== 0n;
      const canManageChannels = (permissions & (PermissionFlagsBits.ManageChannels | PermissionFlagsBits.Administrator)) !== 0n;
      if (!guild.owner && !canManageGuild && !canManageChannels) return [];
      return [{ ...guild, canManageGuild, canManageChannels }];
    });
    return { guilds: manageable.map(({ id, name, owner, icon, canManageGuild, canManageChannels }) => {
      const botPresent = client.isReady() && client.guilds.cache.has(id);
      const status = !client.isReady() ? 'offline' : botPresent ? 'presente' : 'assente';
      return { id, name, owner, canManageGuild, canManageChannels, icon, botStatus: status,
        ...(status === 'assente' ? { inviteUrl: buildBotInstallUrl(id) } : {}) };
    }) };
  });

  app.get('/api/v1/guilds/:guildId/resources', { preHandler: sessionPreHandler }, async (request) => {
    const { guildId } = getParam(guildParamsSchema, request.params);
    await requireGuildPanelManager(request, guildId);
    if (!client.isReady() || !client.user) throw new AppError('Il bot è offline. Le risorse Discord non possono essere caricate adesso.', 503, 'BOT_NON_CONNESSO');
    const guild = await client.guilds.fetch(guildId);
    const [channels, roles, bot] = await Promise.all([
      guild.channels.fetch(), guild.roles.fetch(), guild.members.fetch(client.user!.id).catch(() => null),
    ]);
    if (!bot) throw new AppError('Il bot non è disponibile in questo server.', 503, 'BOT_NON_DISPONIBILE');
    const botTopPosition = bot.roles.highest.position;
    const channelRows = [...channels.values()].filter((channel): channel is NonNullable<typeof channel> => Boolean(channel)).map((channel) => {
      const permissions = channel.permissionsFor(bot);
      const text = channel.type === ChannelType.GuildText;
      const announcement = channel.type === ChannelType.GuildAnnouncement;
      const category = channel.type === ChannelType.GuildCategory;
      return {
        id: channel.id, name: channel.name, type: channel.type, parentId: 'parentId' in channel ? channel.parentId : null,
        position: 'position' in channel ? channel.position : 0,
        publicView: Boolean(channel.permissionsFor(guild.roles.everyone)?.has(PermissionFlagsBits.ViewChannel)),
        permissions: {
          view: Boolean(permissions?.has(PermissionFlagsBits.ViewChannel)),
          send: Boolean(permissions?.has(PermissionFlagsBits.SendMessages)),
          embed: Boolean(permissions?.has(PermissionFlagsBits.EmbedLinks)),
          manageChannels: Boolean(permissions?.has(PermissionFlagsBits.ManageChannels)),
        },
        compatible: {
          ticketPanel: text && Boolean(permissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])),
          announcements: (text || announcement) && Boolean(permissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])),
          staffText: text && Boolean(permissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])),
          ticketCategory: category && Boolean(permissions?.has(PermissionFlagsBits.ManageChannels)),
          lockdown: (text || announcement) && Boolean(permissions?.has(PermissionFlagsBits.ManageChannels)),
        },
      };
    }).sort((a, b) => a.position - b.position || a.name.localeCompare(b.name, 'it'));
    const roleRows = [...roles.values()].filter((role): role is NonNullable<typeof role> => Boolean(role)).map((role) => ({
      id: role.id, name: role.name, color: role.hexColor, position: role.position, managed: role.managed,
      assignable: role.id !== guild.roles.everyone.id && !role.managed && role.position < botTopPosition,
    })).sort((a, b) => b.position - a.position);
    return { guildId, bot: { highestRolePosition: botTopPosition }, channels: channelRows, roles: roleRows };
  });

  app.get('/api/v1/guilds/:guildId/settings', { preHandler: sessionPreHandler }, async (request) => {
    const { guildId } = getParam(guildParamsSchema, request.params);
    const access = await requireGuildAdmin(request, guildId);
    return getGuildSettings(db, guildId);
  });

  app.post('/api/v1/guilds/:guildId/settings/preview', { preHandler: [sessionPreHandler, csrfPreHandler] }, async (request) => {
    const { guildId } = getParam(guildParamsSchema, request.params);
    const access = await requireGuildAdmin(request, guildId);
    const body = parse(z.object({ settings: z.record(z.string(), z.unknown()) }).strict(), request.body);
    const current = getGuildSettings(db, guildId);
    const settings = mergeSettings(current.settings, body.settings);
    await validateGuildSettingsResources(guildId, settings);
    const changedKeys = topLevelDiff(current.settings, settings);
    return { preview: settings, currentVersion: current.version, changedSections: changedKeys,
      willApplyWithoutRestart: changedKeys.filter((key) => ['security', 'modules', 'channels', 'tickets', 'retention', 'announcements'].includes(key)) };
  });

  app.patch('/api/v1/guilds/:guildId/settings', { preHandler: [sessionPreHandler, csrfPreHandler] }, async (request) => {
    const { guildId } = getParam(guildParamsSchema, request.params);
    const access = await requireGuildAdmin(request, guildId);
    const body = parse(z.object({ expectedVersion: z.number().int().min(1), settings: z.record(z.string(), z.unknown()) }).strict(), request.body);
    const current = getGuildSettings(db, guildId);
    const next = mergeSettings(current.settings, body.settings);
    await validateGuildSettingsResources(guildId, next);
    const saved = updateGuildSettings(db, guildId, next, access.session.userId, body.expectedVersion);
    const liveApply: Array<{ feature: string; status: 'ok' | 'failed'; code?: string }> = [];
    try { await safety.syncAutoMod(guildId, next); liveApply.push({ feature: 'automod', status: 'ok' }); }
    catch { liveApply.push({ feature: 'automod', status: 'failed', code: 'SYNC_AUTOMOD_FALLITA' }); }
    if (JSON.stringify(current.settings.permissions.roles) !== JSON.stringify(next.permissions.roles) || JSON.stringify(current.settings.tickets.categories.map((category) => [category.key, category.staffRoleIds])) !== JSON.stringify(next.tickets.categories.map((category) => [category.key, category.staffRoleIds]))) {
      try {
        const result = await tickets.reconcileStaffAccess(guildId, current.settings, next);
        liveApply.push({ feature: 'ticket-access', status: result.failed ? 'failed' : 'ok', ...(result.failed ? { code: 'ACCESSO_TICKET_NON_RIALLINEATO' } : {}) });
      } catch { liveApply.push({ feature: 'ticket-access', status: 'failed', code: 'ACCESSO_TICKET_NON_RIALLINEATO' }); }
    }
    if (next.channels.ticketPanel && (JSON.stringify(current.settings.general) !== JSON.stringify(next.general) || JSON.stringify(current.settings.tickets) !== JSON.stringify(next.tickets) || current.settings.channels.ticketPanel !== next.channels.ticketPanel || current.settings.channels.ticketParent !== next.channels.ticketParent)) {
      try { await tickets.createPanel(guildId, next); liveApply.push({ feature: 'ticket-panel', status: 'ok' }); }
      catch { liveApply.push({ feature: 'ticket-panel', status: 'failed', code: 'SYNC_PANNELLO_FALLITA' }); }
    }
    try { await scheduler.refreshRetentionTask(guildId); liveApply.push({ feature: 'retention', status: 'ok' }); }
    catch { liveApply.push({ feature: 'retention', status: 'failed', code: 'SYNC_CONSERVAZIONE_FALLITA' }); }
    return { ...saved, liveApply, applicationStatus: liveApply.some((item) => item.status === 'failed') ? 'parziale' : 'completata' };
  });

  app.get('/api/v1/guilds/:guildId/settings/history', { preHandler: sessionPreHandler }, async (request) => {
    const { guildId } = getParam(guildParamsSchema, request.params);
    await requireGuildAdmin(request, guildId);
    const rows = listAuditLog(db, guildId, 100) as Array<Record<string, unknown>>;
    return { changes: rows.filter((row) => row['action'] === 'settings.update') };
  });

  app.get('/api/v1/guilds/:guildId/modules', { preHandler: sessionPreHandler }, async (request) => {
    const { guildId } = getParam(guildParamsSchema, request.params);
    await requireGuildAdmin(request, guildId);
    const stored = ensureGuildSettings(db, guildId, request.guardianSession!.userId);
    return { guildId, modules: stored.settings.modules, security: { mode: stored.settings.security.mode, automatedActionsEnabled: stored.settings.security.automatedActionsEnabled }, botReady: client.isReady() };
  });

  app.get('/api/v1/guilds/:guildId/diagnostics', { preHandler: sessionPreHandler }, async (request) => {
    const { guildId } = getParam(guildParamsSchema, request.params);
    await requireGuildAdmin(request, guildId);
    const stored = ensureGuildSettings(db, guildId, request.guardianSession!.userId);
    const guild = await client.guilds.fetch(guildId).catch(() => null);
    const checkChannel = async (channelId: string | null, purpose: string) => {
      if (!channelId) return { purpose, configured: false, available: false };
      const channel = await guild?.channels.fetch(channelId).catch(() => null);
      return { purpose, configured: true, available: Boolean(channel && channel.guildId === guildId) };
    };
    return { botReady: client.isReady(), guildAvailable: Boolean(guild), modules: stored.settings.modules, channels: await Promise.all([
      checkChannel(stored.settings.channels.logs, 'log'), checkChannel(stored.settings.channels.announcements, 'annunci'),
      checkChannel(stored.settings.channels.ticketParent, 'categoria-ticket'), checkChannel(stored.settings.channels.ticketPanel, 'pannello-ticket'),
      checkChannel(stored.settings.channels.reports, 'segnalazioni'), checkChannel(stored.settings.channels.confidentialReports, 'segnalazioni-riservate'),
      checkChannel(stored.settings.channels.securityAlerts, 'avvisi-sicurezza'),
    ]), automationStopped: lockdown.areAutomationsStopped(guildId) };
  });

  app.get('/api/v1/guilds/:guildId/audit-log', { preHandler: sessionPreHandler }, async (request) => {
    const { guildId } = getParam(guildParamsSchema, request.params);
    await requireGuildAdmin(request, guildId);
    return { records: listAuditLog(db, guildId, 100) };
  });

  app.get('/api/v1/guilds/:guildId/tickets', { preHandler: sessionPreHandler }, async (request) => {
    const { guildId } = getParam(guildParamsSchema, request.params);
    const { session } = await requireGuildMember(request, guildId);
    if (!await tickets.hasDashboardStaffRole(guildId, session.userId)) throw new AuthorizationError('Per consultare la coda ticket serve un ruolo ticket staff.');
    const query = parse(z.object({ status: z.enum(['creating', 'open', 'closing', 'closed', 'failed']).optional(), categoryKey: z.string().max(32).optional(), panelId: z.string().regex(/^(?:[0-9a-f-]{36}|legacy-\d{17,20})$/i).optional(), search: z.string().max(100).optional(), limit: z.coerce.number().int().min(1).max(100).default(50), offset: z.coerce.number().int().min(0).max(10000).default(0) }).strict(), request.query);
    return { tickets: await tickets.listForDashboard(guildId, session.userId, {
      ...(query.status ? { status: query.status } : {}),
      ...(query.categoryKey ? { categoryKey: query.categoryKey } : {}),
      ...(query.panelId ? { panelId: query.panelId } : {}),
      ...(query.search ? { search: query.search } : {}),
      limit: query.limit, offset: query.offset,
    }), page: { limit: query.limit, offset: query.offset } };
  });

  app.get('/api/v1/guilds/:guildId/tickets/:ticketId', { preHandler: sessionPreHandler }, async (request) => {
    const { guildId, ticketId } = getParam(ticketParamsSchema, request.params);
    const { session } = await requireGuildMember(request, guildId);
    if (!await tickets.canReadFromDashboard(guildId, ticketId, session.userId)) throw new AuthorizationError('Non sei autorizzato ad accedere a questo ticket.');
    return { ticket: tickets.get(guildId, ticketId), participants: tickets.participants(guildId, ticketId) };
  });

  app.get('/api/v1/guilds/:guildId/tickets/:ticketId/messages', { preHandler: sessionPreHandler }, async (request) => {
    const { guildId, ticketId } = getParam(ticketParamsSchema, request.params);
    const { session } = await requireGuildMember(request, guildId);
    if (!await tickets.canReadFromDashboard(guildId, ticketId, session.userId)) throw new AuthorizationError('Non sei autorizzato a leggere i messaggi di questo ticket.');
    const query = parse(z.object({ limit: z.coerce.number().int().min(1).max(100).default(50), before: z.string().regex(SNOWFLAKE).optional() }).strict(), request.query);
    return { messages: await tickets.messages(guildId, ticketId, session.userId, { limit: query.limit, ...(query.before ? { before: query.before } : {}) }) };
  });

  app.post('/api/v1/guilds/:guildId/tickets/:ticketId/messages', { preHandler: [sessionPreHandler, csrfPreHandler] }, async (request) => {
    const { guildId, ticketId } = getParam(ticketParamsSchema, request.params);
    const { session } = await requireGuildMember(request, guildId);
    if (!await tickets.hasDashboardStaffRole(guildId, session.userId)) throw new AuthorizationError('Per rispondere ai ticket serve un ruolo ticket staff.');
    const body = parse(z.object({ content: z.string().min(1).max(2000) }).strict(), request.body);
    return { message: await tickets.reply(guildId, ticketId, session.userId, body.content) };
  });

  app.get('/api/v1/guilds/:guildId/tickets/:ticketId/transcript', { preHandler: sessionPreHandler }, async (request) => {
    const { guildId, ticketId } = getParam(ticketParamsSchema, request.params);
    const { session } = await requireGuildMember(request, guildId);
    if (!await tickets.canReadFromDashboard(guildId, ticketId, session.userId)) throw new AuthorizationError('Non sei autorizzato ad accedere a questa trascrizione.');
    return { ticketId, transcript: tickets.getTranscript(guildId, ticketId) };
  });

  app.get('/api/v1/guilds/:guildId/tickets/:ticketId/transcript/download', { preHandler: sessionPreHandler }, async (request, reply) => {
    const { guildId, ticketId } = getParam(ticketParamsSchema, request.params);
    const { session } = await requireGuildMember(request, guildId);
    if (!await tickets.canReadFromDashboard(guildId, ticketId, session.userId)) throw new AuthorizationError('Non sei autorizzato a scaricare questa trascrizione.');
    const transcript = tickets.getTranscript(guildId, ticketId);
    reply.header('Cache-Control', 'private, no-store').header('X-Content-Type-Options', 'nosniff')
      .header('Content-Disposition', `attachment; filename="ticket-${ticketId}-trascrizione.txt"`);
    return reply.type('text/plain; charset=utf-8').send(transcript.text);
  });

  app.post('/api/v1/guilds/:guildId/tickets/:ticketId/close', { preHandler: [sessionPreHandler, csrfPreHandler] }, async (request) => {
    const { guildId, ticketId } = getParam(ticketParamsSchema, request.params);
    const { session } = await requireGuildMember(request, guildId);
    if (!await tickets.canReadFromDashboard(guildId, ticketId, session.userId)) throw new AuthorizationError('Non sei autorizzato a chiudere questo ticket.');
    const body = parse(z.object({ reason: z.string().min(3).max(500) }).strict(), request.body);
    return { ticket: await tickets.close(guildId, ticketId, session.userId, body.reason) };
  });

  app.post('/api/v1/guilds/:guildId/tickets/:ticketId/assign', { preHandler: [sessionPreHandler, csrfPreHandler] }, async (request) => {
    const { guildId, ticketId } = getParam(ticketParamsSchema, request.params);
    const { session } = await requireGuildMember(request, guildId);
    if (!await tickets.hasDashboardStaffRole(guildId, session.userId)) throw new AuthorizationError('Per assegnare un ticket serve il ruolo ticket staff.');
    return { ticket: await tickets.assign(guildId, ticketId, session.userId) };
  });

  app.post('/api/v1/guilds/:guildId/tickets/:ticketId/participants', { preHandler: [sessionPreHandler, csrfPreHandler] }, async (request) => {
    const { guildId, ticketId } = getParam(ticketParamsSchema, request.params);
    const { session } = await requireGuildMember(request, guildId);
    if (!await tickets.hasDashboardStaffRole(guildId, session.userId)) throw new AuthorizationError('Per modificare i partecipanti serve un ruolo ticket staff.');
    const body = parse(z.object({ userId: z.string().regex(SNOWFLAKE), action: z.enum(['add', 'remove']) }).strict(), request.body);
    await tickets.addParticipant(guildId, ticketId, session.userId, body.userId, body.action === 'remove');
    return { ok: true };
  });

  app.get('/api/v1/guilds/:guildId/reports', { preHandler: sessionPreHandler }, async (request) => {
    const { guildId } = getParam(guildParamsSchema, request.params);
    const { session } = await requireGuildMember(request, guildId);
    const query = parse(z.object({ confidential: z.enum(['true', 'false']).optional(), status: z.enum(['new', 'assigned', 'info_requested', 'accepted', 'rejected']).optional(), search: z.string().max(100).optional(), limit: z.coerce.number().int().min(1).max(100).default(50), offset: z.coerce.number().int().min(0).max(10000).default(0) }).strict(), request.query);
    const confidential = query.confidential === 'true';
    if (!await reports.hasDashboardStaffRole(guildId, session.userId, confidential)) throw new AuthorizationError('Per consultare queste segnalazioni serve il ruolo specifico autorizzato.');
    return { reports: reports.list(guildId, { confidential, ...(query.status ? { status: query.status as ReportStatus } : {}), ...(query.search ? { search: query.search } : {}), limit: query.limit, offset: query.offset }), page: { limit: query.limit, offset: query.offset } };
  });

  app.get('/api/v1/guilds/:guildId/reports/:reportId', { preHandler: sessionPreHandler }, async (request) => {
    const { guildId, reportId } = getParam(reportParamsSchema, request.params);
    const { session } = await requireGuildMember(request, guildId);
    const report = reports.get(guildId, reportId);
    if (!await reports.hasDashboardStaffRole(guildId, session.userId, report.confidential)) throw new AuthorizationError('Per consultare questa segnalazione serve il ruolo specifico autorizzato.');
    return { report, history: reports.history(guildId, reportId) };
  });

  app.post('/api/v1/guilds/:guildId/reports/:reportId/status', { preHandler: [sessionPreHandler, csrfPreHandler] }, async (request) => {
    const { guildId, reportId } = getParam(reportParamsSchema, request.params);
    const { session } = await requireGuildMember(request, guildId);
    const report = reports.get(guildId, reportId);
    if (!await reports.hasDashboardStaffRole(guildId, session.userId, report.confidential)) throw new AuthorizationError('Non hai il ruolo autorizzato a gestire questa segnalazione.');
    const body = parse(z.object({ status: z.enum(['assigned', 'info_requested', 'accepted', 'rejected']), reason: z.string().max(1000).optional() }).strict(), request.body);
    const updated = await reports.transition(guildId, reportId, session.userId, body.status, body.reason);
    return { report: updated, history: reports.history(guildId, reportId) };
  });

  app.get('/api/v1/guilds/:guildId/moderation/cases', { preHandler: sessionPreHandler }, async (request) => {
    const { guildId } = getParam(guildParamsSchema, request.params);
    const { session } = await requireGuildMember(request, guildId);
    if (!await moderation.canModerate(guildId, session.userId)) throw new AuthorizationError('Per consultare i casi serve un ruolo di moderazione.');
    const query = parse(z.object({ targetId: z.string().regex(SNOWFLAKE).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }).strict(), request.query);
    return { cases: await moderation.listCases(guildId, { ...(query.targetId ? { targetId: query.targetId } : {}), limit: query.limit }) };
  });

  app.get('/api/v1/guilds/:guildId/moderation/:targetId/warnings', { preHandler: sessionPreHandler }, async (request) => {
    const { guildId, targetId } = getParam(guildParamsSchema.extend({ targetId: z.string().regex(SNOWFLAKE) }).strict(), request.params);
    const { session } = await requireGuildMember(request, guildId);
    if (!await moderation.canModerate(guildId, session.userId)) throw new AuthorizationError('Per consultare gli avvertimenti serve un ruolo di moderazione.');
    return { warnings: moderation.warnings(guildId, targetId) };
  });

  app.post('/api/v1/guilds/:guildId/moderation/warnings', { preHandler: [sessionPreHandler, csrfPreHandler] }, async (request) => {
    const { guildId } = getParam(guildParamsSchema, request.params);
    const { session } = await requireGuildMember(request, guildId);
    if (!await moderation.canModerate(guildId, session.userId)) throw new AuthorizationError();
    const body = parse(z.object({ targetId: z.string().regex(SNOWFLAKE), reason: z.string().min(3).max(1000) }).strict(), request.body);
    return await moderation.warn(guildId, session.userId, body.targetId, body.reason);
  });

  app.post('/api/v1/guilds/:guildId/moderation/warnings/:caseNumber/revoke', { preHandler: [sessionPreHandler, csrfPreHandler] }, async (request) => {
    const { guildId, caseNumber } = parse(guildParamsSchema.extend({ caseNumber: z.coerce.number().int().positive() }).strict(), request.params);
    const { session } = await requireGuildMember(request, guildId);
    if (!await moderation.canModerate(guildId, session.userId)) throw new AuthorizationError();
    const body = parse(z.object({ reason: z.string().min(3).max(1000) }).strict(), request.body);
    return { case: await moderation.revokeWarning(guildId, session.userId, caseNumber, body.reason) };
  });

  app.post('/api/v1/guilds/:guildId/moderation/timeouts', { preHandler: [sessionPreHandler, csrfPreHandler] }, async (request) => {
    const { guildId } = getParam(guildParamsSchema, request.params);
    const { session } = await requireGuildMember(request, guildId);
    if (!await moderation.canModerate(guildId, session.userId)) throw new AuthorizationError();
    const body = parse(z.object({ targetId: z.string().regex(SNOWFLAKE), durationMinutes: z.number().int().min(1).max(40320), reason: z.string().min(3).max(1000) }).strict(), request.body);
    return await moderation.timeout(guildId, session.userId, body.targetId, body.durationMinutes, body.reason);
  });

  app.delete('/api/v1/guilds/:guildId/moderation/:targetId/timeouts', { preHandler: [sessionPreHandler, csrfPreHandler] }, async (request) => {
    const { guildId, targetId } = parse(guildParamsSchema.extend({ targetId: z.string().regex(SNOWFLAKE) }).strict(), request.params);
    const { session } = await requireGuildMember(request, guildId);
    if (!await moderation.canModerate(guildId, session.userId)) throw new AuthorizationError();
    const body = parse(z.object({ reason: z.string().min(3).max(1000) }).strict(), request.body);
    return { case: await moderation.removeTimeout(guildId, session.userId, targetId, body.reason) };
  });

  app.post('/api/v1/guilds/:guildId/moderation/kicks', { preHandler: [sessionPreHandler, csrfPreHandler] }, async (request) => {
    const { guildId } = getParam(guildParamsSchema, request.params);
    const { session } = await requireGuildMember(request, guildId);
    if (!await moderation.canModerate(guildId, session.userId)) throw new AuthorizationError();
    const body = parse(z.object({ targetId: z.string().regex(SNOWFLAKE), reason: z.string().min(3).max(1000) }).strict(), request.body);
    return await moderation.kick(guildId, session.userId, body.targetId, body.reason);
  });

  app.post('/api/v1/guilds/:guildId/moderation/unbans', { preHandler: [sessionPreHandler, csrfPreHandler] }, async (request) => {
    const { guildId } = getParam(guildParamsSchema, request.params);
    const { session } = await requireGuildMember(request, guildId);
    if (!await moderation.canModerate(guildId, session.userId)) throw new AuthorizationError();
    const body = parse(z.object({ targetId: z.string().regex(SNOWFLAKE), reason: z.string().min(3).max(1000) }).strict(), request.body);
    return { case: await moderation.unban(guildId, session.userId, body.targetId, body.reason) };
  });

  app.post('/api/v1/guilds/:guildId/moderation/purges/confirmations', { preHandler: [sessionPreHandler, csrfPreHandler] }, async (request) => {
    const { guildId } = getParam(guildParamsSchema, request.params);
    const { session } = await requireGuildMember(request, guildId);
    if (!await moderation.canModerate(guildId, session.userId)) throw new AuthorizationError();
    const body = parse(z.object({ channelId: z.string().regex(SNOWFLAKE), amount: z.number().int().min(2).max(100) }).strict(), request.body);
    return await moderation.requestPurge(guildId, session.userId, body.channelId, body.amount);
  });

  app.post('/api/v1/guilds/:guildId/moderation/slowmode', { preHandler: [sessionPreHandler, csrfPreHandler] }, async (request) => {
    const { guildId } = getParam(guildParamsSchema, request.params);
    const { session } = await requireGuildMember(request, guildId);
    if (!await moderation.canModerate(guildId, session.userId)) throw new AuthorizationError();
    const body = parse(z.object({ channelId: z.string().regex(SNOWFLAKE), seconds: z.number().int().min(0).max(21600), reason: z.string().min(3).max(1000) }).strict(), request.body);
    return { case: await moderation.slowmode(guildId, session.userId, body.channelId, body.seconds, body.reason) };
  });

  app.post('/api/v1/guilds/:guildId/moderation/bans/confirmations', { preHandler: [sessionPreHandler, csrfPreHandler] }, async (request) => {
    const { guildId } = getParam(guildParamsSchema, request.params);
    const { session } = await requireGuildMember(request, guildId);
    if (!await moderation.canModerate(guildId, session.userId)) throw new AuthorizationError();
    const body = parse(z.object({ targetId: z.string().regex(SNOWFLAKE), reason: z.string().min(3).max(1000) }).strict(), request.body);
    return moderation.requestBan(guildId, session.userId, body.targetId, body.reason);
  });

  app.post('/api/v1/guilds/:guildId/moderation/confirmations/:confirmationId', { preHandler: [sessionPreHandler, csrfPreHandler] }, async (request) => {
    const { guildId, confirmationId } = getParam(guildParamsSchema.extend({ confirmationId: z.string().uuid() }).strict(), request.params);
    const { session } = await requireGuildMember(request, guildId);
    if (!await moderation.canModerate(guildId, session.userId)) throw new AuthorizationError();
    return { case: await moderation.confirm(guildId, session.userId, confirmationId) };
  });

  app.get('/api/v1/guilds/:guildId/announcements', { preHandler: sessionPreHandler }, async (request) => {
    const { guildId } = getParam(guildParamsSchema, request.params);
    await requireGuildAdmin(request, guildId);
    return { announcements: announcements.list(guildId) };
  });

  const announcementSchema = z.object({ type: z.enum(['annuncio', 'manutenzione', 'aggiornamento', 'evento']), title: z.string().min(1).max(100), content: z.string().min(1).max(4000), roleIds: z.array(z.string().regex(SNOWFLAKE)).max(10).optional(), runAt: z.string().datetime().optional(), channelId: z.string().regex(SNOWFLAKE).optional() }).strict();
  const announcementInput = (value: z.infer<typeof announcementSchema>): AnnouncementInput => ({
    type: value.type, title: value.title, content: value.content,
    ...(value.roleIds ? { roleIds: value.roleIds } : {}), ...(value.runAt ? { runAt: value.runAt } : {}), ...(value.channelId ? { channelId: value.channelId } : {}),
  });
  app.post('/api/v1/guilds/:guildId/announcements/preview', { preHandler: [sessionPreHandler, csrfPreHandler] }, async (request) => {
    const { guildId } = getParam(guildParamsSchema, request.params);
    await requireGuildAdmin(request, guildId);
    const body = announcementInput(parse(announcementSchema, request.body));
    return await announcements.preview(guildId, body);
  });

  app.post('/api/v1/guilds/:guildId/announcements', { preHandler: [sessionPreHandler, csrfPreHandler] }, async (request) => {
    const { guildId } = getParam(guildParamsSchema, request.params);
    const { session } = await requireGuildAdmin(request, guildId);
    const body = announcementInput(parse(announcementSchema, request.body));
    return await announcements.create(guildId, session.userId, body);
  });

  app.patch('/api/v1/guilds/:guildId/announcements/:taskId', { preHandler: [sessionPreHandler, csrfPreHandler] }, async (request) => {
    const { guildId, taskId } = getParam(taskParamsSchema, request.params);
    const { session } = await requireGuildAdmin(request, guildId);
    const body = parse(z.object({ expectedVersion: z.number().int().min(1), patch: announcementSchema.partial() }).strict(), request.body);
    const patchBody = Object.fromEntries(Object.entries(body.patch).filter(([, value]) => value !== undefined)) as Partial<AnnouncementInput>;
    return { task: await announcements.update(guildId, session.userId, taskId, body.expectedVersion, patchBody) };
  });

  app.delete('/api/v1/guilds/:guildId/announcements/:taskId', { preHandler: [sessionPreHandler, csrfPreHandler] }, async (request) => {
    const { guildId, taskId } = getParam(taskParamsSchema, request.params);
    const { session } = await requireGuildAdmin(request, guildId);
    return { task: announcements.cancel(guildId, session.userId, taskId) };
  });

  app.post('/api/v1/guilds/:guildId/tickets/panel', { preHandler: [sessionPreHandler, csrfPreHandler] }, async (request) => {
    const { guildId } = getParam(guildParamsSchema, request.params);
    await requireGuildAdmin(request, guildId);
    const body = parse(z.object({}).strict(), request.body ?? {});
    void body;
    const settings = getGuildSettings(db, guildId).settings;
    return { panel: await tickets.createPanel(guildId, settings) };
  });

  app.get('/api/v1/guilds/:guildId/tickets/panels', { preHandler: sessionPreHandler }, async (request) => {
    const { guildId } = getParam(guildParamsSchema, request.params);
    await requireGuildPanelManager(request, guildId);
    const panels = ticketPanels.list(guildId);
    return { panels: await Promise.all(panels.map(async (panel) => {
      try {
        const inspected = await ticketPanels.inspect(guildId, panel.id);
        const status = panel.status === 'disabled' ? 'disabled' : inspected.health.missing.length ? 'needs_repair' : panel.status;
        return { ...panel, status, enabled: panel.enabled, health: inspected.health, ticketCount: inspected.ticketCount };
      } catch {
        const health = { panelChannel: false, panelChannelPublic: false, panelChannelReadOnly: false, panelBotAccess: false, panelCategory: false, ticketCategory: false, ticketCategoryPrivate: false, message: false, missing: ['risorse non raggiungibili'] };
        return { ...panel, status: panel.status === 'disabled' ? 'disabled' : 'needs_repair', enabled: panel.enabled, health, ticketCount: 0 };
      }
    })) };
  });

  app.post('/api/v1/guilds/:guildId/tickets/panels', {
    preHandler: [sessionPreHandler, csrfPreHandler], config: { rateLimit: { max: 12, timeWindow: '15 minutes' } },
  }, async (request, reply) => {
    const { guildId } = getParam(guildParamsSchema, request.params);
    const { session } = await requireGuildPanelManager(request, guildId);
    const body = parse(managedTicketPanelInputSchema, request.body);
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string') throw new AppError('Manca l’identificativo persistente dell’operazione. Ricarica il modulo e riprova.', 400, 'IDEMPOTENCY_KEY_RICHIESTA');
    const result = await ticketPanels.create(guildId, session.userId, key, body);
    reply.code(result.status === 'in_progress' ? 202 : 200);
    return result;
  });

  app.get('/api/v1/guilds/:guildId/tickets/operations/:operationId', { preHandler: sessionPreHandler }, async (request) => {
    const { guildId, operationId } = getParam(guildParamsSchema.extend({ operationId: z.string().uuid() }).strict(), request.params);
    await requireGuildPanelManager(request, guildId);
    return { operation: ticketPanels.operation(guildId, operationId) };
  });

  app.get('/api/v1/guilds/:guildId/tickets/panels/:panelId', { preHandler: sessionPreHandler }, async (request) => {
    const { guildId, panelId } = getParam(panelParamsSchema, request.params);
    await requireGuildPanelManager(request, guildId);
    return await ticketPanels.inspect(guildId, panelId);
  });

  app.patch('/api/v1/guilds/:guildId/tickets/panels/:panelId', { preHandler: [sessionPreHandler, csrfPreHandler] }, async (request) => {
    const { guildId, panelId } = getParam(panelParamsSchema, request.params);
    const { session } = await requireGuildPanelManager(request, guildId);
    const body = parse(z.object({ expectedVersion: z.number().int().min(1), patch: z.record(z.string(), z.unknown()) }).strict(), request.body);
    const panel = await ticketPanels.update(guildId, session.userId, panelId, body.expectedVersion, body.patch);
    const staffAccess = await tickets.reconcileManagedPanelStaff(guildId, panelId, panel.config);
    return { panel, staffAccess, status: staffAccess.failed || panel.status === 'needs_repair' ? 'needs_attention' : panel.status };
  });

  app.post('/api/v1/guilds/:guildId/tickets/panels/:panelId/status', { preHandler: [sessionPreHandler, csrfPreHandler] }, async (request) => {
    const { guildId, panelId } = getParam(panelParamsSchema, request.params);
    const { session } = await requireGuildPanelManager(request, guildId);
    const body = parse(z.object({ enabled: z.boolean() }).strict(), request.body);
    return { panel: await ticketPanels.setEnabled(guildId, session.userId, panelId, body.enabled) };
  });

  app.post('/api/v1/guilds/:guildId/tickets/panels/:panelId/repair', { preHandler: [sessionPreHandler, csrfPreHandler] }, async (request) => {
    const { guildId, panelId } = getParam(panelParamsSchema, request.params);
    const { session } = await requireGuildPanelManager(request, guildId);
    return await ticketPanels.repair(guildId, session.userId, panelId);
  });

  app.delete('/api/v1/guilds/:guildId/tickets/panels/:panelId', { preHandler: [sessionPreHandler, csrfPreHandler] }, async (request) => {
    const { guildId, panelId } = getParam(panelParamsSchema, request.params);
    const { session } = await requireGuildPanelManager(request, guildId);
    const body = parse(z.object({ confirmResourceIds: z.array(z.string().regex(SNOWFLAKE)).max(10) }).strict(), request.body);
    return await ticketPanels.delete(guildId, session.userId, panelId, body.confirmResourceIds);
  });

  app.post('/api/v1/guilds/:guildId/security/lockdown', { preHandler: [sessionPreHandler, csrfPreHandler] }, async (request) => {
    const { guildId } = getParam(guildParamsSchema, request.params);
    const { session } = await requireGuildAdmin(request, guildId);
    const body = parse(z.object({ durationMinutes: z.number().int().min(1).max(1440).optional() }).strict(), request.body ?? {});
    return await lockdown.requestActivation(guildId, session.userId, body.durationMinutes);
  });

  app.post('/api/v1/guilds/:guildId/security/lockdown/confirmations/:confirmationId', { preHandler: [sessionPreHandler, csrfPreHandler] }, async (request) => {
    const { guildId, confirmationId } = getParam(guildParamsSchema.extend({ confirmationId: z.string().uuid() }).strict(), request.params);
    const { session } = await requireGuildAdmin(request, guildId);
    return await lockdown.confirmActivation(guildId, session.userId, confirmationId);
  });

  app.post('/api/v1/guilds/:guildId/security/restore', { preHandler: [sessionPreHandler, csrfPreHandler] }, async (request) => {
    const { guildId } = getParam(guildParamsSchema, request.params);
    const { session } = await requireGuildAdmin(request, guildId);
    return await lockdown.restore(guildId, session.userId);
  });

  app.post('/api/v1/guilds/:guildId/security/channels/lock', { preHandler: [sessionPreHandler, csrfPreHandler] }, async (request) => {
    const { guildId } = getParam(guildParamsSchema, request.params);
    const { session } = await requireGuildAdmin(request, guildId);
    const body = parse(z.object({ channelId: z.string().regex(SNOWFLAKE), reason: z.string().min(3).max(1000) }).strict(), request.body);
    return await lockdown.lockChannel(guildId, session.userId, body.channelId, body.reason);
  });

  app.post('/api/v1/guilds/:guildId/security/channels/unlock', { preHandler: [sessionPreHandler, csrfPreHandler] }, async (request) => {
    const { guildId } = getParam(guildParamsSchema, request.params);
    const { session } = await requireGuildAdmin(request, guildId);
    const body = parse(z.object({ channelId: z.string().regex(SNOWFLAKE), reason: z.string().min(3).max(1000) }).strict(), request.body);
    return await lockdown.unlockChannel(guildId, session.userId, body.channelId, body.reason);
  });

  app.post('/api/v1/guilds/:guildId/security/automations/stop', { preHandler: [sessionPreHandler, csrfPreHandler] }, async (request) => {
    const { guildId } = getParam(guildParamsSchema, request.params);
    const { session } = await requireGuildAdmin(request, guildId);
    lockdown.stopAutomations(guildId, session.userId);
    return { stopped: true };
  });

  app.post('/api/v1/guilds/:guildId/security/automations/start', { preHandler: [sessionPreHandler, csrfPreHandler] }, async (request) => {
    const { guildId } = getParam(guildParamsSchema, request.params);
    const { session } = await requireGuildAdmin(request, guildId);
    lockdown.startAutomations(guildId, session.userId);
    return { stopped: false };
  });

  if (config.NODE_ENV === 'production') {
    const webRoot = resolve(process.cwd(), 'web', 'dist');
    if (!existsSync(resolve(webRoot, 'index.html'))) throw new Error('Frontend compilato non trovato: esegui npm run build prima di avviare in produzione.');
    await app.register(fastifyStatic, { root: webRoot, prefix: '/', wildcard: false, index: 'index.html', decorateReply: true });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) return reply.code(404).send({ error: { code: 'NON_TROVATO', message: 'Risorsa API non trovata.' } });
      return reply.type('text/html; charset=utf-8').sendFile('index.html');
    });
  } else {
    app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: { code: 'NON_TROVATO', message: 'Risorsa API non trovata.' } }));
  }
  return app;
}

function topLevelDiff(before: GuildSettings, after: GuildSettings): string[] {
  return (Object.keys(before) as Array<keyof GuildSettings>).filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
}

function botPermissions(): bigint {
  const required = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageMessages,
    PermissionFlagsBits.ModerateMembers, PermissionFlagsBits.KickMembers, PermissionFlagsBits.BanMembers,
    PermissionFlagsBits.ManageGuild, PermissionFlagsBits.ViewAuditLog];
  return new PermissionsBitField(required).bitfield;
}

function buildBotInstallUrl(guildId: string): string {
  const query = new URLSearchParams({ guild_id: guildId });
  return `/api/v1/auth/discord/install?${query.toString()}`;
}
