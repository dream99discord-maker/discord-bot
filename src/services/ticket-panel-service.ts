import { randomUUID } from 'node:crypto';
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder, PermissionFlagsBits,
  StringSelectMenuBuilder, type Client, type Guild, type Role, type TextChannel,
} from 'discord.js';
import { z } from 'zod';
import type { DatabaseHandle } from '../db.js';
import { audit } from '../db.js';
import { AppError, AuthorizationError, ConflictError, NotFoundError } from '../errors.js';

const SNOWFLAKE = /^\d{17,20}$/;
const fieldSchema = z.object({
  key: z.string().regex(/^[a-z0-9_-]{1,32}$/),
  label: z.string().trim().min(1).max(45),
  style: z.enum(['short', 'paragraph']),
  required: z.boolean(),
}).strict();
const typeSchema = z.object({
  key: z.string().regex(/^[a-z0-9_-]{1,32}$/),
  label: z.string().trim().min(1).max(80),
  buttonLabel: z.string().trim().min(1).max(80).optional(),
  description: z.string().trim().min(1).max(100),
  staffRoleIds: z.array(z.string().regex(SNOWFLAKE)).max(50).default([]),
  fields: z.array(fieldSchema).min(1).max(5),
}).strict().superRefine((ticketType, ctx) => {
  if (new Set(ticketType.fields.map((field) => field.key)).size !== ticketType.fields.length) {
    ctx.addIssue({ code: 'custom', message: 'I campi del modulo devono avere identificativi univoci.' });
  }
});
const choiceSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('create'), name: z.string().trim().min(1).max(90) }).strict(),
  z.object({ mode: z.literal('existing'), id: z.string().regex(SNOWFLAKE) }).strict(),
]);
export const managedTicketPanelInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  panelTitle: z.string().trim().min(1).max(100),
  description: z.string().trim().min(1).max(2000),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  footer: z.string().trim().max(100).default('The Last Pact Guardian'),
  layout: z.enum(['menu', 'buttons']),
  panelCategory: choiceSchema,
  panelChannel: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('create'), name: z.string().trim().min(1).max(90) }).strict(),
    z.object({ mode: z.literal('existing'), id: z.string().regex(SNOWFLAKE) }).strict(),
  ]),
  ticketCategory: choiceSchema,
  staffRoleIds: z.array(z.string().regex(SNOWFLAKE)).max(50).default([]),
  maxOpenPerUser: z.number().int().min(1).max(10),
  maxConcurrentTotal: z.number().int().min(1).max(500),
  cooldownSeconds: z.number().int().min(0).max(86400),
  categories: z.array(typeSchema).min(1).max(25),
}).strict().superRefine((input, ctx) => {
  if (new Set(input.categories.map((item) => item.key)).size !== input.categories.length) {
    ctx.addIssue({ code: 'custom', message: 'Le tipologie ticket devono avere identificativi univoci.' });
  }
  if (new Set(input.staffRoleIds).size !== input.staffRoleIds.length) {
    ctx.addIssue({ code: 'custom', message: 'I ruoli dello staff devono essere univoci.' });
  }
  for (const ticketType of input.categories) {
    if (new Set(ticketType.staffRoleIds).size !== ticketType.staffRoleIds.length) {
      ctx.addIssue({ code: 'custom', message: `I ruoli staff della tipologia “${ticketType.label}” devono essere univoci.` });
    }
    if (!input.staffRoleIds.length && !ticketType.staffRoleIds.length) {
      ctx.addIssue({ code: 'custom', message: `Seleziona un ruolo staff generale o specifico per la tipologia “${ticketType.label}”.` });
    }
  }
  if (input.layout === 'buttons' && input.categories.length > 25) {
    ctx.addIssue({ code: 'custom', message: 'Discord consente al massimo 25 pulsanti per pannello.' });
  }
});

export type ManagedTicketPanelInput = z.infer<typeof managedTicketPanelInputSchema>;
type OperationStatus = 'pending' | 'in_progress' | 'completed' | 'recovery_needed' | 'failed';
interface OperationRow {
  id: string; guild_id: string; actor_id: string; operation_kind: string; idempotency_key: string;
  status: OperationStatus; request_json: string; resources_json: string; result_json: string | null;
  error_code: string | null; error_message: string | null; created_at: string; updated_at: string;
}
interface PanelRow {
  id: string; guild_id: string; name: string; channel_id: string; panel_category_id: string | null;
  ticket_category_id: string; message_id: string; config_json: string; status: 'active' | 'disabled' | 'needs_repair';
  version: number; created_by: string; created_at: string; updated_at: string;
}
interface CreatedResources {
  panelId?: string;
  panelCategoryId?: string; ticketCategoryId?: string; channelId?: string; messageId?: string;
  createdPanelCategory?: boolean; createdTicketCategory?: boolean; createdChannel?: boolean;
}

export interface ManagedTicketPanel {
  id: string; guildId: string; name: string; channelId: string; panelCategoryId: string | null;
  ticketCategoryId: string; messageId: string; status: PanelRow['status']; enabled: boolean;
  version: number; createdAt: string; updatedAt: string; config: ManagedTicketPanelInput;
}

function toPanel(row: PanelRow): ManagedTicketPanel {
  return { id: row.id, guildId: row.guild_id, name: row.name, channelId: row.channel_id,
    panelCategoryId: row.panel_category_id, ticketCategoryId: row.ticket_category_id,
    messageId: row.message_id, status: row.status, enabled: row.status === 'active',
    version: row.version, createdAt: row.created_at, updatedAt: row.updated_at,
    config: managedTicketPanelInputSchema.parse(JSON.parse(row.config_json)) };
}

export class TicketPanelService {
  constructor(private readonly db: DatabaseHandle, private readonly client: Client) {}

