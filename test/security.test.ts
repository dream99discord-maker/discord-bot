import test from 'node:test';
import assert from 'node:assert/strict';
import { decryptSecret, deriveKey, encryptSecret, extractUrls, isBlockedDomain, mentionsBlockedInvite, safeEqual } from '../src/security.js';

test('Il controllo domini usa corrispondenze esatte e per sottodominio', () => {
  assert.equal(isBlockedDomain('phishing.example.com', ['example.com'], []), true);
  assert.equal(isBlockedDomain('example.com', ['example.com'], []), true);
  assert.equal(isBlockedDomain('example.com.evil.test', ['example.com'], []), false);
  assert.equal(isBlockedDomain('roblox-phish.example', ['roblox.com'], []), false);
  assert.equal(isBlockedDomain('tracker.example.com', ['example.com'], ['tracker.example.com']), false);
});

test('Gli URL vengono analizzati senza visitarli e gli inviti Discord sono rilevati separatamente', () => {
  const urls = extractUrls('Vai su https://example.com/path, poi guarda https://evil.test/a');
  assert.deepEqual(urls.map((url) => url.hostname), ['example.com', 'evil.test']);
  assert.equal(mentionsBlockedInvite('https://discord.gg/codice'), true);
  assert.equal(mentionsBlockedInvite('https://example.com/discord.gg/codice'), false);
});

test('Le sessioni OAuth sono cifrate e i confronti dei token CSRF sono costanti sulla lunghezza', () => {
  const key = deriveKey('test-key-that-is-long-enough-to-derive-a-secret');
  const encrypted = encryptSecret('token-di-prova', key);
  assert.notEqual(encrypted, 'token-di-prova');
  assert.equal(decryptSecret(encrypted, key), 'token-di-prova');
  assert.equal(safeEqual('csrf-token', 'csrf-token'), true);
  assert.equal(safeEqual('csrf-token', 'altro-token'), false);
  assert.equal(safeEqual('a', 'aa'), false);
});
