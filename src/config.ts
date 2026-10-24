import 'dotenv/config';
import { z } from 'zod';

const optionalSecret = z.string().trim().optional().transform((value) => value || undefined);

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  BOT_TOKEN: optionalSecret,
  DISCORD_CLIENT_ID: optionalSecret,
  DISCORD_CLIENT_SECRET: optionalSecret,
  DISCORD_REDIRECT_URI: z.string().url().default('http://localhost:3000/api/v1/auth/discord/callback'),
  SESSION_SECRET: optionalSecret,
  OAUTH_TOKEN_ENCRYPTION_KEY: optionalSecret,
  APP_BASE_URL: z.string().url().default('http://localhost:5173'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  REQUEST_BODY_LIMIT_BYTES: z.coerce.number().int().min(16_384).max(5_242_880).default(1_048_576),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(30_000),
  HOST: z.string().default('127.0.0.1'),
  DATABASE_PATH: z.string().default('./data/guardian.sqlite'),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  TRUST_PROXY: z.string().default(''),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type AppConfig = z.infer<typeof environmentSchema> & {
  oauthEnabled: boolean;
  sessionEnabled: boolean;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = environmentSchema.safeParse(env);
  if (!result.success) {
    throw new Error(`Configurazione ambiente non valida: ${z.prettifyError(result.error)}`);
  }
  const parsed = result.data;
  const oauthSecrets = [parsed.DISCORD_CLIENT_SECRET, parsed.SESSION_SECRET, parsed.OAUTH_TOKEN_ENCRYPTION_KEY];
  const oauthEnabled = Boolean(parsed.DISCORD_CLIENT_ID && oauthSecrets.every(Boolean));
  // Partial OAuth setup is allowed so operators can populate local .env values incrementally.
  // Administrative routes remain disabled until all four values are present.
  if (parsed.NODE_ENV === 'production' && !parsed.DISCORD_REDIRECT_URI.startsWith('https://')) {
    throw new Error('In produzione DISCORD_REDIRECT_URI deve usare HTTPS.');
  }
  if (parsed.NODE_ENV === 'production' && !parsed.APP_BASE_URL.startsWith('https://')) {
    throw new Error('In produzione APP_BASE_URL deve usare HTTPS.');
  }
  if (parsed.NODE_ENV === 'production') {
    const appOrigin = new URL(parsed.APP_BASE_URL).origin;
    const callbackOrigin = new URL(parsed.DISCORD_REDIRECT_URI).origin;
    const corsOrigins = parsed.CORS_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean);
    if (callbackOrigin !== appOrigin) throw new Error('In produzione il callback OAuth2 deve usare la stessa origine HTTPS della dashboard.');
    if (corsOrigins.some((origin) => !origin.startsWith('https://'))) throw new Error('In produzione CORS_ORIGINS deve contenere soltanto origini HTTPS.');
  }
  if (oauthEnabled && (parsed.SESSION_SECRET!.length < 32 || parsed.OAUTH_TOKEN_ENCRYPTION_KEY!.length < 32)) {
    throw new Error('SESSION_SECRET e OAUTH_TOKEN_ENCRYPTION_KEY devono contenere almeno 32 caratteri casuali.');
  }
  return {
    ...parsed,
    oauthEnabled,
    sessionEnabled: oauthEnabled,
  };
}

export const hasBotCredentials = (config: AppConfig): boolean => Boolean(config.BOT_TOKEN && config.DISCORD_CLIENT_ID);
