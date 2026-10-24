CREATE TABLE IF NOT EXISTS guild_settings (
  guild_id TEXT PRIMARY KEY,
  settings_json TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  before_json TEXT,
  after_json TEXT,
  result TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_log_guild_time ON audit_log(guild_id, created_at DESC);

CREATE TABLE IF NOT EXISTS tickets (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  channel_id TEXT,
  opener_id TEXT NOT NULL,
  category_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('creating','open','closing','closed','failed')),
  assigned_to TEXT,
  close_reason TEXT,
  opened_at TEXT NOT NULL,
  closed_at TEXT,
  transcript_message_id TEXT
);
CREATE INDEX IF NOT EXISTS tickets_guild_status ON tickets(guild_id, status);
CREATE INDEX IF NOT EXISTS tickets_user_time ON tickets(guild_id, opener_id, opened_at DESC);

CREATE TABLE IF NOT EXISTS ticket_participants (
  guild_id TEXT NOT NULL,
  ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  added_by TEXT NOT NULL,
  added_at TEXT NOT NULL,
  PRIMARY KEY(ticket_id, user_id)
);
CREATE TABLE IF NOT EXISTS ticket_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ticket_events_order ON ticket_events(guild_id, ticket_id, id);
CREATE TABLE IF NOT EXISTS ticket_panels (
  guild_id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ticket_transcripts (
  guild_id TEXT NOT NULL,
  ticket_id TEXT PRIMARY KEY REFERENCES tickets(id) ON DELETE CASCADE,
  transcript_text TEXT NOT NULL,
  message_count INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  reporter_id TEXT NOT NULL,
  target_user_id TEXT,
  roblox_id TEXT,
  category TEXT NOT NULL,
  description TEXT NOT NULL,
  evidence TEXT,
  source_message_id TEXT,
  confidential INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK(status IN ('new','assigned','info_requested','accepted','rejected')),
  assigned_to TEXT,
  resolution TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS reports_guild_status ON reports(guild_id, status, confidential, created_at DESC);
CREATE TABLE IF NOT EXISTS report_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS moderation_cases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  case_number INTEGER NOT NULL,
  action TEXT NOT NULL,
  operator_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  result TEXT NOT NULL,
  discord_reference TEXT,
  parent_case_number INTEGER,
  created_at TEXT NOT NULL,
  UNIQUE(guild_id, case_number)
);
CREATE TABLE IF NOT EXISTS guild_case_sequences (
  guild_id TEXT PRIMARY KEY,
  last_case_number INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS cases_guild_target ON moderation_cases(guild_id, target_id, created_at DESC);
CREATE TABLE IF NOT EXISTS warnings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  case_number INTEGER NOT NULL,
  target_id TEXT NOT NULL,
  operator_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  revoked_by TEXT,
  revocation_reason TEXT,
  UNIQUE(guild_id, case_number)
);

CREATE TABLE IF NOT EXISTS scheduled_tasks (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  run_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','running','completed','cancelled','failed')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS scheduled_due ON scheduled_tasks(status, run_at);

CREATE TABLE IF NOT EXISTS lockdown_snapshots (
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  previous_allow TEXT NOT NULL,
  previous_deny TEXT NOT NULL,
  applied_allow TEXT NOT NULL,
  applied_deny TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  PRIMARY KEY(guild_id, channel_id)
);
CREATE TABLE IF NOT EXISTS automation_state (
  guild_id TEXT PRIMARY KEY,
  stopped INTEGER NOT NULL DEFAULT 0,
  stopped_by TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS native_automod_rules (
  guild_id TEXT PRIMARY KEY,
  rule_id TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS web_sessions (
  id_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  access_token_enc TEXT NOT NULL,
  refresh_token_enc TEXT,
  csrf_token TEXT NOT NULL,
  access_expires_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS oauth_states (
  state_hash TEXT PRIMARY KEY,
  code_verifier TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS confirmations (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  action_json TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);
