export interface GuildChoice { id: string; name: string; owner: boolean; canManageGuild: boolean; canManageChannels: boolean; icon: string | null; botStatus: 'presente' | 'assente' | 'offline'; inviteUrl?: string; }
export interface DiscordUser { id: string; username: string; global_name: string | null; }
export interface TicketField { key: string; label: string; style: 'short' | 'paragraph'; required: boolean; }
export interface TicketCategory { key: string; label: string; description: string; staffRoleIds: string[]; fields: TicketField[]; }
export interface GuildSettings {
  general: { name: string; language: 'it'; color: string; footer: string };
  messages: { welcomeTitle: string; welcomeContent: string; ticketPanelTitle: string; ticketPanelDescription: string };
  permissions: { roles: { ticketStaff: string[]; reportStaff: string[]; confidentialReportStaff: string[]; moderate: string[]; configure: string[] } };
  channels: { logs: string | null; announcements: string | null; welcome: string | null; ticketParent: string | null; ticketPanel: string | null; reports: string | null; confidentialReports: string | null; securityAlerts: string | null };
  tickets: { enabled: boolean; maxOpenPerUser: number; cooldownSeconds: number; transcriptMessageLimit: number; categories: TicketCategory[] };
  moderation: { warningEscalationEnabled: boolean; warningEscalations: Array<{ count: number; action: 'timeout'; durationMinutes: number }> };
  announcements: { allowedRoleMentions: string[] };
  security: {
    mode: 'observe' | 'alert' | 'enforce'; automatedActionsEnabled: boolean; allowInvites: boolean;
    blockedDomains: string[]; allowedDomains: string[]; excludedChannelIds: string[]; excludedRoleIds: string[]; excludedUserIds: string[];
    duplicateWindowSeconds: number; duplicateMessageLimit: number; mentionLimit: number; joinSpikeCount: number; joinSpikeWindowSeconds: number;
    newAccountDays: number; automod: { enabled: boolean; blockedWords: string[] };
  };
  retention: { days: number; automaticCleanupEnabled: boolean };
  modules: { tickets: boolean; reports: boolean; moderation: boolean; security: boolean; announcements: boolean };
}
export interface StoredSettings { guildId: string; settings: GuildSettings; version: number; updatedAt: string; updatedBy: string; }
export interface Ticket { id: string; guildId: string; channelId: string | null; openerId: string; categoryKey: string; status: 'creating' | 'open' | 'closing' | 'closed' | 'failed'; assignedTo: string | null; closeReason: string | null; openedAt: string; closedAt: string | null; panelId: string | null; }
export interface TicketPanelType { key: string; label: string; buttonLabel?: string; description: string; staffRoleIds: string[]; fields: TicketField[]; }
export type TicketResourceChoice = { mode: 'create'; name: string } | { mode: 'existing'; id: string };
export interface TicketPanelInput {
  name: string; panelTitle: string; description: string; color: string; footer: string; layout: 'menu' | 'buttons';
  panelCategory: TicketResourceChoice; panelChannel: TicketResourceChoice; ticketCategory: TicketResourceChoice;
  staffRoleIds: string[]; maxOpenPerUser: number; maxConcurrentTotal: number; cooldownSeconds: number; categories: TicketPanelType[];
}
export interface TicketPanel {
  id: string; guildId: string; name: string; channelId: string; panelCategoryId: string | null; ticketCategoryId: string;
  messageId: string; status: 'active' | 'disabled' | 'needs_repair'; enabled: boolean; version: number; createdAt: string; updatedAt: string;
  config: TicketPanelInput; health?: { panelChannel: boolean; panelChannelPublic: boolean; panelChannelReadOnly: boolean; panelBotAccess: boolean; panelCategory: boolean; ticketCategory: boolean; ticketCategoryPrivate: boolean; message: boolean; missing: string[] }; ticketCount?: number;
}
export interface TicketParticipant { userId: string; addedBy: string; addedAt: string; }
export interface TicketMessage { id: string; authorId: string; authorName: string; bot: boolean; content: string; createdAt: string; attachments: string[]; }
export interface Report { id: string; guildId: string; reporterId: string; targetUserId: string | null; robloxId: string | null; category: string; description: string; evidence: string | null; sourceMessageId: string | null; confidential: boolean; status: 'new' | 'assigned' | 'info_requested' | 'accepted' | 'rejected'; assignedTo: string | null; resolution: string | null; createdAt: string; updatedAt: string; }
export interface ReportEvent { actorId: string; eventType: string; detail: string | null; createdAt: string; }
export interface AuditRecord { id: number; actorId: string; action: string; targetType: string; targetId: string | null; before: string | null; after: string | null; result: string; createdAt: string; }
export interface ModerationCase { caseNumber: number; guildId: string; action: string; operatorId: string; targetId: string; reason: string; result: string; discordReference: string | null; parentCaseNumber: number | null; createdAt: string; }
export interface Warning { caseNumber: number; operatorId: string; reason: string; createdAt: string; revokedAt: string | null; revocationReason: string | null; }
export interface AnnouncementInput { type: 'annuncio' | 'manutenzione' | 'aggiornamento' | 'evento'; title: string; content: string; roleIds: string[]; runAt?: string; channelId: string; }
export interface ScheduledAnnouncement { id: string; guildId: string; input: AnnouncementInput; runAt: string; status: string; createdBy: string; version: number; updatedAt: string; lastError: string | null; }
export interface GuildResources {
  guildId: string;
  bot: { highestRolePosition: number };
  channels: Array<{ id: string; name: string; type: number; parentId: string | null; position: number; publicView: boolean; permissions: { view: boolean; send: boolean; embed: boolean; manageChannels: boolean }; compatible: { ticketPanel: boolean; announcements: boolean; staffText: boolean; ticketCategory: boolean; lockdown: boolean } }>;
  roles: Array<{ id: string; name: string; color: string; position: number; managed: boolean; assignable: boolean }>;
}
