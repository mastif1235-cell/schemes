-- Forward-only additive migration: cross-device notebook cover + per-user unread.
-- No legacy table, row or index is touched. Must be validated on a non-production D1 first.

-- One row per notebook. The cover image lives in Telegram (file id) exactly like photos do;
-- D1 stores only the reference plus a small preview. deleted_at is a synced tombstone, so a
-- removed cover disappears on every device instead of living only in localStorage.
CREATE TABLE notebook_covers (
  notebook_id TEXT PRIMARY KEY REFERENCES notebooks(id),
  cover_revision INTEGER NOT NULL DEFAULT 1 CHECK (cover_revision >= 1),
  telegram_message_id INTEGER,
  telegram_file_id TEXT,
  telegram_file_unique_id TEXT,
  storage_object_id TEXT,
  mime_type TEXT,
  file_size INTEGER,
  preview_base64 TEXT,
  preview_mime TEXT,
  updated_by TEXT REFERENCES users(id),
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  seq INTEGER NOT NULL,
  client_ref TEXT NOT NULL
);

CREATE UNIQUE INDEX ux_notebook_covers_client_ref
ON notebook_covers(notebook_id, client_ref);

CREATE INDEX idx_notebook_covers_seq
ON notebook_covers(seq);

-- Per-user read cursor for shared activity history. Opening history on one device never
-- changes another user's unread state.
CREATE TABLE activity_seen (
  user_id TEXT NOT NULL REFERENCES users(id),
  notebook_id TEXT NOT NULL REFERENCES notebooks(id),
  last_seen_seq INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, notebook_id)
);

CREATE INDEX idx_activity_seen_notebook
ON activity_seen(notebook_id);
