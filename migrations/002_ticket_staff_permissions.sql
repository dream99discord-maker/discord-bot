CREATE TABLE IF NOT EXISTS ticket_staff_permissions (
  guild_id TEXT NOT NULL,
  ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  role_id TEXT NOT NULL,
  previous_allow TEXT NOT NULL,
  previous_deny TEXT NOT NULL,
  applied_allow TEXT NOT NULL,
  applied_deny TEXT NOT NULL,
  PRIMARY KEY(ticket_id, role_id)
);
