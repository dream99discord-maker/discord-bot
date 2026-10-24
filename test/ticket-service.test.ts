import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection } from 'discord.js';
import { ensureGuildSettings, getGuildSettings, openDatabase, updateGuildSettings } from '../src/db.js';
import { AuthorizationError, ConflictError, NotFoundError } from '../src/errors.js';
import { TicketService } from '../src/services/ticket-service.js';
import { createFakeDiscord, IDS, makeFakeChannel } from './helpers/fake-discord.js';

function setup() {
  const db = openDatabase(':memory:');
  const fake = createFakeDiscord();
  const panelChannel = makeFakeChannel(IDS.guild, '777777777777777778', IDS.guild);
  panelChannel.messageCollection.set('777777777777777779', { id: '777777777777777779', embeds: [], content: '' });
  fake.channels.set(panelChannel.id, panelChannel);
  const initial = ensureGuildSettings(db, IDS.guild, 'test');
  const settings = structuredClone(initial.settings);
  settings.permissions.roles.ticketStaff = [IDS.staffRole];
  settings.tickets.cooldownSeconds = 0;
  updateGuildSettings(db, IDS.guild, settings, 'test', initial.version);
  const now = new Date().toISOString();
  db.prepare('INSERT INTO ticket_panels(guild_id, channel_id, message_id, updated_at) VALUES (?, ?, ?, ?)')
    .run(IDS.guild, '777777777777777778', '777777777777777779', now);
  return { db, ...fake, service: new TicketService(db, fake.client) };
}

test('Aperture simultanee dello stesso utente creano un solo ticket e gli ID restano isolati per server', async () => {
  const { db, service, channels } = setup();
  try {
    const input = { guildId: IDS.guild, userId: IDS.user, panelMessageId: '777777777777777779', categoryKey: 'assistenza', fields: { descrizione: 'Serve aiuto con una partita.' } };
    const results = await Promise.allSettled([service.openFromModal(input), service.openFromModal(input)]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1, JSON.stringify(results.map((result) => result.status === 'rejected' ? String(result.reason) : 'ok')));
    const rejected = results.find((result) => result.status === 'rejected');
    assert.equal(rejected?.status, 'rejected');
    assert.ok(rejected?.status === 'rejected' && rejected.reason instanceof ConflictError);
    assert.equal(channels.size, 2);
    const ticket = (await service.list(IDS.guild))[0];
    assert.ok(ticket);
    assert.equal(ticket.status, 'open');
    assert.throws(() => service.get('222222222222222222', ticket.id), NotFoundError);
    await assert.rejects(() => service.openFromModal({ ...input, panelMessageId: '888888888888888888' }), AuthorizationError);
  } finally { db.close(); }
});

test('Chiusure concorrenti producono una sola chiusura e una trascrizione privata testuale', async () => {
  const { db, service, channels } = setup();
  try {
    const ticket = await service.openFromModal({ guildId: IDS.guild, userId: IDS.user, panelMessageId: '777777777777777779', categoryKey: 'assistenza', fields: { descrizione: 'Descrizione del problema da archiviare.' } });
    const channel = channels.get(ticket.channelId!);
    assert.ok(channel);
    const userMessage = {
      id: '777777777777777780', createdTimestamp: Date.now(),
      author: { username: 'utente', id: IDS.user },
      content: '<script>alert(1)</script> @everyone testo ostile',
      attachments: new Collection(),
    };
    channel.messageCollection.set(userMessage.id, userMessage);
    const closing = { guildId: IDS.guild, ticketId: ticket.id, actorId: IDS.user, reason: 'Problema risolto' };
    const results = await Promise.allSettled([service.close(closing.guildId, closing.ticketId, closing.actorId, closing.reason), service.close(closing.guildId, closing.ticketId, closing.actorId, closing.reason)]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1, JSON.stringify(results.map((result) => result.status === 'rejected' ? String(result.reason) : 'ok')));
    const rejected = results.find((result) => result.status === 'rejected');
    assert.ok(rejected?.status === 'rejected' && rejected.reason instanceof ConflictError);
    assert.equal(service.get(IDS.guild, ticket.id).status, 'closed');
    const transcript = service.getTranscript(IDS.guild, ticket.id);
    assert.equal(transcript.messageCount, 2);
    assert.match(transcript.text, /<script>alert\(1\)<\/script>/);
    assert.match(transcript.text, /\[Trascrizione|utente/);
    assert.equal(channel.sent.at(-1)?.allowedMentions && (channel.sent.at(-1)?.allowedMentions as { parse: string[] }).parse.length, 0);
    assert.equal(await service.canReadFromDashboard(IDS.guild, ticket.id, IDS.user), true);
    assert.equal(await service.canReadFromDashboard(IDS.guild, ticket.id, IDS.otherUser), false);
  } finally { db.close(); }
});

test('La rimozione del ruolo ticket staff revoca anche gli overwrite dei ticket aperti', async () => {
  const { db, service, channels } = setup();
  try {
    const ticket = await service.openFromModal({ guildId: IDS.guild, userId: IDS.otherUser, panelMessageId: '777777777777777779', categoryKey: 'assistenza', fields: { descrizione: 'Richiesta di prova per la revoca del ruolo.' } });
    const channel = channels.get(ticket.channelId!);
    assert.ok(channel?.permissionOverwrites.cache.has(IDS.staffRole));
    const current = getGuildSettings(db, IDS.guild);
    const next = structuredClone(current.settings);
    next.permissions.roles.ticketStaff = [];
    updateGuildSettings(db, IDS.guild, next, 'operator', current.version);
    const result = await service.reconcileStaffAccess(IDS.guild, current.settings, next);
    assert.equal(result.failed, 0);
    assert.equal(result.changed, 1);
    assert.equal(channel?.permissionOverwrites.cache.has(IDS.staffRole), false);
    assert.equal(await service.canReadFromDashboard(IDS.guild, ticket.id, IDS.user), false);
  } finally { db.close(); }
});
