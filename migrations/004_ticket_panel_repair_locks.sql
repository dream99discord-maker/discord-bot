CREATE TABLE ticket_panel_repair_locks (
  panel_id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  locked_at TEXT NOT NULL
);
