-- Forward-only additive migration: per-spread read cursor so a spread badge can be cleared
-- without touching the notebook-level cursor. No legacy object is modified.

CREATE TABLE activity_spread_seen (
  user_id TEXT NOT NULL REFERENCES users(id),
  spread_id TEXT NOT NULL REFERENCES spreads(id),
  last_seen_seq INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, spread_id)
);

CREATE INDEX idx_activity_spread_seen_spread
ON activity_spread_seen(spread_id);