  async importLegacyPanels(): Promise<{ imported: number; skipped: number }> {
    const legacy = this.db.prepare(`SELECT p.guild_id, p.channel_id, p.message_id, p.updated_at, s.settings_json
      FROM ticket_panels p JOIN guild_settings s ON s.guild_id = p.guild_id`).all() as Array<{ guild_id: string; channel_id: string; message_id: string; updated_at: string; settings_json: string }>;
    let imported = 0;
    let skipped = 0;
    for (const row of legacy) {
      const id = `legacy-${row.guild_id}`;
      if (this.db.prepare('SELECT 1 FROM ticket_panels_managed WHERE guild_id = ? AND id = ?').get(row.guild_id, id)) continue;
      try {
        const guild = await this.getGuild(row.guild_id);
        const channel = await guild.channels.fetch(row.channel_id).catch(() => null);
        if (!channel || channel.guildId !== row.guild_id || channel.type !== ChannelType.GuildText) { skipped++; continue; }
        const settings = JSON.parse(row.settings_json) as {
          general: { name: string; color: string; footer: string };
          messages: { ticketPanelTitle: string; ticketPanelDescription: string };
          permissions: { roles: { ticketStaff: string[] } };
          channels: { ticketParent: string | null };
          tickets: { enabled: boolean; maxOpenPerUser: number; cooldownSeconds: number; categories: ManagedTicketPanelInput['categories'] };
          modules: { tickets: boolean };
        };
        const staffRoleIds = [...new Set([...settings.permissions.roles.ticketStaff, ...settings.tickets.categories.flatMap((item) => item.staffRoleIds)])];
        if (!staffRoleIds.length) { skipped++; continue; }
        const parentId = channel.parentId ?? undefined;
        const selectedPrivateCategory = settings.channels.ticketParent ? await guild.channels.fetch(settings.channels.ticketParent).catch(() => null) : null;
        const privateCategoryIsSafe = Boolean(selectedPrivateCategory && selectedPrivateCategory.guildId === row.guild_id && selectedPrivateCategory.type === ChannelType.GuildCategory && !selectedPrivateCategory.permissionsFor(guild.roles.everyone)?.has(PermissionFlagsBits.ViewChannel));
        const config: ManagedTicketPanelInput = managedTicketPanelInputSchema.parse({
          name: 'Pannello ticket esistente', panelTitle: settings.messages.ticketPanelTitle,
          description: settings.messages.ticketPanelDescription, color: settings.general.color, footer: settings.general.footer,
          layout: 'menu',
          panelCategory: parentId ? { mode: 'existing', id: parentId } : { mode: 'create', name: 'supporto' },
          panelChannel: { mode: 'existing', id: row.channel_id },
          ticketCategory: privateCategoryIsSafe ? { mode: 'existing', id: selectedPrivateCategory!.id } : { mode: 'create', name: 'ticket-privati' },
          staffRoleIds,
          maxOpenPerUser: settings.tickets.maxOpenPerUser, maxConcurrentTotal: 100, cooldownSeconds: settings.tickets.cooldownSeconds,
          categories: settings.tickets.categories,
        });
        const ticketCategoryId = privateCategoryIsSafe ? selectedPrivateCategory!.id : '';
        const status = !settings.modules.tickets || !settings.tickets.enabled ? 'disabled' : 'active';
        this.db.transaction(() => {
          this.db.prepare(`INSERT INTO ticket_panels_managed(id, guild_id, name, channel_id, panel_category_id, ticket_category_id, message_id, config_json, status, version, created_by, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'system', ?, ?)`)
            .run(id, row.guild_id, config.name, row.channel_id, parentId ?? null, ticketCategoryId, row.message_id, JSON.stringify(config), status, row.updated_at, row.updated_at);
          this.db.prepare(`UPDATE tickets SET panel_id = ?, panel_config_json = ?, ticket_category_id = COALESCE(ticket_category_id, ?)
            WHERE guild_id = ? AND panel_id IS NULL`).run(id, JSON.stringify(config), privateCategoryIsSafe ? selectedPrivateCategory!.id : null, row.guild_id);
        }).immediate();
        this.savePanelResources(id, row.guild_id, { channelId: row.channel_id, ...(parentId ? { panelCategoryId: parentId } : {}), ...(ticketCategoryId ? { ticketCategoryId } : {}), messageId: row.message_id }, null);
        imported++;
      } catch { skipped++; }
    }
    return { imported, skipped };
  }

  async create(guildId: string, actorId: string, idempotencyKey: string, rawInput: unknown): Promise<{ operationId: string; status: OperationStatus; panel?: ManagedTicketPanel; resources: CreatedResources; error?: string }> {
    const input = managedTicketPanelInputSchema.parse(rawInput);
    if (!/^[0-9a-f-]{36}$/i.test(idempotencyKey)) throw new AppError('Identificativo operazione non valido.', 400, 'IDEMPOTENCY_KEY_NON_VALIDA');
    let operation = this.db.prepare(`SELECT * FROM ticket_operations WHERE guild_id = ? AND operation_kind = 'panel.create' AND idempotency_key = ?`)
      .get(guildId, idempotencyKey) as OperationRow | undefined;
    if (!operation) {
      const now = new Date().toISOString();
      const operationId = randomUUID();
      try {
        this.db.prepare(`INSERT INTO ticket_operations(id, guild_id, actor_id, operation_kind, idempotency_key, status, request_json, resources_json, created_at, updated_at)
          VALUES (?, ?, ?, 'panel.create', ?, 'pending', ?, '{}', ?, ?)`)
          .run(operationId, guildId, actorId, idempotencyKey, JSON.stringify(input), now, now);
      } catch {
        operation = this.db.prepare(`SELECT * FROM ticket_operations WHERE guild_id = ? AND operation_kind = 'panel.create' AND idempotency_key = ?`)
          .get(guildId, idempotencyKey) as OperationRow | undefined;
      }
      operation ??= this.getOperationRow(guildId, operationId);
    } else if (operation.actor_id !== actorId || operation.request_json !== JSON.stringify(input)) {
      throw new ConflictError('Questo identificativo è già associato a un’altra richiesta. Aggiorna la pagina e riprova.');
    }
    return this.runCreateOperation(operation);
  }

  async recoverIncomplete(processStartedAt = new Date().toISOString()): Promise<{ resumed: number; failed: number }> {
    this.db.prepare(`UPDATE ticket_operations SET status = 'recovery_needed', updated_at = ? WHERE operation_kind = 'panel.create' AND status = 'in_progress' AND updated_at < ?`)
      .run(new Date().toISOString(), processStartedAt);
    const rows = this.db.prepare(`SELECT * FROM ticket_operations WHERE operation_kind = 'panel.create' AND status IN ('pending','recovery_needed') AND updated_at < ? ORDER BY created_at LIMIT 20`)
      .all(processStartedAt) as OperationRow[];
    let resumed = 0;
    let failed = 0;
    for (const row of rows) {
      try {
        const result = await this.runCreateOperation(row);
        if (result.status === 'completed') resumed++;
        else failed++;
      } catch { failed++; }
    }
    return { resumed, failed };
  }

  list(guildId: string): ManagedTicketPanel[] {
    const rows = this.db.prepare('SELECT * FROM ticket_panels_managed WHERE guild_id = ? ORDER BY created_at DESC').all(guildId) as PanelRow[];
    return rows.map(toPanel);
  }

  get(guildId: string, panelId: string): ManagedTicketPanel {
    const row = this.getPanelRow(guildId, panelId);
    return toPanel(row);
  }

