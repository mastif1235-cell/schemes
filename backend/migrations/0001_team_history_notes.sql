-- Forward-only additive migration for team notes and shared activity history.
-- This file must be validated against a non-production D1 database before use.

CREATE TABLE spread_notes (
  id TEXT PRIMARY KEY,
  spread_id TEXT NOT NULL REFERENCES spreads(id),
  notebook_id TEXT NOT NULL REFERENCES notebooks(id),
  author_id TEXT NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  seq INTEGER NOT NULL,
  client_ref TEXT NOT NULL
);

CREATE UNIQUE INDEX ux_spread_notes_author_client_ref
ON spread_notes(author_id, client_ref);

CREATE INDEX idx_spread_notes_spread_active
ON spread_notes(spread_id, deleted_at, created_at, id);

CREATE INDEX idx_spread_notes_notebook_seq
ON spread_notes(notebook_id, seq);

CREATE TABLE activity_events (
  id TEXT PRIMARY KEY,
  notebook_id TEXT NOT NULL REFERENCES notebooks(id),
  spread_id TEXT REFERENCES spreads(id),
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  action TEXT NOT NULL,
  entity_revision_before INTEGER,
  entity_revision_after INTEGER,
  old_value TEXT CHECK (old_value IS NULL OR json_valid(old_value)),
  new_value TEXT CHECK (new_value IS NULL OR json_valid(new_value)),
  payload_json TEXT CHECK (payload_json IS NULL OR json_valid(payload_json)),
  created_at TEXT NOT NULL,
  seq INTEGER NOT NULL,
  client_ref TEXT NOT NULL
);

CREATE UNIQUE INDEX ux_activity_events_idempotency
ON activity_events(actor_user_id, client_ref);

CREATE INDEX idx_activity_events_notebook_seq
ON activity_events(notebook_id, seq);

CREATE INDEX idx_activity_events_notebook_time
ON activity_events(notebook_id, created_at DESC, id DESC);

CREATE INDEX idx_activity_events_spread_time
ON activity_events(spread_id, created_at DESC, id DESC)
WHERE spread_id IS NOT NULL;

CREATE INDEX idx_activity_events_entity_revision
ON activity_events(entity, entity_id, entity_revision_after);
