ALTER TABLE tickets ADD COLUMN panel_id TEXT;
ALTER TABLE tickets ADD COLUMN form_data_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE tickets ADD COLUMN interaction_id TEXT;
ALTER TABLE tickets ADD COLUMN panel_config_json TEXT;
ALTER TABLE tickets ADD COLUMN ticket_category_id TEXT;
CREATE UNIQUE INDEX tickets_interaction_id ON tickets(guild_id, interaction_id) WHERE interaction_id IS NOT NULL;
CREATE INDEX tickets_panel_status ON tickets(guild_id, panel_id, status, opened_at DESC);

CREATE TABLE ticket_panels_managed (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  name TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  panel_category_id TEXT,
  ticket_category_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  config_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active','disabled','needs_repair')),
  version INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(guild_id, message_id)
);
CREATE INDEX ticket_panels_managed_guild ON ticket_panels_managed(guild_id, created_at DESC);

CREATE TABLE ticket_operations (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  operation_kind TEXT NOT NULL CHECK(operation_kind IN ('panel.create','panel.update','panel.repair','ticket.open')),
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','in_progress','completed','recovery_needed','failed')),
  request_json TEXT NOT NULL,
  resources_json TEXT NOT NULL DEFAULT '{}',
  result_json TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(guild_id, operation_kind, idempotency_key)
);
CREATE INDEX ticket_operations_recovery ON ticket_operations(status, updated_at);

CREATE TABLE ticket_panel_resources (
  panel_id TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  resource_type TEXT NOT NULL CHECK(resource_type IN ('panel_channel','panel_category','ticket_category','panel_message')),
  resource_id TEXT NOT NULL,
  created_by_operation INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  PRIMARY KEY(panel_id, resource_type)
);