  async inspect(guildId: string, panelId: string): Promise<{ panel: ManagedTicketPanel; health: { panelChannel: boolean; panelChannelPublic: boolean; panelChannelReadOnly: boolean; panelBotAccess: boolean; panelCategory: boolean; ticketCategory: boolean; ticketCategoryPrivate: boolean; message: boolean; missing: string[] }; ticketCount: number }> {
    const panel = this.get(guildId, panelId);
    const guild = await this.getGuild(guildId);
    const panelChannel = await guild.channels.fetch(panel.channelId).catch(() => null);
    const panelCategory = panel.panelCategoryId ? await guild.channels.fetch(panel.panelCategoryId).catch(() => null) : null;
    const ticketCategory = await guild.channels.fetch(panel.ticketCategoryId).catch(() => null);
    const message = panelChannel?.type === ChannelType.GuildText
      ? await (panelChannel as TextChannel).messages.fetch(panel.messageId).catch(() => null)
      : null;
    const everyonePermissions = panelChannel?.type === ChannelType.GuildText ? panelChannel.permissionsFor(guild.roles.everyone) : null;
    const botId = this.client.user?.id;
    const botPermissions = botId && panelChannel?.type === ChannelType.GuildText ? panelChannel.permissionsFor(botId) : null;
    const privateEveryonePermissions = ticketCategory?.type === ChannelType.GuildCategory ? ticketCategory.permissionsFor(guild.roles.everyone) : null;
    const checks = {
      panelChannel: Boolean(panelChannel && panelChannel.guildId === guildId && panelChannel.type === ChannelType.GuildText),
      panelChannelPublic: Boolean(everyonePermissions?.has(PermissionFlagsBits.ViewChannel)),
      panelChannelReadOnly: !everyonePermissions?.has(PermissionFlagsBits.SendMessages),
      panelBotAccess: Boolean(botPermissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.EmbedLinks])),
      panelCategory: panel.panelCategoryId === null || Boolean(panelCategory && panelCategory.guildId === guildId && panelCategory.type === ChannelType.GuildCategory),
      ticketCategory: Boolean(ticketCategory && ticketCategory.guildId === guildId && ticketCategory.type === ChannelType.GuildCategory),
      ticketCategoryPrivate: Boolean(privateEveryonePermissions && !privateEveryonePermissions.has(PermissionFlagsBits.ViewChannel)),
      message: Boolean(message),
    };
    const labels: Record<keyof typeof checks, string> = {
      panelChannel: 'canale pannello', panelChannelPublic: 'visibilità pubblica del pannello', panelChannelReadOnly: 'sola lettura del pannello',
      panelBotAccess: 'permessi del bot sul pannello', panelCategory: 'categoria pannello', ticketCategory: 'categoria ticket',
      ticketCategoryPrivate: 'privacy della categoria ticket', message: 'messaggio pannello',
    };
    const missing = Object.entries(checks).filter(([, available]) => !available).map(([key]) => labels[key as keyof typeof checks]);
    const ticketCount = (this.db.prepare('SELECT COUNT(*) AS amount FROM tickets WHERE guild_id = ? AND panel_id = ?').get(guildId, panelId) as { amount: number }).amount;
    return { panel, health: { ...checks, missing }, ticketCount };
  }

  async update(guildId: string, actorId: string, panelId: string, expectedVersion: number, rawPatch: unknown): Promise<ManagedTicketPanel> {
    const current = this.getPanelRow(guildId, panelId);
    const currentConfig = managedTicketPanelInputSchema.parse(JSON.parse(current.config_json));
    const patchSchema = managedTicketPanelInputSchema.pick({ name: true, panelTitle: true, description: true, color: true, footer: true, layout: true, staffRoleIds: true, maxOpenPerUser: true, maxConcurrentTotal: true, cooldownSeconds: true, categories: true }).partial().strict();
    const patch = patchSchema.parse(rawPatch);
    const nextConfig = managedTicketPanelInputSchema.parse({ ...currentConfig, ...patch });
    if (current.version !== expectedVersion) throw new ConflictError('Il pannello è stato modificato da un altro amministratore. Ricarica la pagina.');
    const guild = await this.getGuild(guildId);
    const channel = await guild.channels.fetch(current.channel_id).catch(() => null);
    if (!channel || channel.type !== ChannelType.GuildText || channel.guildId !== guildId) throw new AppError('Il canale del pannello non esiste più. Seleziona un canale sostitutivo nella procedura di riparazione.', 409, 'PANNELLO_DA_RIPARARE');
    const panelCategory = current.panel_category_id ? await guild.channels.fetch(current.panel_category_id).catch(() => null) : null;
    const ticketCategory = current.ticket_category_id ? await guild.channels.fetch(current.ticket_category_id).catch(() => null) : null;
    const resourcesValid = Boolean(panelCategory && panelCategory.guildId === guildId && panelCategory.type === ChannelType.GuildCategory
      && ticketCategory && ticketCategory.guildId === guildId && ticketCategory.type === ChannelType.GuildCategory
      && !ticketCategory.permissionsFor(guild.roles.everyone)?.has(PermissionFlagsBits.ViewChannel));
    await this.configurePanelChannel(guild, channel as TextChannel, `Aggiornamento pannello ${panelId}`);
    const reservedAt = new Date().toISOString();
    const result = this.db.prepare(`UPDATE ticket_panels_managed SET name = ?, config_json = ?, version = version + 1, updated_at = ?
      WHERE guild_id = ? AND id = ? AND version = ?`).run(nextConfig.name, JSON.stringify(nextConfig), reservedAt, guildId, panelId, expectedVersion);
    if (result.changes !== 1) throw new ConflictError('Il pannello è stato modificato da un altro amministratore. Ricarica la pagina.');
    try { await this.publish(guild, channel as TextChannel, panelId, nextConfig, current.status !== 'disabled' && resourcesValid); }
    catch {
      this.db.prepare(`UPDATE ticket_panels_managed SET status = 'needs_repair', updated_at = ? WHERE guild_id = ? AND id = ?`).run(new Date().toISOString(), guildId, panelId);
      audit(this.db, { guildId, actorId, action: 'ticket.panel.update', targetType: 'ticket-panel', targetId: panelId, result: 'uncertain', after: { channelId: current.channel_id, messageId: current.message_id } });
      throw new AppError('La configurazione è stata salvata, ma Discord non ha aggiornato il messaggio. Usa “Verifica / ripara” per applicarla.', 502, 'AGGIORNAMENTO_PANNELLO_INCOMPLETO');
    }
    this.db.prepare('UPDATE ticket_panels_managed SET status = ?, updated_at = ? WHERE guild_id = ? AND id = ?')
      .run(current.status === 'disabled' ? 'disabled' : resourcesValid ? 'active' : 'needs_repair', new Date().toISOString(), guildId, panelId);
    audit(this.db, { guildId, actorId, action: 'ticket.panel.update', targetType: 'ticket-panel', targetId: panelId, result: 'ok', after: { channelId: current.channel_id, messageId: current.message_id } });
    return this.get(guildId, panelId);
  }

  async setEnabled(guildId: string, actorId: string, panelId: string, enabled: boolean): Promise<ManagedTicketPanel> {
    const current = this.getPanelRow(guildId, panelId);
    const guild = await this.getGuild(guildId);
    const channel = await guild.channels.fetch(current.channel_id).catch(() => null);
    if (!channel || channel.type !== ChannelType.GuildText || channel.guildId !== guildId) throw new AppError('Il canale del pannello non esiste più. Ripara il pannello prima di riattivarlo.', 409, 'PANNELLO_DA_RIPARARE');
    const config = managedTicketPanelInputSchema.parse(JSON.parse(current.config_json));
    if (enabled) {
      const panelCategory = current.panel_category_id ? await guild.channels.fetch(current.panel_category_id).catch(() => null) : null;
      const ticketCategory = current.ticket_category_id ? await guild.channels.fetch(current.ticket_category_id).catch(() => null) : null;
      if (!panelCategory || panelCategory.guildId !== guildId || panelCategory.type !== ChannelType.GuildCategory) {
        throw new AppError('La categoria del pannello manca. Esegui la riparazione prima di riattivarlo.', 409, 'CATEGORIA_PANNELLO_DA_RIPARARE');
      }
      if (!ticketCategory || ticketCategory.guildId !== guildId || ticketCategory.type !== ChannelType.GuildCategory || ticketCategory.permissionsFor(guild.roles.everyone)?.has(PermissionFlagsBits.ViewChannel)) {
        throw new AppError('La categoria privata del ticket manca o è visibile a @everyone. Esegui la riparazione prima di riattivare il pannello.', 409, 'CATEGORIA_TICKET_DA_RIPARARE');
      }
      await this.configurePanelChannel(guild, channel as TextChannel, `Riattivazione pannello ${panelId}`);
    }
    await this.publish(guild, channel as TextChannel, panelId, config, enabled);
    const saved = this.db.prepare(`UPDATE ticket_panels_managed SET status = ?, version = version + 1, updated_at = ? WHERE guild_id = ? AND id = ? AND version = ?`)
      .run(enabled ? 'active' : 'disabled', new Date().toISOString(), guildId, panelId, current.version);
    if (saved.changes !== 1) throw new ConflictError('Lo stato del pannello è cambiato durante la richiesta. Aggiorna e riprova.');
    audit(this.db, { guildId, actorId, action: enabled ? 'ticket.panel.enable' : 'ticket.panel.disable', targetType: 'ticket-panel', targetId: panelId, result: 'ok', after: { channelId: current.channel_id, messageId: current.message_id } });
    return this.get(guildId, panelId);
  }

  async repair(guildId: string, actorId: string, panelId: string): Promise<{ panel: ManagedTicketPanel; repaired: string[]; remaining: string[] }> {
    const current = this.getPanelRow(guildId, panelId);
    const guild = await this.getGuild(guildId);
    const operationId = randomUUID();
    const now = new Date().toISOString();
    const staleBefore = new Date(Date.now() - 5 * 60_000).toISOString();
    try {
      this.db.transaction(() => {
        this.db.prepare('DELETE FROM ticket_panel_repair_locks WHERE locked_at < ?').run(staleBefore);
        this.db.prepare('INSERT INTO ticket_panel_repair_locks(panel_id, guild_id, operation_id, locked_at) VALUES (?, ?, ?, ?)')
          .run(panelId, guildId, operationId, now);
      }).immediate();
    } catch { throw new ConflictError('È già in corso una riparazione di questo pannello. Attendi e aggiorna lo stato.'); }
    const created: string[] = [];
    try {
      let config = managedTicketPanelInputSchema.parse(JSON.parse(current.config_json));
      let panelCategoryId = current.panel_category_id;
      let ticketCategoryId = current.ticket_category_id;
      let channelId = current.channel_id;
      const repaired: string[] = [];

      let panelCategory = panelCategoryId ? await guild.channels.fetch(panelCategoryId).catch(() => null) : null;
      if (!panelCategory || panelCategory.guildId !== guildId || panelCategory.type !== ChannelType.GuildCategory) {
        const baseName = config.panelCategory.mode === 'create' ? `${config.panelCategory.name}-riparazione` : 'supporto-riparato';
        const replacementName = this.resourceName(baseName, `${panelId}-panel`);
        panelCategory = guild.channels.cache.find((candidate) => candidate.guildId === guildId && candidate.type === ChannelType.GuildCategory && candidate.name === replacementName)
          ?? await guild.channels.create({ name: replacementName, type: ChannelType.GuildCategory, reason: `Riparazione pannello ${panelId}` });
        panelCategoryId = panelCategory.id; created.push(panelCategory.id); repaired.push('categoria pannello');
        config = managedTicketPanelInputSchema.parse({ ...config, panelCategory: { mode: 'create', name: replacementName } });
      }

      let ticketCategory = ticketCategoryId ? await guild.channels.fetch(ticketCategoryId).catch(() => null) : null;
      const privateCategoryValid = Boolean(ticketCategory && ticketCategory.guildId === guildId && ticketCategory.type === ChannelType.GuildCategory && !ticketCategory.permissionsFor(guild.roles.everyone)?.has(PermissionFlagsBits.ViewChannel));
      if (!privateCategoryValid) {
        const baseName = config.ticketCategory.mode === 'create' ? `${config.ticketCategory.name}-riparazione` : 'ticket-privati-ripristinati';
        const replacementName = this.resourceName(baseName, `${panelId}-ticket`);
        const roles = [...new Set([...config.staffRoleIds, ...config.categories.flatMap((item) => item.staffRoleIds)])];
        ticketCategory = guild.channels.cache.find((candidate) => candidate.guildId === guildId && candidate.type === ChannelType.GuildCategory && candidate.name === replacementName)
          ?? await this.createPrivateCategory(guild, replacementName, roles, `Riparazione pannello ${panelId}`);
        if (ticketCategory.permissionsFor(guild.roles.everyone)?.has(PermissionFlagsBits.ViewChannel)) throw new AuthorizationError('La categoria ticket ripristinata è visibile a @everyone.');
        ticketCategoryId = ticketCategory.id; created.push(ticketCategory.id); repaired.push('categoria ticket privata');
        config = managedTicketPanelInputSchema.parse({ ...config, ticketCategory: { mode: 'create', name: replacementName } });
      }

      let channel = channelId ? await guild.channels.fetch(channelId).catch(() => null) : null;
      if (!channel || channel.guildId !== guildId || channel.type !== ChannelType.GuildText) {
        const baseName = config.panelChannel.mode === 'create' ? `${config.panelChannel.name}-riparazione` : 'apri-ticket-ripristinato';
        const replacementName = this.resourceName(baseName, `${panelId}-channel`);
        channel = guild.channels.cache.find((candidate) => candidate.guildId === guildId && candidate.type === ChannelType.GuildText && candidate.name === replacementName)
          ?? await this.createPanelChannel(guild, replacementName, panelCategoryId ?? undefined, `Riparazione pannello ${panelId}`);
        channelId = channel.id; created.push(channel.id); repaired.push('canale pannello');
        config = managedTicketPanelInputSchema.parse({ ...config, panelChannel: { mode: 'create', name: replacementName } });
      }
      if (channel.type !== ChannelType.GuildText || channel.guildId !== guildId) throw new AppError('Il canale sostitutivo non appartiene al server selezionato.', 409, 'CANALE_PANNELLO_MANCANTE');
      const textChannel = channel as TextChannel;
      if (panelCategoryId && textChannel.parentId !== panelCategoryId) await textChannel.setParent(panelCategoryId, { lockPermissions: false, reason: `Riparazione pannello ${panelId}` });
      await this.configurePanelChannel(guild, textChannel, `Riparazione pannello ${panelId}`);
      const message = await this.publish(guild, textChannel, panelId, config, current.status !== 'disabled');
      this.db.prepare(`UPDATE ticket_panels_managed SET name = ?, channel_id = ?, panel_category_id = ?, ticket_category_id = ?, message_id = ?, config_json = ?, status = ?, version = version + 1, updated_at = ? WHERE guild_id = ? AND id = ?`)
        .run(config.name, channelId, panelCategoryId, ticketCategoryId, message.id, JSON.stringify(config), current.status === 'disabled' ? 'disabled' : 'active', new Date().toISOString(), guildId, panelId);
      this.savePanelResources(panelId, guildId, { channelId, ...(panelCategoryId ? { panelCategoryId } : {}), ticketCategoryId, messageId: message.id }, null);
      audit(this.db, { guildId, actorId, action: 'ticket.panel.repair', targetType: 'ticket-panel', targetId: panelId, result: 'ok', after: { repaired, resourceIds: created } });
      return { panel: this.get(guildId, panelId), repaired, remaining: [] };
    } catch (error) {
      const suffix = created.length ? ` Risorse da verificare: ${created.join(', ')}.` : '';
      const message = error instanceof AppError ? error.message : 'Discord non ha completato la riparazione.';
      audit(this.db, { guildId, actorId, action: 'ticket.panel.repair', targetType: 'ticket-panel', targetId: panelId, result: 'uncertain', after: { errorCode: error instanceof AppError ? error.code : 'ERRORE_DISCORD', resourceIds: created } });
      throw error instanceof AppError ? new AppError(`${message}${suffix}`, error.statusCode, error.code) : new AppError(`${message}${suffix}`, 502, 'RIPARAZIONE_PANNELLO_INCOMPLETA');
    } finally {
      this.db.prepare('DELETE FROM ticket_panel_repair_locks WHERE panel_id = ? AND guild_id = ? AND operation_id = ?').run(panelId, guildId, operationId);
    }
  }
  async delete(guildId: string, actorId: string, panelId: string, confirmedResourceIds: string[]): Promise<{ deletedPanelId: string; deletedMessageId: string; retainedResources: string[]; ticketCount: number }> {
    const panel = this.getPanelRow(guildId, panelId);
    const resources = [panel.message_id];
    if (resources.length !== confirmedResourceIds.length || resources.some((id) => !confirmedResourceIds.includes(id))) {
      throw new ConflictError(`Conferma esplicita richiesta. Sarà eliminato soltanto il messaggio ${panel.message_id}; canali, categorie e ticket saranno conservati.`);
    }
    const guild = await this.getGuild(guildId);
    const channel = await guild.channels.fetch(panel.channel_id).catch(() => null);
    if (channel?.type === ChannelType.GuildText && channel.guildId === guildId) {
      const message = await (channel as TextChannel).messages.fetch(panel.message_id).catch(() => null);
      if (message) await message.delete().catch(() => { throw new AppError('Discord non ha permesso di rimuovere il messaggio del pannello. Canali e ticket restano intatti.', 502, 'ELIMINAZIONE_PANNELLO_FALLITA'); });
    }
    this.db.prepare('DELETE FROM ticket_panels_managed WHERE guild_id = ? AND id = ?').run(guildId, panelId);
    if (panelId === `legacy-${guildId}`) this.db.prepare('DELETE FROM ticket_panels WHERE guild_id = ? AND channel_id = ? AND message_id = ?').run(guildId, panel.channel_id, panel.message_id);
    const ticketCount = (this.db.prepare('SELECT COUNT(*) AS amount FROM tickets WHERE guild_id = ? AND panel_id = ?').get(guildId, panelId) as { amount: number }).amount;
    audit(this.db, { guildId, actorId, action: 'ticket.panel.delete', targetType: 'ticket-panel', targetId: panelId, result: 'ok', after: { deletedMessageId: panel.message_id, retainedChannelId: panel.channel_id, retainedTicketCategoryId: panel.ticket_category_id, ticketCount } });
    return { deletedPanelId: panelId, deletedMessageId: panel.message_id, retainedResources: [panel.channel_id, ...(panel.panel_category_id ? [panel.panel_category_id] : []), panel.ticket_category_id], ticketCount };
  }

  operation(guildId: string, operationId: string): unknown {
    const row = this.db.prepare('SELECT * FROM ticket_operations WHERE guild_id = ? AND id = ?').get(guildId, operationId) as OperationRow | undefined;
    if (!row) throw new NotFoundError('Operazione ticket non trovata in questo server.');
    return this.operationView(row);
  }

  private async runCreateOperation(initial: OperationRow): Promise<{ operationId: string; status: OperationStatus; panel?: ManagedTicketPanel; resources: CreatedResources; error?: string }> {
    let row = this.getOperationRow(initial.guild_id, initial.id);
    if (row.status === 'completed') return this.operationView(row);
    const claim = this.db.prepare(`UPDATE ticket_operations SET status = 'in_progress', error_code = NULL, error_message = NULL, updated_at = ?
      WHERE id = ? AND status IN ('pending','recovery_needed','failed')`).run(new Date().toISOString(), row.id);
    if (!claim.changes) {
      row = this.getOperationRow(row.guild_id, row.id);
      return this.operationView(row);
    }
    const input = managedTicketPanelInputSchema.parse(JSON.parse(row.request_json));
    let resources = this.readResources(row.resources_json);
    const panelId = resources.panelId ?? randomUUID();
    resources.panelId = panelId;
    this.saveOperationResources(row.id, resources);
    try {
      const alreadyCreated = this.db.prepare('SELECT 1 FROM ticket_panels_managed WHERE guild_id = ? AND id = ?').get(row.guild_id, panelId);
      if (alreadyCreated) {
        const now = new Date().toISOString();
        this.db.prepare(`UPDATE ticket_operations SET status = 'completed', result_json = ?, error_code = NULL, error_message = NULL, updated_at = ? WHERE id = ?`)
          .run(JSON.stringify({ panelId }), now, row.id);
        return { operationId: row.id, status: 'completed', panel: this.get(row.guild_id, panelId), resources };
      }
      const guild = await this.getGuild(row.guild_id);
      await this.assertOperatorAndBotPermissions(guild, row.actor_id);
      const roles = await this.validateRoles(guild, [...new Set([...input.staffRoleIds, ...input.categories.flatMap((ticketType) => ticketType.staffRoleIds)])]);
      const staffIds = new Set(roles.map((role) => role.id));

      if (input.panelCategory.mode === 'existing') {
        const category = await guild.channels.fetch(input.panelCategory.id).catch(() => null);
        if (!category || category.guildId !== row.guild_id || category.type !== ChannelType.GuildCategory) throw new AppError('La categoria selezionata non esiste più o appartiene a un altro server.', 409, 'CATEGORIA_PANNELLO_NON_VALIDA');
        resources.panelCategoryId = category.id;
      } else {
        const current = resources.panelCategoryId ? await guild.channels.fetch(resources.panelCategoryId).catch(() => null) : null;
        if (current?.guildId === row.guild_id && current.type === ChannelType.GuildCategory) {
          resources.createdPanelCategory = true;
        } else {
        const name = this.resourceName(input.panelCategory.name, `${row.id}-panel`);
        const category = guild.channels.cache.find((candidate) => candidate.guildId === row.guild_id && candidate.type === ChannelType.GuildCategory && candidate.name === name)
          ?? await guild.channels.create({ name, type: ChannelType.GuildCategory, reason: `Creazione pannello ticket ${row.id}` });
        resources.panelCategoryId = category.id; resources.createdPanelCategory = true;
        this.saveOperationResources(row.id, resources);
        }
      }

      if (input.ticketCategory.mode === 'existing') {
        const category = await guild.channels.fetch(input.ticketCategory.id).catch(() => null);
        if (!category || category.guildId !== row.guild_id || category.type !== ChannelType.GuildCategory) throw new AppError('La categoria privata selezionata non esiste più o appartiene a un altro server.', 409, 'CATEGORIA_TICKET_NON_VALIDA');
        if (category.permissionsFor(guild.roles.everyone)?.has(PermissionFlagsBits.ViewChannel)) throw new AuthorizationError('La categoria selezionata è visibile a @everyone. Scegli una categoria privata o creane una nuova.');
        resources.ticketCategoryId = category.id;
      } else {
        const current = resources.ticketCategoryId ? await guild.channels.fetch(resources.ticketCategoryId).catch(() => null) : null;
        if (current?.guildId === row.guild_id && current.type === ChannelType.GuildCategory) {
          resources.createdTicketCategory = true;
        } else {
          const name = this.resourceName(input.ticketCategory.name, `${row.id}-ticket`);
          const category = guild.channels.cache.find((candidate) => candidate.guildId === row.guild_id && candidate.type === ChannelType.GuildCategory && candidate.name === name)
            ?? await this.createPrivateCategory(guild, name, [...staffIds], `Creazione pannello ticket ${row.id}`);
          resources.ticketCategoryId = category.id; resources.createdTicketCategory = true;
          this.saveOperationResources(row.id, resources);
          if (category.permissionsFor(guild.roles.everyone)?.has(PermissionFlagsBits.ViewChannel)) throw new AuthorizationError('Discord non ha applicato la riservatezza della categoria ticket.');
        }
      }

      if (input.panelChannel.mode === 'existing') {
        const channel = await guild.channels.fetch(input.panelChannel.id).catch(() => null);
        if (!channel || channel.guildId !== row.guild_id || channel.type !== ChannelType.GuildText) throw new AppError('Il canale selezionato non esiste più o appartiene a un altro server.', 409, 'CANALE_PANNELLO_NON_VALIDO');
        resources.channelId = channel.id;
      } else {
        const current = resources.channelId ? await guild.channels.fetch(resources.channelId).catch(() => null) : null;
        if (current?.guildId === row.guild_id && current.type === ChannelType.GuildText) {
          resources.createdChannel = true;
        } else {
          const name = this.resourceName(input.panelChannel.name, `${row.id}-channel`);
          const channel = guild.channels.cache.find((candidate) => candidate.guildId === row.guild_id && candidate.type === ChannelType.GuildText && candidate.name === name)
            ?? await this.createPanelChannel(guild, name, resources.panelCategoryId, `Creazione pannello ticket ${row.id}`);
          resources.channelId = channel.id; resources.createdChannel = true;
          this.saveOperationResources(row.id, resources);
        }
      }

      const channel = await guild.channels.fetch(resources.channelId!).catch(() => null);
      if (!channel || channel.guildId !== row.guild_id || channel.type !== ChannelType.GuildText) throw new AppError('Il canale del pannello non è disponibile nel server selezionato.', 409, 'CANALE_PANNELLO_NON_VALIDO');
      if (resources.panelCategoryId && (channel as TextChannel).parentId !== resources.panelCategoryId) await (channel as TextChannel).setParent(resources.panelCategoryId, { lockPermissions: false, reason: `Collocazione pannello ticket ${row.id}` });
      await this.configurePanelChannel(guild, channel as TextChannel, `Configurazione pannello ticket ${row.id}`);
      const message = await this.publish(guild, channel as TextChannel, panelId, input, true, resources.messageId);
      resources.messageId = message.id;
      this.saveOperationResources(row.id, resources);
      const now = new Date().toISOString();
      this.db.prepare(`INSERT INTO ticket_panels_managed(id, guild_id, name, channel_id, panel_category_id, ticket_category_id, message_id, config_json, status, version, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', 1, ?, ?, ?)`)
        .run(panelId, row.guild_id, input.name, resources.channelId, resources.panelCategoryId ?? null,
          resources.ticketCategoryId, message.id, JSON.stringify(input), row.actor_id, now, now);
      this.savePanelResources(panelId, row.guild_id, resources, row.id);
      const panel = this.get(row.guild_id, panelId);
      audit(this.db, { guildId: row.guild_id, actorId: row.actor_id, action: 'ticket.panel.create', targetType: 'ticket-panel', targetId: panelId, result: 'ok', after: { channelId: resources.channelId, panelCategoryId: resources.panelCategoryId ?? null, ticketCategoryId: resources.ticketCategoryId, messageId: message.id } });
      this.db.prepare(`UPDATE ticket_operations SET status = 'completed', result_json = ?, resources_json = ?, error_code = NULL, error_message = NULL, updated_at = ? WHERE id = ?`)
        .run(JSON.stringify({ panelId }), JSON.stringify(resources), now, row.id);
      return { operationId: row.id, status: 'completed', panel, resources };
    } catch (error) {
      const publicError = error instanceof AppError ? error : new AppError('Discord non ha completato la creazione. Le risorse già registrate sono conservate per il ripristino.', 502, 'CREAZIONE_PANNELLO_INCOMPLETA');
      const guild = await this.client.guilds.fetch(row.guild_id).catch(() => null);
      if (guild) {
        await guild.channels.fetch().catch(() => null);
        if (input.panelCategory.mode === 'create' && !resources.panelCategoryId) {
          const name = this.resourceName(input.panelCategory.name, `${row.id}-panel`);
          const found = guild.channels.cache.find((channel) => channel.guildId === row.guild_id && channel.type === ChannelType.GuildCategory && channel.name === name);
          if (found) { resources.panelCategoryId = found.id; resources.createdPanelCategory = true; }
        }
        if (input.ticketCategory.mode === 'create' && !resources.ticketCategoryId) {
          const name = this.resourceName(input.ticketCategory.name, `${row.id}-ticket`);
          const found = guild.channels.cache.find((channel) => channel.guildId === row.guild_id && channel.type === ChannelType.GuildCategory && channel.name === name);
          if (found) { resources.ticketCategoryId = found.id; resources.createdTicketCategory = true; }
        }
        if (input.panelChannel.mode === 'create' && !resources.channelId) {
          const name = this.resourceName(input.panelChannel.name, `${row.id}-channel`);
          const found = guild.channels.cache.find((channel) => channel.guildId === row.guild_id && channel.type === ChannelType.GuildText && channel.name === name);
          if (found) { resources.channelId = found.id; resources.createdChannel = true; }
        }
        resources = await this.compensateEmptyNewResources(guild, resources);
      }
      this.saveOperationResources(row.id, resources);
      const now = new Date().toISOString();
      const hasLeftovers = Boolean(resources.panelCategoryId || resources.ticketCategoryId || resources.channelId || resources.messageId);
      const status = hasLeftovers ? 'recovery_needed' : 'failed';
      this.db.prepare('UPDATE ticket_operations SET status = ?, error_code = ?, error_message = ?, updated_at = ? WHERE id = ?')
        .run(status, publicError.code, publicError.message.slice(0, 300), now, row.id);
      audit(this.db, { guildId: row.guild_id, actorId: row.actor_id, action: 'ticket.panel.create', targetType: 'ticket-operation', targetId: row.id, result: status === 'failed' ? 'failed' : 'uncertain', after: { errorCode: publicError.code, resourceIds: resources } });
      return { operationId: row.id, status, resources, error: publicError.message };
    }
  }

  private async publish(guild: Guild, channel: TextChannel, panelId: string, input: ManagedTicketPanelInput, enabled: boolean, knownMessageId?: string): Promise<import('discord.js').Message> {
    const rows = input.layout === 'menu' ? this.menuRows(panelId, input, enabled) : this.buttonRows(panelId, input, enabled);
    const embed = new EmbedBuilder().setColor(Number.parseInt(input.color.slice(1), 16)).setTitle(input.panelTitle)
      .setDescription(input.description).setFooter({ text: `${input.footer} · ticket-panel:${panelId}` });
    let message = knownMessageId ? await channel.messages.fetch(knownMessageId).catch(() => null) : null;
    if (!message) {
      const recent = await channel.messages.fetch({ limit: 50 }).catch(() => null);
      message = recent?.find((item) => item.embeds.some((itemEmbed) => itemEmbed.footer?.text.includes(`ticket-panel:${panelId}`))) ?? null;
    }
    if (message) return message.edit({ embeds: [embed], components: rows, allowedMentions: { parse: [] } });
    return channel.send({ embeds: [embed], components: rows, allowedMentions: { parse: [] } });
  }

  private menuRows(panelId: string, input: ManagedTicketPanelInput, enabled: boolean): ActionRowBuilder<StringSelectMenuBuilder>[] {
    const menu = new StringSelectMenuBuilder().setCustomId(`ticket:select:${panelId}`).setPlaceholder(enabled ? 'Scegli una tipologia di ticket' : 'Questo pannello non accetta nuove richieste')
      .setMinValues(1).setMaxValues(1).setDisabled(!enabled)
      .addOptions(input.categories.map((item) => ({ label: item.label, value: item.key, description: item.description })));
    return [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)];
  }

  private buttonRows(panelId: string, input: ManagedTicketPanelInput, enabled: boolean): ActionRowBuilder<ButtonBuilder>[] {
    const rows: ActionRowBuilder<ButtonBuilder>[] = [];
    for (let index = 0; index < input.categories.length; index += 5) {
      const row = new ActionRowBuilder<ButtonBuilder>();
      for (const item of input.categories.slice(index, index + 5)) {
        row.addComponents(new ButtonBuilder().setCustomId(`ticket:type:${panelId}:${item.key}`).setLabel(item.buttonLabel ?? item.label).setStyle(ButtonStyle.Primary).setDisabled(!enabled));
      }
      rows.push(row);
    }
    return rows;
  }

  private async createPrivateCategory(guild: Guild, name: string, roleIds: string[], reason: string) {
    const botId = this.client.user?.id;
    if (!botId) throw new AppError('Il bot non è connesso a Discord. La creazione del pannello non è partita.', 503, 'BOT_NON_CONNESSO');
    const category = await guild.channels.create({
      name, type: ChannelType.GuildCategory, reason,
      permissionOverwrites: [
        { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: botId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
        ...roleIds.map((id) => ({ id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory] })),
      ],
    });
    return category;
  }

  private async createPanelChannel(guild: Guild, name: string, parentId: string | undefined, reason: string): Promise<TextChannel> {
    const botId = this.client.user?.id;
    if (!botId) throw new AppError('Il bot non è connesso a Discord. La creazione del pannello non è partita.', 503, 'BOT_NON_CONNESSO');
    const channel = await guild.channels.create({
      name, type: ChannelType.GuildText, ...(parentId ? { parent: parentId } : {}), reason,
      permissionOverwrites: [
        { id: guild.roles.everyone.id, allow: [PermissionFlagsBits.ViewChannel], deny: [PermissionFlagsBits.SendMessages] },
        { id: botId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ManageChannels] },
      ],
    });
    if (channel.type !== ChannelType.GuildText) throw new AppError('Discord non ha creato un canale testuale per il pannello.', 502, 'CANALE_NON_VALIDO');
    return channel as TextChannel;
  }

  private async configurePanelChannel(guild: Guild, channel: TextChannel, reason: string): Promise<void> {
    const botId = this.client.user?.id;
    if (!botId) throw new AppError('Il bot non è connesso a Discord.', 503, 'BOT_NON_CONNESSO');
    const writableOverwrites = [...channel.permissionOverwrites.cache.entries()]
      .filter(([id, overwrite]) => id !== guild.roles.everyone.id && id !== botId && overwrite.allow.has(PermissionFlagsBits.SendMessages) && !overwrite.deny.has(PermissionFlagsBits.SendMessages))
      .map(([id]) => id);
    if (writableOverwrites.length) throw new AuthorizationError(`Il canale contiene permessi di invio espliciti per ${writableOverwrites.slice(0, 5).join(', ')}. Rimuovili o crea un canale pannello dedicato.`);
    await channel.permissionOverwrites.edit(guild.roles.everyone.id, { ViewChannel: true, SendMessages: false }, { reason });
    await channel.permissionOverwrites.edit(botId, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true, EmbedLinks: true, ManageChannels: true }, { reason });
    const missing: string[] = [];
    const publicPermissions = channel.permissionsFor(guild.roles.everyone);
    if (!publicPermissions?.has(PermissionFlagsBits.ViewChannel)) missing.push('Visualizza canale per @everyone');
    if (publicPermissions?.has(PermissionFlagsBits.SendMessages)) missing.push('blocco invio messaggi per @everyone');
    const botPermissions = channel.permissionsFor(botId);
    if (!botPermissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.EmbedLinks])) missing.push('permessi del bot nel canale');
    if (missing.length) throw new AuthorizationError(`Permessi del canale pannello non verificati: ${missing.join(', ')}.`);
  }

  private async compensateEmptyNewResources(guild: Guild, resources: CreatedResources): Promise<CreatedResources> {
    const remaining = { ...resources };
    if (remaining.channelId) {
      const channel = await guild.channels.fetch(remaining.channelId).catch(() => null);
      if (channel?.type === ChannelType.GuildText && channel.guildId === guild.id) {
        const textChannel = channel as TextChannel;
        const messages = await textChannel.messages.fetch({ limit: 50 }).catch(() => null);
        const owned = messages?.filter((message) => message.embeds.some((embed) => embed.footer?.text.includes(`ticket-panel:${resources.panelId}`))) ?? null;
        if (owned) for (const message of owned.values()) await message.delete().catch(() => undefined);
        if (owned?.size) delete remaining.messageId;
        const afterDelete = await textChannel.messages.fetch({ limit: 1 }).catch(() => null);
        if (remaining.createdChannel && afterDelete?.size === 0) {
          await textChannel.delete('Annullamento creazione pannello vuoto').then(() => {
            delete remaining.channelId;
            remaining.createdChannel = false;
          }).catch(() => undefined);
        }
        if (remaining.createdChannel && remaining.channelId) {
          const stillPresent = await guild.channels.fetch(remaining.channelId).catch(() => null);
          if (!stillPresent) { delete remaining.channelId; remaining.createdChannel = false; }
        }
      } else if (!channel && remaining.createdChannel) {
        delete remaining.channelId;
        remaining.createdChannel = false;
      }
    }
    for (const [key, createdKey] of [['ticketCategoryId', 'createdTicketCategory'], ['panelCategoryId', 'createdPanelCategory']] as const) {
      const id = remaining[key];
      if (!id || !remaining[createdKey]) continue;
      const category = await guild.channels.fetch(id).catch(() => null);
      if (!category || category.guildId !== guild.id) {
        delete remaining[key];
        remaining[createdKey] = false;
        continue;
      }
      if (category.type !== ChannelType.GuildCategory || category.children.cache.size !== 0) continue;
      await category.delete('Annullamento creazione categoria vuota').then(() => {
        delete remaining[key];
        remaining[createdKey] = false;
      }).catch(() => undefined);
    }
    return remaining;
  }

  private async assertOperatorAndBotPermissions(guild: Guild, actorId: string): Promise<void> {
    const actor = await guild.members.fetch(actorId).catch(() => null);
    const missing: string[] = [];
    if (!actor) missing.push('appartenenza attuale dell’operatore al server');
    else if (actor.id !== guild.ownerId && !actor.permissions.has(PermissionFlagsBits.ManageChannels) && !actor.permissions.has(PermissionFlagsBits.Administrator)) missing.push('Gestisci canali per l’operatore');
    const botId = this.client.user?.id;
    if (!botId || !this.client.isReady()) throw new AppError('Il bot è offline. La richiesta è salvata e può essere ripresa quando il bot torna online.', 503, 'BOT_NON_CONNESSO');
    const bot = await guild.members.fetch(botId).catch(() => null);
    if (!bot) throw new AppError('Il bot non è presente in questo server.', 403, 'BOT_NON_PRESENTE');
    if (!bot.permissions.has(PermissionFlagsBits.ManageChannels)) missing.push('Gestisci canali per il bot');
    if (missing.length) throw new AuthorizationError(`Permessi mancanti: ${missing.join(', ')}. Non è necessario concedere il permesso Amministratore.`);
  }

  private async validateRoles(guild: Guild, ids: string[]): Promise<Role[]> {
    const roles: Role[] = [];
    for (const id of ids) {
      const role = await guild.roles.fetch(id).catch(() => null);
      if (!role || role.guild.id !== guild.id || role.id === guild.roles.everyone.id) throw new AppError('Un ruolo ticket non esiste o non appartiene a questo server.', 409, 'RUOLO_NON_VALIDO');
      roles.push(role);
    }
    return roles;
  }

  private async getGuild(guildId: string): Promise<Guild> {
    if (!this.client.isReady()) throw new AppError('Il bot è offline. La richiesta non è stata dichiarata riuscita.', 503, 'BOT_NON_CONNESSO');
    const guild = await this.client.guilds.fetch(guildId).catch(() => null);
    if (!guild) throw new AppError('Il bot non è presente in questo server o non riesce a raggiungerlo.', 403, 'BOT_NON_PRESENTE');
    return guild;
  }

  private uniqueName(value: string): string {
    const normalized = value.toLowerCase().normalize('NFKD').replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 90);
    return normalized || `ticket-${randomUUID().slice(0, 8)}`;
  }

  private resourceName(value: string, stableId: string): string {
    const suffix = stableId.replace(/[^a-z0-9]/gi, '').slice(-8).toLowerCase();
    const base = this.uniqueName(value).slice(0, 80);
    return `${base}-${suffix}`.slice(0, 100);
  }

  private getOperationRow(guildId: string, operationId: string): OperationRow {
    const row = this.db.prepare('SELECT * FROM ticket_operations WHERE guild_id = ? AND id = ?').get(guildId, operationId) as OperationRow | undefined;
    if (!row) throw new NotFoundError('Operazione ticket non trovata.');
    return row;
  }

  private getPanelRow(guildId: string, panelId: string): PanelRow {
    const row = this.db.prepare('SELECT * FROM ticket_panels_managed WHERE guild_id = ? AND id = ?').get(guildId, panelId) as PanelRow | undefined;
    if (!row) throw new NotFoundError('Pannello ticket non trovato in questo server.');
    return row;
  }

  private readResources(json: string): CreatedResources {
    try { return JSON.parse(json) as CreatedResources; } catch { return {}; }
  }

  private saveOperationResources(operationId: string, resources: CreatedResources): void {
    this.db.prepare('UPDATE ticket_operations SET resources_json = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(resources), new Date().toISOString(), operationId);
  }

  private savePanelResources(panelId: string, guildId: string, resources: CreatedResources, operationId: string | null): void {
    const rows: Array<[string, string | undefined, boolean]> = [
      ['panel_channel', resources.channelId, Boolean(resources.createdChannel)],
      ['panel_category', resources.panelCategoryId, Boolean(resources.createdPanelCategory)],
      ['ticket_category', resources.ticketCategoryId, Boolean(resources.createdTicketCategory)],
      ['panel_message', resources.messageId, Boolean(operationId)],
    ];
    const insert = this.db.prepare(`INSERT INTO ticket_panel_resources(panel_id, guild_id, resource_type, resource_id, created_by_operation, created_at)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(panel_id, resource_type) DO UPDATE SET resource_id = excluded.resource_id`);
    for (const [type, id, created] of rows) if (id) insert.run(panelId, guildId, type, id, created ? 1 : 0, new Date().toISOString());
  }

  private operationView(row: OperationRow): { operationId: string; status: OperationStatus; panel?: ManagedTicketPanel; resources: CreatedResources; error?: string } {
    const result = row.result_json ? JSON.parse(row.result_json) as { panelId?: string } : {};
    const panel = result.panelId ? this.get(row.guild_id, result.panelId) : undefined;
    return { operationId: row.id, status: row.status, ...(panel ? { panel } : {}), resources: this.readResources(row.resources_json), ...(row.error_message ? { error: row.error_message } : {}) };
  }
}
