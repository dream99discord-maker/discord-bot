import { randomUUID } from 'node:crypto';
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder, PermissionFlagsBits,
  StringSelectMenuBuilder, TextInputBuilder, TextInputStyle, ModalBuilder, type Client,
  type Guild, type GuildMember, type Interaction, type PermissionOverwriteOptions, type Role, type TextChannel,
} from 'discord.js';
import type { DatabaseHandle } from '../db.js';
import { audit } from '../db.js';
import { AppError, AuthorizationError, ConflictError, NotFoundError } from '../errors.js';
import type { GuildSettings } from '../settings.js';
import type { ManagedTicketPanelInput } from './ticket-panel-service.js';

interface TicketRow {
  id: string; guild_id: string; channel_id: string | null; opener_id: string; category_key: string;
  status: 'creating' | 'open' | 'closing' | 'closed' | 'failed'; assigned_to: string | null;
  close_reason: string | null; opened_at: string; closed_at: string | null;
  transcript_message_id: string | null; panel_id: string | null; panel_config_json: string | null; form_data_json: string; interaction_id: string | null; ticket_category_id: string | null;
}
export type TicketStatus = TicketRow['status'];
interface StaffPermissionRow { role_id: string; previous_allow: string; previous_deny: string; applied_allow: string; applied_deny: string; }
interface ManagedPanelOpenConfig {
  categories: GuildSettings['tickets']['categories']; staffRoleIds?: string[]; color?: string;
  ticketCategory?: { mode: 'existing' | 'create'; id?: string };
  maxOpenPerUser?: number; maxConcurrentTotal?: number; cooldownSeconds?: number;
}

export interface TicketView {
  id: string; guildId: string; channelId: string | null; openerId: string; categoryKey: string;
  status: TicketRow['status']; assignedTo: string | null; closeReason: string | null;
  openedAt: string; closedAt: string | null; panelId: string | null;
}
export interface TicketMessageView {
  id: string; authorId: string; authorName: string; bot: boolean; content: string; createdAt: string;
  attachments: string[];
}

function view(row: TicketRow): TicketView {
  return { id: row.id, guildId: row.guild_id, channelId: row.channel_id, openerId: row.opener_id,
    categoryKey: row.category_key, status: row.status, assignedTo: row.assigned_to,
    closeReason: row.close_reason, openedAt: row.opened_at, closedAt: row.closed_at, panelId: row.panel_id };
}

export class TicketService {
  constructor(private readonly db: DatabaseHandle, private readonly client: Client) {}

