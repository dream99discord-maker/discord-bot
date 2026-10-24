import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ChannelType, PermissionFlagsBits, type Interaction } from 'discord.js';
import { ensureGuildSettings, openDatabase, updateGuildSettings } from '../src/db.js';
import { TicketService } from '../src/services/ticket-service.js';
import { TicketPanelService, type ManagedTicketPanelInput } from '../src/services/ticket-panel-service.js';
import { createFakeDiscord, IDS, makeFakeChannel } from './helpers/fake-discord.js';

function setup() {
  const db = openDatabase(':memory:');
  const fake = createFakeDiscord();
  const initial = ensureGuildSettings(db, IDS.guild, 'test');
  const settings = structuredClone(initial.settings);
  settings.permissions.roles.ticketStaff = [IDS.staffRole];
  settings.tickets.cooldownSeconds = 0;
  settings.tickets.maxOpenPerUser = 2;
  updateGuildSettings(db, IDS.guild, settings, 'test', initial.version);
  return { db, ...fake, panels: new TicketPanelService(db, fake.client), tickets: new TicketService(db, fake.client) };
}

function panelInput(): ManagedTicketPanelInput {
  return {
    name: 'Assistenza community', panelTitle: 'Apri una richiesta', description: 'Scegli una tipologia e descrivi la richiesta.',
    color: '#5865f2', footer: 'The Last Pact Guardian', layout: 'buttons',
    panelCategory: { mode: 'create', name: 'supporto' }, panelChannel: { mode: 'create', name: 'apri-ticket' },
    ticketCategory: { mode: 'create', name: 'ticket-privati' }, staffRoleIds: [IDS.staffRole],
    maxOpenPerUser: 2, maxConcurrentTotal: 20, cooldownSeconds: 0,
    categories: [{ key: 'assistenza', label: 'Assistenza', buttonLabel: 'Chiedi aiuto', description: 'Richiesta di aiuto', staffRoleIds: [],
      fields: [{ key: 'descrizione', label: 'Descrivi la richiesta', style: 'paragraph', required: true }] }],
  };
}

test('Crea categorie, canale e messaggio reali; apre ticket privato e deduplica il doppio invio', async () => {
  const { db, client, guild, channels, panels, tickets } = setup();
  try {
    const key = randomUUID();
    const [created, repeated] = await Promise.all([
      panels.create(IDS.guild, IDS.owner, key, panelInput()),
      panels.create(IDS.guild, IDS.owner, key, panelInput()),
    ]);
    const result = created.status === 'completed' ? created : repeated;
    assert.equal(result.status, 'completed');
    assert.ok(result.panel);
    assert.equal(panels.list(IDS.guild).length, 1);
    const panel = result.panel!;
    assert.ok(panel.panelCategoryId);
    assert.ok(panel.ticketCategoryId);
    assert.ok(panel.messageId);
    const panelChannel = channels.get(panel.channelId);
    assert.ok(panelChannel);
    assert.equal(panelChannel.type, ChannelType.GuildText);
    assert.equal(panelChannel.permissionsFor(guild.roles.everyone)?.has(PermissionFlagsBits.ViewChannel), true);
    assert.equal(panelChannel.permissionsFor(guild.roles.everyone)?.has(PermissionFlagsBits.SendMessages), false);
    const privateCategory = channels.get(panel.ticketCategoryId);
    assert.ok(privateCategory);
    assert.equal(privateCategory.permissionsFor(guild.roles.everyone)?.has(PermissionFlagsBits.ViewChannel), false);

    let modalCustomId = '';
    const componentInteraction = {
      isStringSelectMenu: () => false, isButton: () => true, guildId: IDS.guild, inGuild: () => true,
      channelId: panel.channelId, message: { id: panel.messageId },
      async showModal(modal: { toJSON: () => { custom_id?: string } }) { modalCustomId = modal.toJSON().custom_id ?? ''; },
    } as unknown as Interaction;
    await tickets.showTicketModal(componentInteraction, 'assistenza', panel.id);
    assert.match(modalCustomId, new RegExp(`ticket:submit:p:${panel.id}:assistenza`));

    const submitted = await tickets.openFromModal({ guildId: IDS.guild, userId: IDS.user, panelId: panel.id, interactionId: '998877665544332211', categoryKey: 'assistenza', fields: { descrizione: 'Serve aiuto con una richiesta.' } });
    const duplicate = await tickets.openFromModal({ guildId: IDS.guild, userId: IDS.user, panelId: panel.id, interactionId: '998877665544332211', categoryKey: 'assistenza', fields: { descrizione: 'Serve aiuto con una richiesta.' } });
    assert.equal(duplicate.id, submitted.id);
    assert.equal((await tickets.list(IDS.guild)).length, 1);
    const ticketChannel = channels.get(submitted.channelId!);
    assert.ok(ticketChannel);
    assert.equal(ticketChannel.parentId, panel.ticketCategoryId);
    assert.equal(ticketChannel.permissionsFor(guild.roles.everyone)?.has(PermissionFlagsBits.ViewChannel), false);
    assert.equal(ticketChannel.permissionsFor(IDS.user)?.has(PermissionFlagsBits.ViewChannel), true);
    assert.equal(ticketChannel.permissionsFor(IDS.staffRole)?.has(PermissionFlagsBits.ViewChannel), true);
    assert.equal(ticketChannel.permissionsFor(IDS.otherUser)?.has(PermissionFlagsBits.ViewChannel), false);
    assert.equal(await tickets.canReadFromDashboard(IDS.guild, submitted.id, IDS.otherUser), false);
    assert.equal(await tickets.canReadFromDashboard(IDS.guild, submitted.id, IDS.user), true);
    assert.equal(client.isReady(), true);
  } finally { db.close(); }
});

