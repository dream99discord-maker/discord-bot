import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

const snowflake = z.string().regex(/^\d{17,20}$/, 'ID Discord non valido');
const domainName = z.string().max(253).regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/i, 'Inserisci soltanto il nome host, senza schema o percorso');
const roleMap = z.object({
  ticketStaff: z.array(snowflake).max(50),
  reportStaff: z.array(snowflake).max(50),
  confidentialReportStaff: z.array(snowflake).max(50),
  moderate: z.array(snowflake).max(50),
  configure: z.array(snowflake).max(50),
}).strict();
const nullableSnowflake = snowflake.nullable();
const ticketField = z.object({
  key: z.string().regex(/^[a-z0-9_-]{1,32}$/),
  label: z.string().min(1).max(45),
  style: z.enum(['short', 'paragraph']),
  required: z.boolean(),
}).strict();
const ticketCategory = z.object({
  key: z.string().regex(/^[a-z0-9_-]{1,32}$/),
  label: z.string().min(1).max(80),
  description: z.string().min(1).max(100),
  staffRoleIds: z.array(snowflake).max(50),
  fields: z.array(ticketField).min(1).max(5),
}).strict().superRefine((category, ctx) => {
  if (new Set(category.fields.map((field) => field.key)).size !== category.fields.length) {
    ctx.addIssue({ code: 'custom', message: 'I nomi dei campi devono essere univoci per categoria.' });
  }
});

export const GuildSettingsSchema = z.object({
  general: z.object({
    name: z.string().min(1).max(80),
    language: z.literal('it'),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    footer: z.string().min(1).max(100),
  }).strict(),
  messages: z.object({
    welcomeTitle: z.string().min(1).max(100),
    welcomeContent: z.string().min(1).max(1000),
    ticketPanelTitle: z.string().min(1).max(100),
    ticketPanelDescription: z.string().min(1).max(2000),
  }).strict(),
  permissions: z.object({ roles: roleMap }).strict(),
  channels: z.object({
    logs: nullableSnowflake,
    announcements: nullableSnowflake,
    welcome: nullableSnowflake,
    ticketParent: nullableSnowflake,
    ticketPanel: nullableSnowflake,
    reports: nullableSnowflake,
    confidentialReports: nullableSnowflake,
    securityAlerts: nullableSnowflake,
  }).strict(),
  tickets: z.object({
    enabled: z.boolean(),
    maxOpenPerUser: z.number().int().min(1).max(3),
    cooldownSeconds: z.number().int().min(0).max(86400),
    transcriptMessageLimit: z.number().int().min(50).max(5000),
    categories: z.array(ticketCategory).min(1).max(25),
  }).strict().superRefine((tickets, ctx) => {
    if (new Set(tickets.categories.map((category) => category.key)).size !== tickets.categories.length) {
      ctx.addIssue({ code: 'custom', message: 'I codici delle categorie devono essere univoci.' });
    }
  }),
  moderation: z.object({
    warningEscalationEnabled: z.boolean(),
    warningEscalations: z.array(z.object({ count: z.number().int().min(2).max(100), action: z.enum(['timeout']), durationMinutes: z.number().int().min(1).max(40320) }).strict()).max(10),
  }).strict(),
  announcements: z.object({
    allowedRoleMentions: z.array(snowflake).max(50),
  }).strict(),
  security: z.object({
    mode: z.enum(['observe', 'alert', 'enforce']),
    automatedActionsEnabled: z.boolean(),
    allowInvites: z.boolean(),
    blockedDomains: z.array(domainName).max(200),
    allowedDomains: z.array(domainName).max(200),
    excludedChannelIds: z.array(snowflake).max(500),
    excludedRoleIds: z.array(snowflake).max(500),
    excludedUserIds: z.array(snowflake).max(500),
    duplicateWindowSeconds: z.number().int().min(2).max(3600),
    duplicateMessageLimit: z.number().int().min(2).max(20),
    mentionLimit: z.number().int().min(1).max(100),
    joinSpikeCount: z.number().int().min(2).max(1000),
    joinSpikeWindowSeconds: z.number().int().min(5).max(3600),
    newAccountDays: z.number().int().min(0).max(30),
    automod: z.object({ enabled: z.boolean(), blockedWords: z.array(z.string().min(1).max(60)).max(100) }).strict(),
  }).strict(),
  retention: z.object({
    days: z.number().int().min(1).max(3650),
    automaticCleanupEnabled: z.boolean(),
  }).strict(),
  modules: z.object({
    tickets: z.boolean(),
    reports: z.boolean(),
    moderation: z.boolean(),
    security: z.boolean(),
    announcements: z.boolean(),
  }).strict(),
}).strict();

export type GuildSettings = z.infer<typeof GuildSettingsSchema>;
export type PermissionCapability = keyof GuildSettings['permissions']['roles'];

export const DEFAULT_SETTINGS: GuildSettings = GuildSettingsSchema.parse(
  JSON.parse(readFileSync(resolve(process.cwd(), 'initial-config.json'), 'utf8')) as unknown,
);

export function parseSettings(value: unknown): GuildSettings {
  return GuildSettingsSchema.parse(value);
}

export function mergeSettings(base: GuildSettings, patch: unknown): GuildSettings {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new Error('Le impostazioni devono essere un oggetto JSON.');
  }
  const merge = (left: unknown, right: unknown): unknown => {
    if (right === null || typeof right !== 'object' || Array.isArray(right)) return right;
    const result: Record<string, unknown> = { ...(left && typeof left === 'object' ? left as Record<string, unknown> : {}) };
    for (const [key, value] of Object.entries(right)) result[key] = merge(result[key], value);
    return result;
  };
  return parseSettings(merge(base, patch));
}
