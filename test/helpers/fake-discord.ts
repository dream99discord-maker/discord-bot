import { ChannelType, Collection, PermissionFlagsBits, PermissionsBitField, type Client, type Guild, type GuildMember, type TextChannel } from 'discord.js';

export const IDS = {
  guild: '111111111111111111',
  owner: '222222222222222222',
  staffRole: '333333333333333333',
  bot: '444444444444444444',
  user: '555555555555555555',
  otherUser: '666666666666666666',
};

export interface FakeMessagePayload { content?: string; embeds?: unknown[]; components?: unknown[]; allowedMentions?: unknown; }

function overwrite(type: 0 | 1, allow: bigint | string | bigint[], deny: bigint | string | bigint[]) {
  return { type, allow: new PermissionsBitField(allow as never), deny: new PermissionsBitField(deny as never) };
}

export function makeFakeChannel(
  guildId: string,
  id: string,
  everyoneId: string,
  permissionEntries?: Array<{ id: string; allow?: bigint[]; deny?: bigint[]; type?: 0 | 1 }>,
  options: { type?: ChannelType; name?: string; parentId?: string | null; topic?: string | null; allChannels?: () => Iterable<ReturnType<typeof makeFakeChannel>>; onDelete?: () => void } = {},
) {
  const cache = new Collection<string, ReturnType<typeof overwrite>>();
  for (const item of permissionEntries ?? []) cache.set(item.id, overwrite(item.type ?? 0, item.allow ?? [], item.deny ?? []));
  const sent: FakeMessagePayload[] = [];
  const sentMessages: Array<{ id: string; embeds: Array<{ footer?: { text: string } }>; delete: () => Promise<void> }> = [];
  let nextMessageId = 700000000000000000n;
  const manager = {
    cache,
    async edit(target: string | { id: string }, rawOptions: Record<string, unknown>) {
      const targetId = typeof target === 'string' ? target : target.id;
      const old = cache.get(targetId) ?? overwrite(targetId === everyoneId ? 0 : 1, [], []);
      let allow = old.allow.bitfield;
      let deny = old.deny.bitfield;
      if (typeof rawOptions['allow'] === 'bigint') allow = rawOptions['allow'];
      if (typeof rawOptions['deny'] === 'bigint') deny = rawOptions['deny'];
      for (const [key, value] of Object.entries(rawOptions)) {
        if (key === 'allow' || key === 'deny') continue;
        const bit = PermissionFlagsBits[key as keyof typeof PermissionFlagsBits];
        if (typeof bit !== 'bigint') continue;
        allow &= ~bit;
        deny &= ~bit;
        if (value === true) allow |= bit;
        if (value === false) deny |= bit;
      }
      const updated = overwrite(old.type as 0 | 1, allow, deny);
      cache.set(targetId, updated);
      return updated;
    },
    async delete(target: string | { id: string }) {
      const targetId = typeof target === 'string' ? target : target.id;
      cache.delete(targetId);
    },
  };
  const messageCollection = new Collection<string, unknown>();
  const permissionsFor = (target: string | { id?: string }) => {
    const targetId = typeof target === 'string' ? target : target.id;
    return { has: (permission: bigint | bigint[]) => {
      const bits = Array.isArray(permission) ? permission : [permission];
      return bits.every((bit) => {
        const targetOverwrite = targetId ? cache.get(targetId) : undefined;
        const everyoneOverwrite = cache.get(everyoneId);
        if (targetOverwrite?.deny.has(bit)) return false;
        if (targetOverwrite?.allow.has(bit)) return true;
        if (everyoneOverwrite?.deny.has(bit)) return false;
        if (everyoneOverwrite?.allow.has(bit)) return true;
        return targetId !== everyoneId || bit !== PermissionFlagsBits.ViewChannel;
      });
    } };
  };
  const channel = {
    id,
    guildId,
    type: options.type ?? ChannelType.GuildText,
    name: options.name ?? 'ticket-test',
    parentId: options.parentId ?? null,
    topic: options.topic ?? null,
    position: 0,
    permissionOverwrites: manager,
    get children() {
      const children = new Collection<string, ReturnType<typeof makeFakeChannel>>();
      for (const child of options.allChannels?.() ?? []) if (child.parentId === id) children.set(child.id, child);
      return { cache: children };
    },
    messages: {
      async fetch(query?: string | { limit?: number }) {
        if (typeof query === 'string') {
          const message = messageCollection.get(query);
          if (!message) throw new Error('Unknown message');
          return message as never;
        }
        const limit = query?.limit ?? messageCollection.size;
        return new Collection([...messageCollection.entries()].slice(-limit)) as never;
      },
    },
    permissionsFor,
    async setParent(parentId: string, _options?: unknown) { channel.parentId = parentId; return channel; },
    async send(payload: FakeMessagePayload) {
      sent.push(payload);
      const embeds = (payload.embeds ?? []).map((embed) => typeof embed === 'object' && embed !== null && 'toJSON' in embed
        ? (embed as { toJSON(): unknown }).toJSON()
        : embed) as Array<{ footer?: { text: string } }>;
      const message = {
        id: String(nextMessageId++), embeds, components: payload.components ?? [],
        createdTimestamp: Date.now(), createdAt: new Date(),
        author: { id: IDS.bot, username: 'guardian' }, member: null,
        content: payload.content ?? '', allowedMentions: payload.allowedMentions,
        attachments: new Collection(),
        async edit(next: FakeMessagePayload) {
          if (next.content !== undefined) message.content = next.content;
          if (next.components !== undefined) message.components = next.components;
          if (next.allowedMentions !== undefined) message.allowedMentions = next.allowedMentions;
          if (next.embeds) message.embeds = next.embeds.map((embed) => typeof embed === 'object' && embed !== null && 'toJSON' in embed
            ? (embed as { toJSON(): unknown }).toJSON()
            : embed) as Array<{ footer?: { text: string } }>;
          return message;
        },
        async delete() {
          const index = sentMessages.indexOf(message);
          if (index >= 0) sentMessages.splice(index, 1);
          messageCollection.delete(message.id);
        },
      };
      sentMessages.push(message);
      messageCollection.set(message.id, message);
      return message;
    },
    async delete() { options.onDelete?.(); },
    sent,
    sentMessages,
    messageCollection,
  };
  return channel;
}
export function createFakeDiscord(guildId = IDS.guild) {
  const makeRole = (id: string, position: number, name: string) => ({
    id, position, name, color: '#000000', managed: false, guild: { id: guildId },
    comparePositionTo(other: { position?: number }) { return position - (other.position ?? 0); },
  });
  const role = makeRole(IDS.staffRole, 10, 'Staff');
  const everyoneRole = makeRole(guildId, 0, '@everyone');
  const members = new Map<string, Record<string, unknown>>();
  const guildChannels = new Collection<string, ReturnType<typeof makeFakeChannel>>();
  let channelSequence = 800000000000000000n;
  let guild: Record<string, unknown>;
  const createMember = (id: string) => {
    const member = {
      id,
      guild,
      user: { id, username: `user-${id.slice(-4)}`, tag: `user-${id.slice(-4)}#0001`, bot: id === IDS.bot, send: async () => ({}) },
      roles: { cache: new Collection<string, { id: string; position: number }>(), highest: everyoneRole },
      permissions: { has: (_permissions?: unknown) => id === IDS.bot || id === IDS.owner },
      communicationDisabledUntilTimestamp: null,
      async timeout() { return member; },
      async kick() { return undefined; },
    };
    if (id === IDS.user) {
      member.roles.cache.set(IDS.staffRole, role);
      member.roles.highest = role;
    }
    members.set(id, member as unknown as Record<string, unknown>);
    return member;
  };
  const channelManager = {
    cache: guildChannels,
    async create(options: { name?: string; type?: ChannelType; parent?: string; topic?: string; permissionOverwrites?: Array<{ id: string; allow?: bigint[]; deny?: bigint[]; type?: 0 | 1 }> }) {
      const id = String(channelSequence++);
      const channel = makeFakeChannel(guildId, id, guildId, options.permissionOverwrites, {
        type: options.type ?? ChannelType.GuildText,
        ...(options.name ? { name: options.name } : {}),
        parentId: options.parent ?? null,
        topic: options.topic ?? null,
        allChannels: () => guildChannels.values(),
        onDelete: () => { guildChannels.delete(id); },
      });
      guildChannels.set(channel.id, channel);
      return channel;
    },
    async fetch(id?: string) { return id ? guildChannels.get(id) ?? null : guildChannels as never; },
  };
  guild = {
    id: guildId,
    ownerId: IDS.owner,
    name: 'Server test',
    roles: {
      everyone: everyoneRole,
      cache: new Collection([[everyoneRole.id, everyoneRole], [role.id, role]]),
      async fetch(id?: string) { return id ? id === IDS.staffRole ? role : id === guildId ? everyoneRole : null : new Collection([[everyoneRole.id, everyoneRole], [role.id, role]]) as never; },
    },
    members: {
      async fetch(id: string) { return members.get(id) ?? createMember(id); },
    },
    channels: channelManager,
    bans: { async fetch() { return null; } },
    async fetchAuditLogs() { return { entries: new Collection() }; },
  };
  const client = {
    user: { id: IDS.bot },
    isReady: () => true,
    guilds: { cache: new Collection([[guildId, guild]]), async fetch(id: string) { return id === guildId ? guild : null; } },
    users: { async fetch(id: string) { return createMember(id).user; } },
    destroy() {},
  } as unknown as Client;
  createMember(IDS.owner);
  createMember(IDS.bot);
  createMember(IDS.user);
  return { client, guild: guild as unknown as Guild, members, channels: guildChannels };
}
export function fakeMessage(guild: Guild, userId: string, channelId: string, content: string) {
  return {
    id: '777777777777777777',
    guild,
    guildId: guild.id,
    channelId,
    channel: guild.channels.cache.get(channelId),
    author: { id: userId, username: 'utente', bot: false },
    member: { id: userId, roles: { cache: new Collection() }, permissions: { has: () => false } },
    mentions: { users: new Collection(), roles: new Collection(), everyone: false },
    content,
    async delete() { return undefined; },
  };
}