test('Ripara un messaggio eliminato e l’eliminazione del pannello conserva i ticket', async () => {
  const { db, channels, panels, tickets } = setup();
  try {
    const result = await panels.create(IDS.guild, IDS.owner, randomUUID(), panelInput());
    assert.equal(result.status, 'completed');
    const panel = result.panel!;
    const panelChannel = channels.get(panel.channelId)!;
    const oldMessage = await panelChannel.messages.fetch(panel.messageId) as { delete: () => Promise<void> };
    await oldMessage.delete();
    const missing = await panels.inspect(IDS.guild, panel.id);
    assert.equal(missing.health.message, false);
    const repaired = await panels.repair(IDS.guild, IDS.owner, panel.id);
    assert.equal(repaired.panel.status, 'active');
    assert.notEqual(repaired.panel.messageId, panel.messageId);

    const ticket = await tickets.openFromModal({ guildId: IDS.guild, userId: IDS.user, panelId: panel.id, interactionId: '887766554433221199', categoryKey: 'assistenza', fields: { descrizione: 'Ticket da conservare.' } });
    const removed = await panels.delete(IDS.guild, IDS.owner, panel.id, [repaired.panel.messageId]);
    assert.equal(removed.ticketCount, 1);
    assert.ok(tickets.get(IDS.guild, ticket.id));
    assert.equal(channels.has(panel.channelId), true);
  } finally { db.close(); }
});

test('Errore Discord parziale ripulisce soltanto risorse nuove e vuote', async () => {
  const { db, guild, channels, panels } = setup();
  try {
    const manager = guild.channels as unknown as { create: (options: { name?: string; type?: ChannelType; parent?: string }) => Promise<ReturnType<typeof makeFakeChannel>> };
    const originalCreate = manager.create.bind(manager);
    manager.create = async (options) => {
      const channel = await originalCreate(options);
      if (options.type === ChannelType.GuildText && options.name?.startsWith('apri-ticket-')) {
        channel.send = async () => { throw new Error('errore Discord di prova'); };
      }
      return channel;
    };
    const result = await panels.create(IDS.guild, IDS.owner, randomUUID(), panelInput());
    assert.equal(result.status, 'failed');
    assert.match(result.error ?? '', /Discord non ha completato la creazione/);
    assert.equal(panels.list(IDS.guild).length, 0);
    assert.equal(channels.size, 0);
  } finally { db.close(); }
});

