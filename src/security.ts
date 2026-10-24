import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { AppError } from './errors.js';

export const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
export const randomToken = (bytes = 32): string => randomBytes(bytes).toString('base64url');

export function deriveKey(secret: string): Buffer {
  return scryptSync(secret, 'the-last-pact-guardian-v1', 32);
}

export function encryptSecret(value: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${encrypted.toString('base64url')}`;
}

export function decryptSecret(value: string, key: Buffer): string {
  const [ivValue, tagValue, encryptedValue] = value.split('.');
  if (!ivValue || !tagValue || !encryptedValue) throw new AppError('Token di sessione non valido.', 401, 'SESSIONE_NON_VALIDA');
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivValue, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(encryptedValue, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    throw new AppError('Impossibile decifrare la sessione OAuth.', 401, 'SESSIONE_NON_VALIDA');
  }
}

export function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function normalizeDomain(host: string): string {
  return host.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
}

export function extractUrls(text: string): URL[] {
  const found: URL[] = [];
  const expression = /https?:\/\/[^\s<>{}"']+/giu;
  for (const match of text.matchAll(expression)) {
    const candidate = match[0].replace(/[),.!?;:]+$/u, '');
    try {
      const url = new URL(candidate);
      if (url.protocol === 'http:' || url.protocol === 'https:') found.push(url);
    } catch {
      // Gli URL malformati vengono ignorati; non vengono richiesti o aperti.
    }
  }
  return found;
}

export function isBlockedDomain(hostname: string, blocked: string[], allowed: string[]): boolean {
  const host = normalizeDomain(hostname);
  const matches = (domain: string): boolean => {
    const normalized = normalizeDomain(domain);
    return host === normalized || host.endsWith(`.${normalized}`);
  };
  if (allowed.some(matches)) return false;
  return blocked.some(matches);
}

export function mentionsBlockedInvite(text: string): boolean {
  const expression = /(?:^|[\s(])((?:https?:\/\/)?(?:www\.)?(?:discord\.gg|discord(?:app)?\.com)\/(?:invite\/)?[a-z0-9-]+)/giu;
  for (const match of text.matchAll(expression)) {
    const candidate = (match[1] ?? '').replace(/[),.!?;:]+$/u, '');
    try {
      const url = new URL(candidate.startsWith('http') ? candidate : `https://${candidate}`);
      const host = normalizeDomain(url.hostname);
      if (host === 'discord.gg' && /^\/[a-z0-9-]+$/iu.test(url.pathname)) return true;
      if ((host === 'discord.com' || host === 'discordapp.com') && /^\/invite\/[a-z0-9-]+$/iu.test(url.pathname)) return true;
    } catch { /* I riferimenti malformati non vengono aperti o considerati inviti validi. */ }
  }
  return false;
}

export function signPayload(value: string, secret: string): string {
  return createHmac('sha256', secret).update(value).digest('base64url');
}