  async createPanel(guildId: string, settings: GuildSettings, channelOverride?: string): Promise<{ channelId: string; messageId: string }> {
    if (!settings.modules.tickets || !settings.tickets.enabled) throw new AppError('Il modulo ticket è disattivato.', 409, 'MODULO_DISATTIVATO');
    const guild = await this.getGuild(guildId);
    const channelId = channelOverride ?? settings.channels.ticketPanel;
    if (!channelId) throw new AppError('Configura prima il canale del pannello ticket.', 409, 'CANALE_NON_CONFIGURATO');
    const channel = await this.getTextChannel(guild, channelId);
    await this.assertBotPermissions(guild, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks]);
    const menu = new StringSelectMenuBuilder().setCustomId('ticket:select').setPlaceholder('Scegli una categoria')
      .setMinValues(1).setMaxValues(1)
      .addOptions(settings.tickets.categories.map((category) => ({ label: category.label, value: category.key, description: category.description })));
    const embed = new EmbedBuilder().setColor(Number.parseInt(settings.general.color.slice(1), 16)).setAuthor({ name: settings.general.name }).setTitle(settings.messages.ticketPanelTitle)
      .setDescription(settings.messages.ticketPanelDescription)
      .setFooter({ text: settings.general.footer });
    const old = this.db.prepare('SELECT message_id FROM ticket_panels WHERE guild_id = ?').get(guildId) as { message_id: string } | undefined;
    let message;
    if (old && channel.id === (this.db.prepare('SELECT channel_id FROM ticket_panels WHERE guild_id = ?').get(guildId) as { channel_id: string }).channel_id) {
      try { message = await channel.messages.fetch(old.message_id); } catch { /* Il pannello è stato rimosso: ne viene creato uno nuovo. */ }
    }
    if (message) await message.edit({ embeds: [embed], components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)], allowedMentions: { parse: [] } });
    else message = await channel.send({ embeds: [embed], components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)], allowedMentions: { parse: [] } });
    this.db.prepare(`INSERT INTO ticket_panels(guild_id, channel_id, message_id, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(guild_id) DO UPDATE SET channel_id = excluded.channel_id, message_id = excluded.message_id, updated_at = excluded.updated_at`)
      .run(guildId, channel.id, message.id, new Date().toISOString());
    return { channelId: channel.id, messageId: message.id };
  }

  async showTicketModal(interaction: Interaction, categoryKey: string, panelId?: string): Promise<void> {
    if ((!interaction.isStringSelectMenu() && !interaction.isButton()) || !interaction.guildId || !interaction.inGuild()) throw new AppError('Questo pannello è valido soltanto nel server.', 400);
    const guildId = interaction.guildId;
    const settings = this.readSettings(guildId);
    let category: GuildSettings['tickets']['categories'][number] | undefined;
    let modalCustomId: string;
    if (panelId) {
      const panel = this.db.prepare('SELECT channel_id, message_id, config_json, status FROM ticket_panels_managed WHERE guild_id = ? AND id = ?')
        .get(guildId, panelId) as { channel_id: string; message_id: string; config_json: string; status: string } | undefined;
      if (!panel || panel.status !== 'active' || panel.channel_id !== interaction.channelId || panel.message_id !== interaction.message.id) throw new AuthorizationError('Il pannello ticket è disattivato, non registrato o non appartiene a questo server.');
      const config = JSON.parse(panel.config_json) as { categories: GuildSettings['tickets']['categories'] };
      category = config.categories.find((item) => item.key === categoryKey);
      modalCustomId = `ticket:submit:p:${panelId}:${categoryKey}`;
    } else {
      const panel = this.db.prepare('SELECT channel_id, message_id FROM ticket_panels WHERE guild_id = ?').get(guildId) as { channel_id: string; message_id: string } | undefined;
      if (!panel || panel.channel_id !== interaction.channelId || panel.message_id !== interaction.message.id) throw new AuthorizationError('Il pannello ticket non è più valido.');
      const managed = this.db.prepare('SELECT id, config_json, status FROM ticket_panels_managed WHERE guild_id = ? AND channel_id = ? AND message_id = ?')
        .get(guildId, interaction.channelId, interaction.message.id) as { id: string; config_json: string; status: string } | undefined;
      if (managed) {
        if (managed.status !== 'active') throw new AuthorizationError('Il pannello ticket è disattivato o richiede riparazione.');
        panelId = managed.id;
        const config = JSON.parse(managed.config_json) as { categories: GuildSettings['tickets']['categories'] };
        category = config.categories.find((item) => item.key === categoryKey);
        modalCustomId = `ticket:submit:p:${panelId}:${categoryKey}`;
      } else {
        category = settings.tickets.categories.find((item) => item.key === categoryKey);
        modalCustomId = `ticket:submit:${panel.message_id}:${categoryKey}`;
      }
    }
    if (!category || !settings.modules.tickets || (!panelId && !settings.tickets.enabled)) throw new AppError('Questa categoria ticket non è disponibile.', 404);
    const modal = new ModalBuilder().setCustomId(modalCustomId).setTitle(category.label.slice(0, 45));
    const rows = category.fields.map((field) => new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId(field.key).setLabel(field.label).setStyle(field.style === 'paragraph' ? TextInputStyle.Paragraph : TextInputStyle.Short)
        .setRequired(field.required).setMaxLength(field.style === 'paragraph' ? 1500 : 100),
    ));
    modal.addComponents(...rows);
    await interaction.showModal(modal);
  }
  async openFromModal(input: { guildId: string; userId: string; panelMessageId?: string; panelId?: string; interactionId?: string; categoryKey: string; fields: Record<string, string> }): Promise<TicketView> {
    const { guildId, userId, categoryKey, fields } = input;
    const settings = this.readSettings(guildId);
    if (!settings.modules.tickets) throw new AppError('Il modulo ticket è disattivato.', 409, 'MODULO_DISATTIVATO');
    let panelId = input.panelId ?? null;
    let panelConfig: ManagedPanelOpenConfig | null = null;
    let panelResource: { channelId: string; messageId: string } | null = null;
    if (panelId) {
      const panel = this.db.prepare('SELECT channel_id, message_id, config_json, status FROM ticket_panels_managed WHERE guild_id = ? AND id = ?')
        .get(guildId, panelId) as { channel_id: string; message_id: string; config_json: string; status: string } | undefined;
      if (!panel || panel.status !== 'active') throw new AuthorizationError('Il pannello ticket non è attivo o non appartiene a questo server.');
      panelConfig = JSON.parse(panel.config_json) as ManagedPanelOpenConfig;
      panelResource = { channelId: panel.channel_id, messageId: panel.message_id };
    } else {
      if (!input.panelMessageId) throw new AuthorizationError('Il pannello ticket non è più valido.');
      const panel = this.db.prepare('SELECT channel_id, message_id FROM ticket_panels WHERE guild_id = ?').get(guildId) as { channel_id: string; message_id: string } | undefined;
      if (!panel || panel.message_id !== input.panelMessageId) throw new AuthorizationError('Il pannello ticket è scaduto o è stato sostituito.');
      panelResource = { channelId: panel.channel_id, messageId: panel.message_id };
      if (!settings.tickets.enabled) throw new AppError('Il modulo ticket è disattivato.', 409, 'MODULO_DISATTIVATO');
    }
    const category = (panelConfig?.categories ?? settings.tickets.categories).find((item) => item.key === categoryKey);
    if (!category) throw new NotFoundError('Categoria ticket non trovata.');
    const roleIds = category.staffRoleIds.length ? category.staffRoleIds : panelConfig?.staffRoleIds?.length ? panelConfig.staffRoleIds : settings.permissions.roles.ticketStaff;
    if (roleIds.length === 0) throw new AppError('Lo staff del ticket non è configurato: aggiungi almeno un ruolo autorizzato.', 409, 'STAFF_NON_CONFIGURATO');
    for (const field of category.fields) {
      const value = fields[field.key]?.trim() ?? '';
      if (field.required && value.length === 0) throw new AppError(`Il campo “${field.label}” è obbligatorio.`);
      if (value.length > (field.style === 'paragraph' ? 1500 : 100)) throw new AppError(`Il campo “${field.label}” supera il limite consentito.`);
    }
    const summaryText = category.fields.map((field) => `**${field.label}**\n${this.safeEmbedText(fields[field.key] ?? '—')}`).join('\n\n');
    if (summaryText.length > 3900) throw new AppError('Il riepilogo del modulo supera il limite di Discord. Riduci il testo dei campi e invia di nuovo.');
    if (input.interactionId) {
      const prior = this.db.prepare('SELECT * FROM tickets WHERE guild_id = ? AND interaction_id = ?').get(guildId, input.interactionId) as TicketRow | undefined;
      if (prior?.status === 'open') return view(prior);
      if (prior) throw new ConflictError('Questa richiesta è già stata registrata ed è in fase di ripristino. Contatta lo staff se il canale non compare.');
    }
    const guild = await this.getGuild(guildId);
    if (panelResource) {
      const panelChannel = await this.getTextChannel(guild, panelResource.channelId);
      const liveMessage = await panelChannel.messages.fetch(panelResource.messageId).catch(() => null);
      if (!liveMessage) throw new AppError('Il messaggio del pannello non esiste più. Chiedi allo staff di ripararlo dalla dashboard.', 409, 'MESSAGGIO_PANNELLO_MANCANTE');
    }
    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) throw new AuthorizationError('Devi appartenere al server per aprire un ticket.');
    await this.assertBotPermissions(guild, [PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory]);
    const staffRoles = await this.validateRoles(guild, roleIds);
    const now = new Date();
    const ticketId = randomUUID();
    const openedAt = now.toISOString();
    const deterministicChannelName = `ticket-${userId.slice(-6)}-${ticketId.slice(0, 8)}`;
    try {
      this.db.transaction(() => {
        const openCount = this.db.prepare(`SELECT COUNT(*) AS amount FROM tickets WHERE guild_id = ? AND opener_id = ? AND status IN ('creating','open','closing') AND (? IS NULL OR panel_id = ?)`)
          .get(guildId, userId, panelId, panelId) as { amount: number };
        const maxOpen = panelConfig?.maxOpenPerUser ?? settings.tickets.maxOpenPerUser;
        if (openCount.amount >= maxOpen) throw new ConflictError('Hai già raggiunto il limite di ticket aperti per questo pannello.');
        if (panelConfig?.maxConcurrentTotal) {
          const total = this.db.prepare(`SELECT COUNT(*) AS amount FROM tickets WHERE guild_id = ? AND panel_id = ? AND status IN ('creating','open','closing')`)
            .get(guildId, panelId) as { amount: number };
          if (total.amount >= panelConfig.maxConcurrentTotal) throw new ConflictError('Questo pannello ha raggiunto il numero massimo di ticket contemporanei.');
        }
        const cooldown = panelConfig?.cooldownSeconds ?? settings.tickets.cooldownSeconds;
        const recent = this.db.prepare(`SELECT opened_at FROM tickets WHERE guild_id = ? AND opener_id = ? AND status <> 'failed' AND (? IS NULL OR panel_id = ?) ORDER BY opened_at DESC LIMIT 1`)
          .get(guildId, userId, panelId, panelId) as { opened_at: string } | undefined;
        if (recent && now.getTime() - Date.parse(recent.opened_at) < cooldown * 1000) {
          const seconds = Math.ceil((cooldown * 1000 - (now.getTime() - Date.parse(recent.opened_at))) / 1000);
          throw new ConflictError(`Attendi ancora ${seconds} secondi prima di aprire un altro ticket.`);
        }
        this.db.prepare(`INSERT INTO tickets(id, guild_id, opener_id, category_key, panel_id, panel_config_json, form_data_json, interaction_id, status, opened_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'creating', ?)`)
          .run(ticketId, guildId, userId, categoryKey, panelId, panelConfig ? JSON.stringify(panelConfig) : null, JSON.stringify(fields), input.interactionId ?? null, openedAt);
        this.db.prepare(`INSERT INTO ticket_operations(id, guild_id, actor_id, operation_kind, idempotency_key, status, request_json, resources_json, created_at, updated_at)
          VALUES (?, ?, ?, 'ticket.open', ?, 'in_progress', ?, '{}', ?, ?)`)
          .run(ticketId, guildId, userId, input.interactionId ?? ticketId, JSON.stringify({ ticketId, panelId, categoryKey }), openedAt, openedAt);
        this.db.prepare(`INSERT INTO ticket_events(guild_id, ticket_id, actor_id, event_type, detail, created_at) VALUES (?, ?, ?, 'created', ?, ?)`)
          .run(guildId, ticketId, userId, JSON.stringify({ categoryKey, panelId }), openedAt);
      }).immediate();
    } catch (error) {
      if (input.interactionId) {
        const prior = this.db.prepare('SELECT * FROM tickets WHERE guild_id = ? AND interaction_id = ?').get(guildId, input.interactionId) as TicketRow | undefined;
        if (prior?.status === 'open') return view(prior);
      }
      throw error;
    }
    let createdChannel: TextChannel | undefined;
    try {
      const parentId = panelId ? this.managedTicketCategoryId(guildId, panelId) : settings.channels.ticketParent;
      const parent = parentId ? await guild.channels.fetch(parentId) : null;
      if (parentId && (!parent || parent.guildId !== guildId || parent.type !== ChannelType.GuildCategory)) throw new AppError('La categoria Discord configurata per i ticket non è valida. Ripara il pannello dalla dashboard.', 409, 'CATEGORIA_NON_VALIDA');
      if (parent?.permissionsFor(guild.roles.everyone)?.has(PermissionFlagsBits.ViewChannel)) throw new AuthorizationError('La categoria dei ticket è visibile a @everyone. Il canale non verrà creato finché la categoria non sarà privata.');
      if (parentId) this.db.prepare('UPDATE tickets SET ticket_category_id = ? WHERE guild_id = ? AND id = ?').run(parentId, guildId, ticketId);
      const botUserId = this.client.user?.id;
      if (!botUserId) throw new AppError('Il bot non è connesso a Discord.', 503, 'BOT_NON_CONNESSO');
      const channel = await guild.channels.create({
        name: deterministicChannelName,
        type: ChannelType.GuildText,
        topic: `tlpg-ticket:${ticketId}`,
        ...(parent ? { parent: parent.id } : {}),
        reason: `Ticket ${ticketId} aperto da ${userId}`,
        permissionOverwrites: [
          { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
          { id: userId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles] },
          { id: botUserId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.AttachFiles] },
          ...staffRoles.map((role) => ({ id: role.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles] })),
        ],
      });
      if (channel.type !== ChannelType.GuildText) throw new AppError('Discord non ha creato un canale testuale per il ticket.', 502);
      const textChannel = channel as TextChannel;
      createdChannel = textChannel;
      const channelLink = this.db.prepare(`UPDATE tickets SET channel_id = ? WHERE guild_id = ? AND id = ? AND status = 'creating'`).run(textChannel.id, guildId, ticketId);
      if (channelLink.changes !== 1) throw new ConflictError('Il ticket è cambiato durante la creazione.');
      this.db.prepare('UPDATE ticket_operations SET resources_json = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify({ ticketId, channelId: textChannel.id }), new Date().toISOString(), ticketId);
      await this.assertChannelPermissions(textChannel, botUserId, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory]);
      if (textChannel.permissionsFor(guild.roles.everyone)?.has(PermissionFlagsBits.ViewChannel)) throw new AuthorizationError('Il canale ticket risulta visibile a @everyone: il ticket non verrà pubblicato.');
      for (const staffRole of staffRoles) {
        if (!textChannel.permissionsFor(staffRole.id)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory])) throw new AuthorizationError('I permessi effettivi del ruolo ticket staff non sono sufficienti.');
      }
      if (!textChannel.permissionsFor(userId)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.SendMessages])) throw new AuthorizationError('L’autore non dispone dei permessi effettivi nel canale ticket.');
      const embedColor = panelConfig?.color ?? settings.general.color;
      const embed = new EmbedBuilder().setColor(Number.parseInt(embedColor.slice(1), 16)).setAuthor({ name: settings.general.name }).setTitle(category.label)
        .setDescription(summaryText)
        .setFooter({ text: `Ticket ${ticketId} · ticket-open:${ticketId} · aperto da ${member.user.tag}` });
      const controls = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`ticket:assign:${ticketId}`).setLabel('Prendi in carico').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`ticket:close:${ticketId}`).setLabel('Chiudi ticket').setStyle(ButtonStyle.Danger),
      );
      await textChannel.send({ content: `Ticket di <@${userId}>`, embeds: [embed], components: [controls], allowedMentions: { users: [userId], parse: [] } });
      this.db.transaction(() => {
        const result = this.db.prepare(`UPDATE tickets SET channel_id = ?, status = 'open' WHERE guild_id = ? AND id = ? AND status = 'creating'`)
          .run(textChannel.id, guildId, ticketId);
        if (result.changes !== 1) throw new ConflictError('Il ticket è cambiato durante la creazione.');
        this.db.prepare(`UPDATE ticket_operations SET status = 'completed', result_json = ?, updated_at = ? WHERE id = ?`)
          .run(JSON.stringify({ ticketId, channelId: textChannel.id }), new Date().toISOString(), ticketId);
        for (const staffRole of staffRoles) {
          const overwrite = textChannel.permissionOverwrites.cache.get(staffRole.id);
          if (!overwrite) throw new AuthorizationError('Il permesso del ruolo ticket staff non è registrato nel canale.');
          this.db.prepare(`INSERT INTO ticket_staff_permissions(guild_id, ticket_id, role_id, previous_allow, previous_deny, applied_allow, applied_deny)
            VALUES (?, ?, ?, '0', '0', ?, ?)`)
            .run(guildId, ticketId, staffRole.id, overwrite.allow.bitfield.toString(), overwrite.deny.bitfield.toString());
        }
      }).immediate();
      audit(this.db, { guildId, actorId: userId, action: 'ticket.open', targetType: 'ticket', targetId: ticketId, result: 'ok', after: { channelId: textChannel.id, categoryKey, panelId } });
      return this.getTicket(ticketId, guildId);
    } catch (error) {
      let preserveForRecovery = false;
      if (!createdChannel) {
        await guild.channels.fetch().catch(() => null);
        const possible = guild.channels.cache.find((channel) => channel.guildId === guildId && channel.type === ChannelType.GuildText && channel.name === deterministicChannelName && channel.topic === `tlpg-ticket:${ticketId}`);
        if (possible?.type === ChannelType.GuildText) {
          createdChannel = possible as TextChannel;
          this.db.prepare('UPDATE tickets SET channel_id = ? WHERE guild_id = ? AND id = ?')
            .run(createdChannel.id, guildId, ticketId);
        }
      }
      if (createdChannel) {
        const messages = await createdChannel.messages.fetch({ limit: 1 }).catch(() => null);
        preserveForRecovery = Boolean(messages?.size);
        if (!preserveForRecovery) {
          await createdChannel.delete('Creazione ticket incompleta senza messaggi').catch(() => undefined);
          const remaining = await guild.channels.fetch(createdChannel.id).catch(() => null);
          preserveForRecovery = Boolean(remaining);
        }
      }
      if (!preserveForRecovery) this.db.prepare(`UPDATE tickets SET status = 'failed' WHERE guild_id = ? AND id = ? AND status = 'creating'`).run(guildId, ticketId);
      this.db.prepare('UPDATE ticket_operations SET status = ?, error_code = ?, error_message = ?, updated_at = ? WHERE id = ?')
        .run(preserveForRecovery ? 'recovery_needed' : 'failed', error instanceof AppError ? error.code : 'ERRORE_CREAZIONE_TICKET', 'Creazione non completata; il contenuto del modulo non viene copiato nei log.', new Date().toISOString(), ticketId);
      this.db.prepare(`INSERT INTO ticket_events(guild_id, ticket_id, actor_id, event_type, detail, created_at) VALUES (?, ?, ?, 'creation_failed', ?, ?)`)
        .run(guildId, ticketId, userId, 'Creazione incompleta; risorse con contenuti conservate per il ripristino.', new Date().toISOString());
      throw error;
    }
  }
  async recoverIncomplete(processStartedAt = new Date().toISOString()): Promise<{ recovered: number; failed: number }> {
    let recovered = 0;
    let failed = 0;
    this.db.prepare(`UPDATE ticket_operations SET status = 'recovery_needed', updated_at = ?
      WHERE operation_kind = 'ticket.open' AND status = 'in_progress' AND updated_at < ?`)
      .run(new Date().toISOString(), processStartedAt);
    const interruptedClosures = this.db.prepare(`SELECT id, guild_id FROM tickets WHERE status = 'closing' AND opened_at < ?`).all(processStartedAt) as Array<{ id: string; guild_id: string }>;
    for (const item of interruptedClosures) {
      try {
        const ticket = this.getTicketRow(item.id, item.guild_id);
        const guild = await this.getGuild(item.guild_id);
        const channel = ticket.channel_id ? await this.getTextChannel(guild, ticket.channel_id).catch(() => null) : null;
        if (channel) {
          const settings = this.readSettings(item.guild_id);
          const roles = this.staffRolesForTicket(item.guild_id, settings, ticket.category_key, ticket.panel_id, ticket.panel_config_json);
          const users = this.db.prepare('SELECT user_id FROM ticket_participants WHERE guild_id = ? AND ticket_id = ?').all(item.guild_id, item.id) as Array<{ user_id: string }>;
          for (const userId of new Set([ticket.opener_id, ...users.map((row) => row.user_id)])) {
            if (channel.permissionOverwrites.cache.get(userId)?.deny.has(PermissionFlagsBits.SendMessages)) await channel.permissionOverwrites.edit(userId, { SendMessages: true }, { reason: `Ripristino ticket interrotto ${item.id}` });
          }
          for (const roleId of roles) {
            if (channel.permissionOverwrites.cache.get(roleId)?.deny.has(PermissionFlagsBits.SendMessages)) await channel.permissionOverwrites.edit(roleId, { SendMessages: true }, { reason: `Ripristino ticket interrotto ${item.id}` });
          }
        }
        this.db.prepare(`UPDATE tickets SET status = 'open' WHERE guild_id = ? AND id = ? AND status = 'closing'`).run(item.guild_id, item.id);
        this.addTicketEvent(item.guild_id, item.id, 'system', 'close_recovered', 'Chiusura interrotta: ticket mantenuto per un nuovo tentativo.');
      } catch { failed++; }
    }
    const rows = this.db.prepare(`SELECT * FROM tickets WHERE status = 'creating' AND opened_at < ? ORDER BY opened_at LIMIT 100`).all(processStartedAt) as TicketRow[];
    for (const ticket of rows) {
      try {
        const settings = this.readSettings(ticket.guild_id);
        const panelConfig = ticket.panel_config_json ? JSON.parse(ticket.panel_config_json) as ManagedPanelOpenConfig : null;
        const category = (panelConfig?.categories ?? settings.tickets.categories).find((item) => item.key === ticket.category_key);
        if (!category) throw new NotFoundError('La tipologia del ticket non è più disponibile.');
        const roleIds = category.staffRoleIds.length ? category.staffRoleIds : panelConfig?.staffRoleIds?.length ? panelConfig.staffRoleIds : settings.permissions.roles.ticketStaff;
        const guild = await this.getGuild(ticket.guild_id);
        const botId = this.client.user?.id;
        if (!botId) throw new AppError('Il bot non è connesso a Discord.', 503, 'BOT_NON_CONNESSO');
        const staffRoles = await this.validateRoles(guild, roleIds);
        const member = await guild.members.fetch(ticket.opener_id).catch(() => null);
        const channelNames = [`ticket-${ticket.opener_id.slice(-6)}-${ticket.id.slice(0, 8)}`, `ticket-${ticket.opener_id.slice(-6)}-${ticket.id.slice(0, 4)}`];
        let rawChannel = ticket.channel_id ? await guild.channels.fetch(ticket.channel_id).catch(() => null) : null;
        rawChannel ??= guild.channels.cache.find((item) => item.guildId === ticket.guild_id && item.type === ChannelType.GuildText && channelNames.includes(item.name) && item.topic === `tlpg-ticket:${ticket.id}`) ?? null;
        const parentId = ticket.ticket_category_id ?? (ticket.panel_id ? this.tryManagedTicketCategoryId(ticket.guild_id, ticket.panel_id) : settings.channels.ticketParent);
        const parent = parentId ? await guild.channels.fetch(parentId).catch(() => null) : null;
        if (parentId && (!parent || parent.guildId !== ticket.guild_id || parent.type !== ChannelType.GuildCategory)) throw new AppError('La categoria privata è stata rimossa. Ripara il pannello prima di recuperare il ticket.', 409, 'CATEGORIA_TICKET_MANCANTE');
        if (!rawChannel) {
          rawChannel = await guild.channels.create({ name: channelNames[0]!, type: ChannelType.GuildText, topic: `tlpg-ticket:${ticket.id}`, ...(parent ? { parent: parent.id } : {}),
            reason: `Ripristino ticket incompleto ${ticket.id}`, permissionOverwrites: this.ticketOverwrites(guild, botId, ticket.opener_id, staffRoles) });
        }
        if (rawChannel.type !== ChannelType.GuildText || rawChannel.guildId !== ticket.guild_id) throw new AuthorizationError('Il canale trovato non appartiene al server o non è testuale.');
        const channel = rawChannel as TextChannel;
        this.db.prepare('UPDATE tickets SET channel_id = ?, ticket_category_id = ? WHERE guild_id = ? AND id = ?')
          .run(channel.id, parentId ?? null, ticket.guild_id, ticket.id);
        await channel.permissionOverwrites.edit(guild.roles.everyone.id, { ViewChannel: false }, { reason: `Ripristino privacy ticket ${ticket.id}` });
        await channel.permissionOverwrites.edit(ticket.opener_id, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true, AttachFiles: true }, { reason: `Ripristino accesso autore ticket ${ticket.id}` });
        await channel.permissionOverwrites.edit(botId, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true, ManageChannels: true, AttachFiles: true }, { reason: `Ripristino accesso bot ticket ${ticket.id}` });
        for (const role of staffRoles) await channel.permissionOverwrites.edit(role.id, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true, AttachFiles: true }, { reason: `Ripristino accesso staff ticket ${ticket.id}` });
        if (channel.permissionsFor(guild.roles.everyone)?.has(PermissionFlagsBits.ViewChannel)) throw new AuthorizationError('Il canale del ticket non risulta privato; il riepilogo non verrà pubblicato.');
        await this.assertChannelPermissions(channel, botId, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory]);
        const marker = `ticket-open:${ticket.id}`;
        const recent = await channel.messages.fetch({ limit: 50 }).catch(() => null);
        const messageExists = Boolean(recent?.some((message) => message.embeds.some((embed) => embed.footer?.text.includes(marker))));
        if (!messageExists) {
          const fields = JSON.parse(ticket.form_data_json || '{}') as Record<string, string>;
          const summaryText = category.fields.map((field) => `**${field.label}**\n${this.safeEmbedText(fields[field.key] ?? '—')}`).join('\n\n');
          if (summaryText.length > 3900) throw new AppError('Il riepilogo del modulo supera il limite di Discord; la richiesta è conservata per la riparazione.', 409, 'RIEPILOGO_TROPPO_GRANDE');
          const embedColor = panelConfig?.color ?? settings.general.color;
          const embed = new EmbedBuilder().setColor(Number.parseInt(embedColor.slice(1), 16)).setAuthor({ name: settings.general.name }).setTitle(category.label)
            .setDescription(summaryText)
            .setFooter({ text: `Ticket ${ticket.id} · ${marker} · aperto da ${member?.user.tag ?? ticket.opener_id}` });
          const controls = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId(`ticket:assign:${ticket.id}`).setLabel('Prendi in carico').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(`ticket:close:${ticket.id}`).setLabel('Chiudi ticket').setStyle(ButtonStyle.Danger),
          );
          await channel.send({ content: `Ticket di <@${ticket.opener_id}>`, embeds: [embed], components: [controls], allowedMentions: { users: [ticket.opener_id], parse: [] } });
        }
        this.db.transaction(() => {
          this.db.prepare(`UPDATE tickets SET status = 'open' WHERE guild_id = ? AND id = ? AND status = 'creating'`).run(ticket.guild_id, ticket.id);
          this.db.prepare(`UPDATE ticket_operations SET status = 'completed', result_json = ?, resources_json = ?, updated_at = ? WHERE id = ?`)
            .run(JSON.stringify({ ticketId: ticket.id, channelId: channel.id }), JSON.stringify({ ticketId: ticket.id, channelId: channel.id }), new Date().toISOString(), ticket.id);
          for (const role of staffRoles) {
            const overwrite = channel.permissionOverwrites.cache.get(role.id);
            if (!overwrite) continue;
            this.db.prepare(`INSERT INTO ticket_staff_permissions(guild_id, ticket_id, role_id, previous_allow, previous_deny, applied_allow, applied_deny)
              VALUES (?, ?, ?, '0', '0', ?, ?) ON CONFLICT(ticket_id, role_id) DO NOTHING`)
              .run(ticket.guild_id, ticket.id, role.id, overwrite.allow.bitfield.toString(), overwrite.deny.bitfield.toString());
          }
          this.addTicketEvent(ticket.guild_id, ticket.id, 'system', 'creation_recovered', 'Canale privato e riepilogo verificati senza duplicare la richiesta.');
        }).immediate();
        audit(this.db, { guildId: ticket.guild_id, actorId: 'system', action: 'ticket.recover', targetType: 'ticket', targetId: ticket.id, result: 'ok', after: { channelId: channel.id, panelId: ticket.panel_id } });
        recovered++;
      } catch {
        failed++;
        this.addTicketEvent(ticket.guild_id, ticket.id, 'system', 'recovery_pending', 'Ripristino non completato; risorse e dati sono conservati per un nuovo tentativo.');
      }
    }
    return { recovered, failed };
  }

  private ticketOverwrites(guild: Guild, botId: string, openerId: string, staffRoles: Role[]): Array<{ id: string; allow?: bigint[]; deny?: bigint[] }> {
    return [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: openerId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles] },
      { id: botId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.AttachFiles] },
      ...staffRoles.map((role) => ({ id: role.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles] })),
    ];
  }

  private tryManagedTicketCategoryId(guildId: string, panelId: string): string | null {
    return (this.db.prepare('SELECT ticket_category_id FROM ticket_panels_managed WHERE guild_id = ? AND id = ?').get(guildId, panelId) as { ticket_category_id: string } | undefined)?.ticket_category_id ?? null;
  }

  async assign(guildId: string, ticketId: string, actorId: string): Promise<TicketView> {
    const ticket = this.getTicketRow(ticketId, guildId);
    if (ticket.status !== 'open') throw new ConflictError('Questo ticket non è aperto.');
    await this.assertTicketStaff(guildId, ticket, actorId);
    if (ticket.assigned_to && ticket.assigned_to !== actorId) throw new ConflictError('Il ticket è già assegnato a un altro operatore.');
    const now = new Date().toISOString();
    const assigned = this.db.prepare(`UPDATE tickets SET assigned_to = ? WHERE guild_id = ? AND id = ? AND status = 'open' AND assigned_to IS NULL`).run(actorId, guildId, ticketId);
    if (assigned.changes === 0 && ticket.assigned_to !== actorId) throw new ConflictError('Il ticket è stato preso in carico da un altro operatore.');
    if (ticket.assigned_to === actorId) return this.getTicket(ticketId, guildId);
    this.addTicketEvent(guildId, ticketId, actorId, 'assigned', actorId);
    if (ticket.channel_id) {
      const channel = await this.getTextChannel(await this.getGuild(guildId), ticket.channel_id);
      await channel.send({ content: `Il ticket è stato preso in carico da <@${actorId}>.`, allowedMentions: { users: [actorId], parse: [] } });
    }
    audit(this.db, { guildId, actorId, action: 'ticket.assign', targetType: 'ticket', targetId: ticketId, result: 'ok', after: { assignedTo: actorId, at: now } });
    return this.getTicket(ticketId, guildId);
  }

  async addParticipant(guildId: string, ticketId: string, actorId: string, userId: string, remove = false): Promise<void> {
    const ticket = this.getTicketRow(ticketId, guildId);
    if (ticket.status !== 'open' || !ticket.channel_id) throw new ConflictError('Il ticket non è aperto.');
    await this.assertTicketStaff(guildId, ticket, actorId);
    const guild = await this.getGuild(guildId);
    const target = await guild.members.fetch(userId).catch(() => null);
    if (!target) throw new NotFoundError('L’utente non appartiene al server.');
    const channel = await this.getTextChannel(guild, ticket.channel_id);
    if (userId === ticket.opener_id) throw new ConflictError('L’autore del ticket è già partecipante.');
    if (remove) {
      const reservation = this.db.prepare('DELETE FROM ticket_participants WHERE guild_id = ? AND ticket_id = ? AND user_id = ?').run(guildId, ticketId, userId);
      if (!reservation.changes) throw new NotFoundError('L’utente non è un partecipante aggiunto.');
      const existingOverwrite = channel.permissionOverwrites.cache.get(userId);
      try {
        if (existingOverwrite) await channel.permissionOverwrites.delete(userId, `Rimosso dal ticket da ${actorId}`);
      } catch (error) {
        this.db.prepare('INSERT INTO ticket_participants(guild_id, ticket_id, user_id, added_by, added_at) VALUES (?, ?, ?, ?, ?)')
          .run(guildId, ticketId, userId, actorId, new Date().toISOString());
        throw error;
      }
      this.addTicketEvent(guildId, ticketId, actorId, 'participant_removed', userId);
    } else {
      if (this.db.prepare('SELECT 1 FROM ticket_participants WHERE guild_id = ? AND ticket_id = ? AND user_id = ?').get(guildId, ticketId, userId)) {
        throw new ConflictError('L’utente è già stato aggiunto a questo ticket.');
      }
      if (channel.permissionOverwrites.cache.has(userId)) throw new ConflictError('L’utente ha già un permesso manuale nel canale; non verrà modificato automaticamente.');
      this.db.prepare('INSERT INTO ticket_participants(guild_id, ticket_id, user_id, added_by, added_at) VALUES (?, ?, ?, ?, ?)')
        .run(guildId, ticketId, userId, actorId, new Date().toISOString());
      try {
        await channel.permissionOverwrites.edit(userId, {
          ViewChannel: true, SendMessages: true, ReadMessageHistory: true, AttachFiles: true,
        }, { reason: `Aggiunto al ticket da ${actorId}` });
      } catch (error) {
        await channel.permissionOverwrites.delete(userId, 'Annullamento aggiunta partecipante non completata').catch(() => undefined);
        this.db.prepare('DELETE FROM ticket_participants WHERE guild_id = ? AND ticket_id = ? AND user_id = ?').run(guildId, ticketId, userId);
        throw error;
      }
      this.addTicketEvent(guildId, ticketId, actorId, 'participant_added', userId);
    }
    audit(this.db, { guildId, actorId, action: remove ? 'ticket.participant.remove' : 'ticket.participant.add', targetType: 'ticket', targetId: ticketId, result: 'ok', after: { userId } });
  }

  async close(guildId: string, ticketId: string, actorId: string, reason: string): Promise<TicketView> {
    if (reason.trim().length < 3 || reason.trim().length > 500) throw new AppError('Il motivo di chiusura deve contenere da 3 a 500 caratteri.');
    const ticket = this.getTicketRow(ticketId, guildId);
    if (ticket.status !== 'open' || !ticket.channel_id) throw new ConflictError('Questo ticket non è aperto o non ha un canale valido.');
    await this.assertTicketAccess(guildId, ticket, actorId);
    const claim = this.db.transaction(() => {
      const result = this.db.prepare(`UPDATE tickets SET status = 'closing' WHERE guild_id = ? AND id = ? AND status = 'open'`).run(guildId, ticketId);
      if (result.changes !== 1) throw new ConflictError('Un’altra richiesta sta già chiudendo questo ticket.');
      this.addTicketEvent(guildId, ticketId, actorId, 'close_started', reason.slice(0, 500));
    }).immediate();
    void claim;
    const changedPermissions: Array<{ id: string; priorSendMessages: boolean | null }> = [];
    let closureNotice: import('discord.js').Message | undefined;
    let createdClosureNotice = false;
    let committed = false;
    try {
      const settings = this.readSettings(guildId);
      const guild = await this.getGuild(guildId);
      const channel = await this.getTextChannel(guild, ticket.channel_id);
      await this.assertBotPermissions(guild, [PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ViewChannel]);
      await this.assertChannelPermissions(channel, this.client.user!.id, [PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.SendMessages]);
      const transcript = await this.buildTranscript(channel, settings.tickets.transcriptMessageLimit);
      const now = new Date().toISOString();
      for (const [id, overwrite] of channel.permissionOverwrites.cache) {
        if (id === guild.roles.everyone.id || id === this.client.user!.id || overwrite.deny.has(PermissionFlagsBits.SendMessages)) continue;
        const priorSendMessages = overwrite.allow.has(PermissionFlagsBits.SendMessages) ? true : null;
        await channel.permissionOverwrites.edit(id, { SendMessages: false }, { reason: `Ticket ${ticketId} chiuso` });
        changedPermissions.push({ id, priorSendMessages });
      }
      const notice = `Ticket chiuso da <@${actorId}>. Motivo: ${this.safeEmbedText(reason)}. Trascrizione privata registrata nel backend.`;
      const closeMarker = `ticket-close:${ticketId}`;
      const recent = await channel.messages.fetch({ limit: 100 }).catch(() => null);
      closureNotice = recent?.find((message) => message.content.includes(closeMarker));
      if (!closureNotice) {
        closureNotice = await channel.send({ content: `${notice}\n${closeMarker}`, allowedMentions: { users: [actorId], parse: [] } });
        createdClosureNotice = true;
      }
      const commit = this.db.transaction(() => {
        const updated = this.db.prepare(`UPDATE tickets SET status = 'closed', close_reason = ?, closed_at = ? WHERE guild_id = ? AND id = ? AND status = 'closing'`)
          .run(reason.trim().slice(0, 500), now, guildId, ticketId);
        if (updated.changes !== 1) throw new ConflictError('Il ticket è cambiato durante la chiusura.');
        this.db.prepare(`INSERT INTO ticket_transcripts(guild_id, ticket_id, transcript_text, message_count, created_at)
          VALUES (?, ?, ?, ?, ?) ON CONFLICT(ticket_id) DO UPDATE SET transcript_text = excluded.transcript_text, message_count = excluded.message_count, created_at = excluded.created_at`)
          .run(guildId, ticketId, transcript.text, transcript.messageCount, now);
        this.addTicketEvent(guildId, ticketId, actorId, 'closed', JSON.stringify({ reason: reason.trim().slice(0, 500), transcriptMessages: transcript.messageCount }));
      }).immediate();
      void commit;
      committed = true;
      try { audit(this.db, { guildId, actorId, action: 'ticket.close', targetType: 'ticket', targetId: ticketId, result: 'ok', after: { reasonRecorded: true, transcriptMessages: transcript.messageCount } }); } catch { /* Il caso e la trascrizione sono già salvati in modo atomico. */ }
      return this.getTicket(ticketId, guildId);
    } catch (error) {
      if (!committed) {
        const guild = await this.getGuild(guildId).catch(() => null);
        const channel = guild && ticket.channel_id ? await this.getTextChannel(guild, ticket.channel_id).catch(() => null) : null;
        if (channel) {
          for (const changed of changedPermissions.reverse()) {
            await channel.permissionOverwrites.edit(changed.id, { SendMessages: changed.priorSendMessages }, { reason: `Annullata chiusura non riuscita del ticket ${ticketId}` }).catch(() => undefined);
          }
          if (createdClosureNotice && closureNotice) await closureNotice.delete().catch(() => undefined);
        }
        this.db.prepare(`UPDATE tickets SET status = 'open' WHERE guild_id = ? AND id = ? AND status = 'closing'`).run(guildId, ticketId);
      }
      this.addTicketEvent(guildId, ticketId, actorId, 'close_failed', error instanceof Error ? error.message.slice(0, 300) : 'errore sconosciuto');
      audit(this.db, { guildId, actorId, action: 'ticket.close', targetType: 'ticket', targetId: ticketId, result: 'failed' });
      throw new AppError('Non è stato possibile archiviare il ticket. Il canale e i messaggi sono stati mantenuti: verifica i permessi e riprova.', 502, 'ARCHIVIAZIONE_FALLITA');
    }
  }

  async list(guildId: string, options: { status?: TicketStatus; categoryKey?: string; panelId?: string; search?: string; limit?: number; offset?: number } = {}): Promise<TicketView[]> {
    const where = ['guild_id = ?'];
    const values: Array<string | number> = [guildId];
    if (options.status) { where.push('status = ?'); values.push(options.status); }
    if (options.categoryKey) { where.push('category_key = ?'); values.push(options.categoryKey); }
    if (options.panelId) { where.push('panel_id = ?'); values.push(options.panelId); }
    if (options.search) {
      where.push('(id LIKE ? OR opener_id LIKE ? OR category_key LIKE ?)');
      const search = `%${options.search.slice(0, 100)}%`;
      values.push(search, search, search);
    }
    values.push(Math.min(100, Math.max(1, options.limit ?? 50)), Math.max(0, Math.min(10000, options.offset ?? 0)));
    const rows = this.db.prepare(`SELECT * FROM tickets WHERE ${where.join(' AND ')} ORDER BY opened_at DESC LIMIT ? OFFSET ?`).all(...values) as TicketRow[];
    return rows.map(view);
  }

  get(guildId: string, ticketId: string): TicketView { return this.getTicket(ticketId, guildId); }

  participants(guildId: string, ticketId: string): Array<{ userId: string; addedBy: string; addedAt: string }> {
    this.getTicketRow(ticketId, guildId);
    return this.db.prepare(`SELECT user_id AS userId, added_by AS addedBy, added_at AS addedAt
      FROM ticket_participants WHERE guild_id = ? AND ticket_id = ? ORDER BY added_at`)
      .all(guildId, ticketId) as Array<{ userId: string; addedBy: string; addedAt: string }>;
  }

  async messages(guildId: string, ticketId: string, actorId: string, options: { limit?: number; before?: string } = {}): Promise<TicketMessageView[]> {
    const ticket = this.getTicketRow(ticketId, guildId);
    if (!ticket.channel_id) throw new NotFoundError('Il canale del ticket non è disponibile.');
    await this.assertTicketAccess(guildId, ticket, actorId);
    const guild = await this.getGuild(guildId);
    const channel = await this.getTextChannel(guild, ticket.channel_id);
    const member = await guild.members.fetch(actorId).catch(() => null);
    const bot = this.client.user;
    if (!member || !channel.permissionsFor(member)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory])) throw new AuthorizationError('Non hai accesso alla cronologia di questo ticket.');
    if (!bot || !channel.permissionsFor(bot.id)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory])) throw new AuthorizationError('Il bot non può leggere la cronologia del ticket.');
    const limit = Math.min(100, Math.max(1, Math.floor(options.limit ?? 50)));
    const page = await channel.messages.fetch({ limit, ...(options.before ? { before: options.before } : {}) });
    return [...page.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp).map((message) => ({
      id: message.id,
      authorId: message.author.id,
      authorName: message.member?.displayName ?? message.author.username,
      bot: message.author.bot,
      content: message.content,
      createdAt: message.createdAt.toISOString(),
      attachments: [...message.attachments.values()].map((attachment) => attachment.name).filter(Boolean),
    }));
  }

  async reply(guildId: string, ticketId: string, actorId: string, content: string): Promise<TicketMessageView> {
    const ticket = this.getTicketRow(ticketId, guildId);
    if (ticket.status !== 'open' || !ticket.channel_id) throw new ConflictError('È possibile rispondere soltanto a un ticket aperto.');
    if (content.trim().length < 1 || content.length > 2000) throw new AppError('La risposta deve contenere da 1 a 2000 caratteri.');
    await this.assertTicketStaff(guildId, ticket, actorId);
    const guild = await this.getGuild(guildId);
    const channel = await this.getTextChannel(guild, ticket.channel_id);
    const member = await guild.members.fetch(actorId).catch(() => null);
    const bot = this.client.user;
    if (!member || !bot || !channel.permissionsFor(bot.id)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
      throw new AuthorizationError('Il bot non può rispondere nel canale ticket.');
    }
    const displayName = member.displayName.replace(/@/g, '@\u200b').slice(0, 80);
    const embed = new EmbedBuilder().setColor(Number.parseInt(this.readSettings(guildId).general.color.slice(1), 16))
      .setAuthor({ name: `Risposta dello staff · ${displayName}` }).setDescription(content.trim())
      .setFooter({ text: `Operatore Discord ${actorId}` });
    const message = await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
    this.addTicketEvent(guildId, ticketId, actorId, 'staff_reply', JSON.stringify({ messageId: message.id }));
    audit(this.db, { guildId, actorId, action: 'ticket.reply', targetType: 'ticket', targetId: ticketId, result: 'ok', after: { messageId: message.id } });
    return { id: message.id, authorId: actorId, authorName: displayName, bot: true, content: content.trim(), createdAt: new Date().toISOString(), attachments: [] };
  }

  findByChannel(guildId: string, channelId: string): TicketView {
    const row = this.db.prepare('SELECT * FROM tickets WHERE guild_id = ? AND channel_id = ?').get(guildId, channelId) as TicketRow | undefined;
    if (!row) throw new NotFoundError('Questo canale non è un ticket registrato.');
    return view(row);
  }

  getTranscript(guildId: string, ticketId: string): { text: string; messageCount: number; createdAt: string } {
    const row = this.db.prepare('SELECT transcript_text, message_count, created_at FROM ticket_transcripts WHERE guild_id = ? AND ticket_id = ?')
      .get(guildId, ticketId) as { transcript_text: string; message_count: number; created_at: string } | undefined;
    if (!row) throw new NotFoundError('La trascrizione non è disponibile.');
    return { text: row.transcript_text, messageCount: row.message_count, createdAt: row.created_at };
  }

  async canRead(guildId: string, ticketId: string, userId: string): Promise<boolean> {
    const row = this.getTicketRow(ticketId, guildId);
    if (row.opener_id === userId || row.assigned_to === userId) return true;
    const participant = this.db.prepare('SELECT 1 FROM ticket_participants WHERE guild_id = ? AND ticket_id = ? AND user_id = ?')
      .get(guildId, ticketId, userId);
    if (participant) return true;
    try { await this.assertTicketStaff(guildId, row, userId); return true; } catch { return false; }
  }

  async hasDashboardStaffRole(guildId: string, userId: string): Promise<boolean> {
    const settings = this.readSettings(guildId);
    const guild = await this.getGuild(guildId);
    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) return false;
    if (member.id === guild.ownerId || member.permissions.has([PermissionFlagsBits.ManageGuild, PermissionFlagsBits.Administrator])) return true;
    const allowed = new Set([...settings.permissions.roles.ticketStaff, ...settings.tickets.categories.flatMap((category) => category.staffRoleIds)]);
    const panels = this.db.prepare('SELECT config_json FROM ticket_panels_managed WHERE guild_id = ?').all(guildId) as Array<{ config_json: string }>;
    for (const panel of panels) {
      const config = JSON.parse(panel.config_json) as { staffRoleIds?: string[]; categories?: Array<{ staffRoleIds?: string[] }> };
      for (const roleId of [...(config.staffRoleIds ?? []), ...(config.categories ?? []).flatMap((item) => item.staffRoleIds ?? [])]) allowed.add(roleId);
    }
    const ticketSnapshots = this.db.prepare(`SELECT DISTINCT panel_config_json FROM tickets WHERE guild_id = ? AND panel_config_json IS NOT NULL`).all(guildId) as Array<{ panel_config_json: string }>;
    for (const ticket of ticketSnapshots) {
      const config = JSON.parse(ticket.panel_config_json) as { staffRoleIds?: string[]; categories?: Array<{ staffRoleIds?: string[] }> };
      for (const roleId of [...(config.staffRoleIds ?? []), ...(config.categories ?? []).flatMap((item) => item.staffRoleIds ?? [])]) allowed.add(roleId);
    }
    return member.roles.cache.some((role) => allowed.has(role.id));
  }

  async canReadFromDashboard(guildId: string, ticketId: string, userId: string): Promise<boolean> {
    const row = this.getTicketRow(ticketId, guildId);
    if (row.opener_id === userId || row.assigned_to === userId) return true;
    const participant = this.db.prepare('SELECT 1 FROM ticket_participants WHERE guild_id = ? AND ticket_id = ? AND user_id = ?')
      .get(guildId, ticketId, userId);
    return Boolean(participant) || this.isStaffForTicket(guildId, row, userId);
  }

  async canManage(guildId: string, ticketId: string, userId: string): Promise<boolean> {
    const row = this.getTicketRow(ticketId, guildId);
    try { await this.assertTicketStaff(guildId, row, userId); return true; } catch { return false; }
  }

  async listForDashboard(guildId: string, userId: string, options: { status?: TicketStatus; categoryKey?: string; panelId?: string; search?: string; limit?: number; offset?: number } = {}): Promise<TicketView[]> {
    const guild = await this.getGuild(guildId);
    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) throw new AuthorizationError('Non appartieni più a questo server.');
    const privileged = member.id === guild.ownerId || member.permissions.has([PermissionFlagsBits.ManageGuild, PermissionFlagsBits.Administrator]);
    if (privileged) return this.list(guildId, options);
    const where = ['guild_id = ?'];
    const values: Array<string | number> = [guildId];
    if (options.status) { where.push('status = ?'); values.push(options.status); }
    if (options.categoryKey) { where.push('category_key = ?'); values.push(options.categoryKey); }
    if (options.panelId) { where.push('panel_id = ?'); values.push(options.panelId); }
    if (options.search) {
      where.push('(id LIKE ? OR opener_id LIKE ? OR category_key LIKE ?)');
      const search = `%${options.search.slice(0, 100)}%`;
      values.push(search, search, search);
    }
    values.push(10_000, 0);
    const candidates = (this.db.prepare(`SELECT * FROM tickets WHERE ${where.join(' AND ')} ORDER BY opened_at DESC LIMIT ? OFFSET ?`).all(...values) as TicketRow[]).map(view);
    const visible: TicketView[] = [];
    for (const ticket of candidates) {
      const row = this.getTicketRow(ticket.id, guildId);
      const roleIds = this.staffRolesForTicket(guildId, this.readSettings(guildId), row.category_key, row.panel_id, row.panel_config_json);
      if (member.roles.cache.some((role) => roleIds.has(role.id))) visible.push(ticket);
    }
    const offset = Math.max(0, Math.min(10_000, options.offset ?? 0));
    return visible.slice(offset, offset + Math.min(100, Math.max(1, options.limit ?? 50)));
  }

  async reconcileStaffAccess(guildId: string, previous: GuildSettings, next: GuildSettings): Promise<{ changed: number; failed: number }> {
    const guild = await this.getGuild(guildId);
    const botId = this.client.user?.id;
    if (!botId) throw new AppError('Il bot non è connesso a Discord.', 503, 'BOT_NON_CONNESSO');
    const bot = await guild.members.fetch(botId).catch(() => null);
    if (!bot?.permissions.has(PermissionFlagsBits.ManageChannels)) throw new AuthorizationError('Al bot manca Gestisci canali per aggiornare l’accesso ai ticket esistenti.');
    const openTickets = this.db.prepare(`SELECT * FROM tickets WHERE guild_id = ? AND status = 'open'`).all(guildId) as TicketRow[];
    let changed = 0;
    let failed = 0;
    for (const ticket of openTickets) {
      if (!ticket.channel_id) { failed++; continue; }
      const rawChannel = await guild.channels.fetch(ticket.channel_id).catch(() => null);
      if (!rawChannel || rawChannel.guildId !== guildId || rawChannel.type !== ChannelType.GuildText) { failed++; continue; }
      const channel = rawChannel as TextChannel;
      if (!channel.permissionsFor(bot)?.has(PermissionFlagsBits.ManageChannels)) { failed++; continue; }
      if (ticket.panel_id) continue;
      const oldRoles = this.staffRolesForTicket(guildId, previous, ticket.category_key);
      const newRoles = this.staffRolesForTicket(guildId, next, ticket.category_key);
      const tracked = this.db.prepare('SELECT role_id, previous_allow, previous_deny, applied_allow, applied_deny FROM ticket_staff_permissions WHERE guild_id = ? AND ticket_id = ?')
        .all(guildId, ticket.id) as StaffPermissionRow[];
      const trackedById = new Map(tracked.map((row) => [row.role_id, row]));

      for (const [roleId, permission] of trackedById) {
        if (newRoles.has(roleId)) continue;
        const current = channel.permissionOverwrites.cache.get(roleId);
        if (!current) {
          this.db.prepare('DELETE FROM ticket_staff_permissions WHERE guild_id = ? AND ticket_id = ? AND role_id = ?').run(guildId, ticket.id, roleId);
          changed++;
          continue;
        }
        if (current.allow.bitfield.toString() !== permission.applied_allow || current.deny.bitfield.toString() !== permission.applied_deny) {
          failed++;
          continue;
        }
        try {
          if (permission.previous_allow === '0' && permission.previous_deny === '0') {
            await channel.permissionOverwrites.delete(roleId, `Ruolo ticket rimosso dalla configurazione di ${ticket.id}`);
          } else {
            await channel.permissionOverwrites.edit(roleId, this.permissionOverwriteOptions(permission.previous_allow, permission.previous_deny), { reason: `Ripristino permessi preesistenti del ticket ${ticket.id}` });
          }
          this.db.prepare('DELETE FROM ticket_staff_permissions WHERE guild_id = ? AND ticket_id = ? AND role_id = ?').run(guildId, ticket.id, roleId);
          changed++;
        } catch { failed++; }
      }

      // I ticket precedenti alla migrazione non hanno una snapshot. Si rimuove soltanto l’overwrite identico a quello creato dal bot.
      for (const roleId of oldRoles) {
        if (newRoles.has(roleId) || trackedById.has(roleId)) continue;
        const current = channel.permissionOverwrites.cache.get(roleId);
        if (!current) continue;
        const expectedAllow = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles]
          .reduce((value, bit) => value | bit, 0n).toString();
        if (current.allow.bitfield.toString() !== expectedAllow || current.deny.bitfield.toString() !== '0') { failed++; continue; }
        try { await channel.permissionOverwrites.delete(roleId, `Ruolo ticket rimosso dalla configurazione di ${ticket.id}`); changed++; }
        catch { failed++; }
      }

      for (const roleId of newRoles) {
        if (trackedById.has(roleId)) continue;
        const role = await guild.roles.fetch(roleId).catch(() => null);
        if (!role || role.guild.id !== guildId) { failed++; continue; }
        const old = channel.permissionOverwrites.cache.get(roleId);
        const previousAllow = old?.allow.bitfield.toString() ?? '0';
        const previousDeny = old?.deny.bitfield.toString() ?? '0';
        try {
          await channel.permissionOverwrites.edit(roleId, {
            ViewChannel: true, SendMessages: true, ReadMessageHistory: true, AttachFiles: true,
          }, { reason: `Ruolo ticket autorizzato dalla configurazione di ${ticket.id}` });
          const applied = channel.permissionOverwrites.cache.get(roleId);
          if (!applied || !channel.permissionsFor(roleId)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory])) throw new Error('Permesso effettivo del ruolo non applicato.');
          this.db.prepare(`INSERT INTO ticket_staff_permissions(guild_id, ticket_id, role_id, previous_allow, previous_deny, applied_allow, applied_deny)
            VALUES (?, ?, ?, ?, ?, ?, ?)`)
            .run(guildId, ticket.id, roleId, previousAllow, previousDeny, applied.allow.bitfield.toString(), applied.deny.bitfield.toString());
          changed++;
        } catch {
          // Se la snapshot non è stata registrata, il tentativo di accesso viene annullato senza cancellare il ticket.
          if (!trackedById.has(roleId)) {
            if (old) await channel.permissionOverwrites.edit(roleId, this.permissionOverwriteOptions(previousAllow, previousDeny), { reason: 'Annullamento aggiornamento permessi ticket non registrato' }).catch(() => undefined);
            else await channel.permissionOverwrites.delete(roleId, 'Annullamento aggiornamento permessi ticket non registrato').catch(() => undefined);
          }
          failed++;
        }
      }
    }
    audit(this.db, { guildId, actorId: 'system', action: 'ticket.staff-access.reconcile', targetType: 'guild', targetId: guildId, result: failed ? 'uncertain' : 'ok', after: { changed, failed } });
    return { changed, failed };
  }

  async reconcileManagedPanelStaff(guildId: string, panelId: string, next: ManagedTicketPanelInput): Promise<{ changed: number; failed: number }> {
    const guild = await this.getGuild(guildId);
    const botId = this.client.user?.id;
    if (!botId) throw new AppError('Il bot non è connesso a Discord.', 503, 'BOT_NON_CONNESSO');
    const bot = await guild.members.fetch(botId).catch(() => null);
    if (!bot?.permissions.has(PermissionFlagsBits.ManageChannels)) throw new AuthorizationError('Al bot manca Gestisci canali per aggiornare l’accesso ai ticket già aperti.');
    const rows = this.db.prepare(`SELECT * FROM tickets WHERE guild_id = ? AND panel_id = ? AND status = 'open'`).all(guildId, panelId) as TicketRow[];
    let changed = 0;
    let failed = 0;
    const rolesFor = (config: ManagedTicketPanelInput, key: string) => {
      const category = config.categories.find((item) => item.key === key);
      return new Set(category?.staffRoleIds.length ? category.staffRoleIds : config.staffRoleIds);
    };
    for (const ticket of rows) {
      const previousFailureCount = failed;
      if (!ticket.channel_id) { failed++; continue; }
      const rawChannel = await guild.channels.fetch(ticket.channel_id).catch(() => null);
      if (!rawChannel || rawChannel.guildId !== guildId || rawChannel.type !== ChannelType.GuildText) { failed++; continue; }
      const channel = rawChannel as TextChannel;
      const newRoles = rolesFor(next, ticket.category_key);
      const snapshots = this.db.prepare('SELECT role_id, previous_allow, previous_deny, applied_allow, applied_deny FROM ticket_staff_permissions WHERE guild_id = ? AND ticket_id = ?')
        .all(guildId, ticket.id) as StaffPermissionRow[];
      const tracked = new Map(snapshots.map((snapshot) => [snapshot.role_id, snapshot]));
      for (const [roleId, snapshot] of tracked) {
        if (newRoles.has(roleId)) continue;
        const overwrite = channel.permissionOverwrites.cache.get(roleId);
        if (!overwrite) { this.db.prepare('DELETE FROM ticket_staff_permissions WHERE guild_id = ? AND ticket_id = ? AND role_id = ?').run(guildId, ticket.id, roleId); continue; }
        if (overwrite.allow.bitfield.toString() !== snapshot.applied_allow || overwrite.deny.bitfield.toString() !== snapshot.applied_deny) { failed++; continue; }
        try {
          if (snapshot.previous_allow === '0' && snapshot.previous_deny === '0') await channel.permissionOverwrites.delete(roleId, `Ruolo rimosso dal pannello ${panelId}`);
          else await channel.permissionOverwrites.edit(roleId, this.permissionOverwriteOptions(snapshot.previous_allow, snapshot.previous_deny), { reason: `Ripristino ruolo ticket del pannello ${panelId}` });
          this.db.prepare('DELETE FROM ticket_staff_permissions WHERE guild_id = ? AND ticket_id = ? AND role_id = ?').run(guildId, ticket.id, roleId);
          changed++;
        } catch { failed++; }
      }
      for (const roleId of newRoles) {
        if (tracked.has(roleId)) continue;
        const role = await guild.roles.fetch(roleId).catch(() => null);
        if (!role || role.guild.id !== guildId) { failed++; continue; }
        const prior = channel.permissionOverwrites.cache.get(roleId);
        try {
          await channel.permissionOverwrites.edit(roleId, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true, AttachFiles: true }, { reason: `Ruolo autorizzato dal pannello ${panelId}` });
          const applied = channel.permissionOverwrites.cache.get(roleId);
          if (!applied || !channel.permissionsFor(roleId)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory])) throw new Error('Permesso non applicato.');
          this.db.prepare(`INSERT INTO ticket_staff_permissions(guild_id, ticket_id, role_id, previous_allow, previous_deny, applied_allow, applied_deny) VALUES (?, ?, ?, ?, ?, ?, ?)`)
            .run(guildId, ticket.id, roleId, prior?.allow.bitfield.toString() ?? '0', prior?.deny.bitfield.toString() ?? '0', applied.allow.bitfield.toString(), applied.deny.bitfield.toString());
          changed++;
        } catch {
          if (prior) await channel.permissionOverwrites.edit(roleId, this.permissionOverwriteOptions(prior.allow.bitfield.toString(), prior.deny.bitfield.toString()), { reason: 'Annullamento aggiornamento accessi ticket non registrato' }).catch(() => undefined);
          else await channel.permissionOverwrites.delete(roleId, 'Annullamento aggiornamento accessi ticket non registrato').catch(() => undefined);
          failed++;
        }
      }
      if (failed === previousFailureCount) this.db.prepare('UPDATE tickets SET panel_config_json = ? WHERE guild_id = ? AND id = ?').run(JSON.stringify(next), guildId, ticket.id);
    }
    audit(this.db, { guildId, actorId: 'system', action: 'ticket.panel.staff-access.reconcile', targetType: 'ticket-panel', targetId: panelId, result: failed ? 'uncertain' : 'ok', after: { changed, failed } });
    return { changed, failed };
  }

  private readSettings(guildId: string): GuildSettings {
    const row = this.db.prepare('SELECT settings_json FROM guild_settings WHERE guild_id = ?').get(guildId) as { settings_json: string } | undefined;
    if (!row) throw new NotFoundError('Configurazione del server non trovata.');
    return JSON.parse(row.settings_json) as GuildSettings;
  }

  private staffRolesForTicket(guildId: string, settings: GuildSettings, categoryKey: string, panelId: string | null = null, panelConfigJson: string | null = null): Set<string> {
    if (panelId && panelConfigJson) {
      const config = JSON.parse(panelConfigJson) as { staffRoleIds?: string[]; categories?: Array<{ key: string; staffRoleIds?: string[] }> };
      const category = config.categories?.find((item) => item.key === categoryKey);
      const roles = category?.staffRoleIds?.length ? category.staffRoleIds : config.staffRoleIds ?? [];
      if (roles.length) return new Set(roles);
    }
    const category = settings.tickets.categories.find((item) => item.key === categoryKey);
    return new Set(category?.staffRoleIds.length ? category.staffRoleIds : settings.permissions.roles.ticketStaff);
  }

  private async isStaffForTicket(guildId: string, ticket: TicketRow, userId: string): Promise<boolean> {
    const guild = await this.getGuild(guildId);
    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) return false;
    if (member.id === guild.ownerId || member.permissions.has([PermissionFlagsBits.ManageGuild, PermissionFlagsBits.Administrator])) return true;
    const roles = this.staffRolesForTicket(guildId, this.readSettings(guildId), ticket.category_key, ticket.panel_id, ticket.panel_config_json);
    return member.roles.cache.some((role) => roles.has(role.id));
  }

  private managedTicketCategoryId(guildId: string, panelId: string): string {
    const row = this.db.prepare('SELECT ticket_category_id FROM ticket_panels_managed WHERE guild_id = ? AND id = ? AND status = \'active\'')
      .get(guildId, panelId) as { ticket_category_id: string } | undefined;
    if (!row) throw new AuthorizationError('Il pannello ticket non è più attivo in questo server.');
    return row.ticket_category_id;
  }

  private permissionOverwriteOptions(allowValue: string, denyValue: string): PermissionOverwriteOptions {
    const allow = BigInt(allowValue);
    const deny = BigInt(denyValue);
    const result: PermissionOverwriteOptions = {};
    for (const [name, rawBit] of Object.entries(PermissionFlagsBits)) {
      if (typeof rawBit !== 'bigint') continue;
      const key = name as keyof typeof PermissionFlagsBits;
      result[key] = (allow & rawBit) !== 0n ? true : (deny & rawBit) !== 0n ? false : null;
    }
    return result;
  }

  private getTicket(ticketId: string, guildId: string): TicketView { return view(this.getTicketRow(ticketId, guildId)); }

  private getTicketRow(ticketId: string, guildId: string): TicketRow {
    const row = this.db.prepare('SELECT * FROM tickets WHERE guild_id = ? AND id = ?').get(guildId, ticketId) as TicketRow | undefined;
    if (!row) throw new NotFoundError('Ticket non trovato in questo server.');
    return row;
  }

  private async assertTicketAccess(guildId: string, ticket: TicketRow, actorId: string): Promise<void> {
    if (ticket.opener_id === actorId || ticket.assigned_to === actorId) return;
    const participant = this.db.prepare('SELECT 1 FROM ticket_participants WHERE guild_id = ? AND ticket_id = ? AND user_id = ?').get(guildId, ticket.id, actorId);
    if (participant) return;
    await this.assertTicketStaff(guildId, ticket, actorId);
  }

  private async assertTicketStaff(guildId: string, ticket: TicketRow, actorId: string): Promise<void> {
    const guild = await this.getGuild(guildId);
    const member = await guild.members.fetch(actorId).catch(() => null);
    if (!member) throw new AuthorizationError();
    const privileged = member.id === guild.ownerId || member.permissions.has(PermissionFlagsBits.ManageGuild) || member.permissions.has(PermissionFlagsBits.Administrator);
    const allowedRoles = this.staffRolesForTicket(guildId, this.readSettings(guildId), ticket.category_key, ticket.panel_id, ticket.panel_config_json);
    if (!privileged && !member.roles.cache.some((role) => allowedRoles.has(role.id))) throw new AuthorizationError('Il tuo ruolo non consente di accedere a questo ticket.');
  }

  private async getGuild(guildId: string): Promise<Guild> {
    const guild = await this.client.guilds.fetch(guildId).catch(() => null);
    if (!guild) throw new NotFoundError('Il bot non è presente in questo server.');
    return guild;
  }

  private async getTextChannel(guild: Guild, channelId: string): Promise<TextChannel> {
    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (!channel || channel.guildId !== guild.id || channel.type !== ChannelType.GuildText) throw new NotFoundError('Il canale configurato non esiste o non è testuale in questo server.');
    return channel as TextChannel;
  }

  private async assertBotPermissions(guild: Guild, permissions: bigint[]): Promise<void> {
    const botId = this.client.user?.id;
    if (!botId) throw new AppError('Il bot non è connesso a Discord.', 503, 'BOT_NON_CONNESSO');
    const member = await guild.members.fetch(botId).catch(() => null);
    if (!member || !member.permissions.has(permissions)) throw new AuthorizationError('Al bot mancano permessi Discord necessari per questa operazione.');
  }

  private async assertChannelPermissions(channel: TextChannel, botId: string, permissions: bigint[]): Promise<void> {
    if (!channel.permissionsFor(botId)?.has(permissions)) throw new AuthorizationError('Il bot non dispone dei permessi effettivi nel canale del ticket.');
  }

  private async validateRoles(guild: Guild, roleIds: string[]): Promise<Role[]> {
    const roles = [];
    for (const roleId of roleIds) {
      const role = await guild.roles.fetch(roleId).catch(() => null);
      if (!role || role.guild.id !== guild.id) throw new AppError('Un ruolo autorizzato della categoria non esiste in questo server.', 409, 'RUOLO_NON_VALIDO');
      roles.push(role);
    }
    return roles;
  }

  private async buildTranscript(channel: TextChannel, limit: number): Promise<{ text: string; messageCount: number }> {
    const collected = [];
    let before: string | undefined;
    while (collected.length < limit) {
      const page: import('discord.js').Collection<string, import('discord.js').Message> = await channel.messages.fetch({ limit: Math.min(100, limit - collected.length), ...(before ? { before } : {}) });
      if (page.size === 0) break;
      collected.push(...page.values());
      before = page.last()?.id;
      if (page.size < Math.min(100, limit - (collected.length - page.size))) break;
    }
    const messages = collected.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
    const lines: string[] = [];
    let size = 0;
    for (const message of messages) {
      const attachments = [...message.attachments.values()].map((item) => `[allegato omesso: ${item.name.replace(/[\r\n]/g, '')}]`).join(' ');
      const content = (message.content || '').replace(/\r/g, '').slice(0, 3000);
      const line = `[${new Date(message.createdTimestamp).toISOString()}] ${message.author.username} (${message.author.id}): ${content}${attachments ? ` ${attachments}` : ''}`;
      const trimmed = line.slice(0, 4000);
      if (size + trimmed.length + 1 > 2_000_000) break;
      lines.push(trimmed);
      size += trimmed.length + 1;
    }
    if (collected.length === limit) lines.unshift(`[Trascrizione limitata agli ultimi ${limit} messaggi.]`);
    return { text: lines.join('\n'), messageCount: messages.length };
  }

  private addTicketEvent(guildId: string, ticketId: string, actorId: string, eventType: string, detail: string): void {
    this.db.prepare(`INSERT INTO ticket_events(guild_id, ticket_id, actor_id, event_type, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(guildId, ticketId, actorId, eventType, detail.slice(0, 2000), new Date().toISOString());
  }

  private safeEmbedText(value: string): string {
    const clean = value.replace(/@/g, '@\u200b').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim();
    return clean.slice(0, 900) || '—';
  }
}