test('Importa il pannello precedente e conserva i ticket già registrati', async () => {
  const { db, channels, panels } = setup();
  try {
    const legacyChannel = makeFakeChannel(IDS.guild, '777777777777777778', IDS.guild);
    legacyChannel.messageCollection.set('777777777777777779', { id: '777777777777777779', embeds: [], content: 'Pannello precedente' });
    channels.set(legacyChannel.id, legacyChannel);
    const now = new Date().toISOString();
    db.prepare('INSERT INTO ticket_panels(guild_id, channel_id, message_id, updated_at) VALUES (?, ?, ?, ?)')
      .run(IDS.guild, legacyChannel.id, '777777777777777779', now);
    const ticketId = randomUUID();
    db.prepare(`INSERT INTO tickets(id, guild_id, opener_id, category_key, status, opened_at) VALUES (?, ?, ?, 'assistenza', 'open', ?)`)
      .run(ticketId, IDS.guild, IDS.user, now);

    const imported = await panels.importLegacyPanels();
    assert.equal(imported.imported, 1);
    const panel = panels.list(IDS.guild)[0];
    assert.equal(panel?.id, `legacy-${IDS.guild}`);
    assert.equal(panel?.channelId, legacyChannel.id);
    const linkedTicket = db.prepare('SELECT panel_id FROM tickets WHERE guild_id = ? AND id = ?').get(IDS.guild, ticketId) as { panel_id: string };
    assert.equal(linkedTicket.panel_id, panel?.id);
    assert.equal((await legacyChannel.messages.fetch('777777777777777779') as { id: string }).id, '777777777777777779');
  } finally { db.close(); }
});

test('Bot offline e server diverso non vengono dichiarati riusciti', async () => {
  const offline = setup();
  try {
    (offline.client as unknown as { isReady: () => boolean }).isReady = () => false;
    const result = await offline.panels.create(IDS.guild, IDS.owner, randomUUID(), panelInput());
    assert.equal(result.status, 'failed');
    assert.match(result.error ?? '', /offline/i);
    assert.equal(offline.panels.list(IDS.guild).length, 0);
    const foreign = await offline.panels.create('222222222222222222', IDS.owner, randomUUID(), panelInput());
    assert.notEqual(foreign.status, 'completed');
  } finally { offline.db.close(); }
});

test('Mostra i permessi mancanti dell’operatore e del bot senza richiedere Administrator', async () => {
  const operator = setup();
  try {
    const result = await operator.panels.create(IDS.guild, IDS.otherUser, randomUUID(), panelInput());
    assert.equal(result.status, 'failed');
    assert.match(result.error ?? '', /Gestisci canali per l’operatore/);
    assert.equal(operator.channels.size, 0);
  } finally { operator.db.close(); }

  const bot = setup();
  try {
    const memberManager = bot.guild.members as unknown as { fetch: (id: string) => Promise<unknown> };
    const originalFetch = memberManager.fetch.bind(memberManager);
    memberManager.fetch = async (id: string) => {
      if (id === IDS.bot) return { id, guild: bot.guild, user: { id, username: 'guardian', bot: true }, roles: { highest: { position: 20 } }, permissions: { has: () => false } } as never;
      return originalFetch(id);
    };
    const result = await bot.panels.create(IDS.guild, IDS.owner, randomUUID(), panelInput());
    assert.equal(result.status, 'failed');
    assert.match(result.error ?? '', /Gestisci canali per il bot/);
    assert.equal(bot.channels.size, 0);
  } finally { bot.db.close(); }
});

test('Il recupero del ticket riusa il canale deterministico e non duplica il messaggio', async () => {
  const { db, guild, channels, tickets } = setup();
  try {
    const ticketId = randomUUID();
    const name = `ticket-${IDS.user.slice(-6)}-${ticketId.slice(0, 4)}`;
    const channel = await guild.channels.create({ name, type: ChannelType.GuildText, topic: `tlpg-ticket:${ticketId}`, permissionOverwrites: [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: IDS.user, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
      { id: IDS.bot, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageChannels] },
      { id: IDS.staffRole, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
    ] });
    const fakeChannel = channels.get(channel.id)!;
    db.prepare(`INSERT INTO tickets(id, guild_id, channel_id, opener_id, category_key, status, opened_at, form_data_json)
      VALUES (?, ?, NULL, ?, 'assistenza', 'creating', ?, ?)`)
      .run(ticketId, IDS.guild, IDS.user, new Date(Date.now() - 10_000).toISOString(), JSON.stringify({ descrizione: 'Richiesta recuperata.' }));
    const first = await tickets.recoverIncomplete();
    assert.equal(first.recovered, 1);
    assert.equal(tickets.get(IDS.guild, ticketId).status, 'open');
    assert.equal(fakeChannel.messageCollection.size, 1);
    const second = await tickets.recoverIncomplete();
    assert.equal(second.recovered, 0);
    assert.equal(fakeChannel.messageCollection.size, 1);
    assert.equal(channels.has(channel.id), true);
  } finally { db.close(); }
});
