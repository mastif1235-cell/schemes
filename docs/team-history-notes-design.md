# Team notes, activity history and spread ordering

Status: design checkpoint only. This document does not modify Worker, D1, authentication, or existing browser data.

## Safety invariants

- Existing `notebooks`, `spreads`, `photos`, Telegram identifiers, memberships, sessions, and favorites remain in place.
- No table is dropped, rebuilt, cleared, or mass-renumbered during migration.
- Existing `note_short` and `note_full` values remain stored and are shown read-only as legacy notes; they are not silently converted or deleted.
- Notes are independent entities. Two users creating notes concurrently produce two rows, never a spread conflict.
- Activity events are append-only. Editing or deleting a note creates a new event and never deletes its audit trail.
- A metadata mutation never writes `current_photo_id` or photo rows. A photo mutation never replaces spread text/metadata.

## Proposed additive D1 migration

The Worker repository and its current D1 schema are not present in this repository. The table and column references below must be checked against that source before this SQL becomes a numbered migration.

```sql
CREATE TABLE spread_notes (
  id TEXT PRIMARY KEY,
  notebook_id TEXT NOT NULL,
  spread_id TEXT NOT NULL,
  client_ref TEXT NOT NULL,
  author_user_id TEXT NOT NULL,
  author_display_name TEXT NOT NULL,
  body TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  UNIQUE(author_user_id, client_ref)
);

CREATE INDEX idx_spread_notes_spread_time
  ON spread_notes(spread_id, created_at, id);
CREATE INDEX idx_spread_notes_notebook_updated
  ON spread_notes(notebook_id, updated_at, id);

CREATE TABLE activity_events (
  id TEXT PRIMARY KEY,
  notebook_id TEXT NOT NULL,
  spread_id TEXT,
  actor_user_id TEXT NOT NULL,
  actor_display_name TEXT NOT NULL,
  action_type TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  client_ref TEXT NOT NULL,
  entity_revision_before INTEGER,
  entity_revision_after INTEGER,
  old_value_json TEXT,
  new_value_json TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(actor_user_id, client_ref)
);

CREATE INDEX idx_activity_notebook_time
  ON activity_events(notebook_id, created_at DESC, id DESC);
CREATE INDEX idx_activity_spread_time
  ON activity_events(spread_id, created_at DESC, id DESC);
CREATE INDEX idx_activity_entity_revision
  ON activity_events(entity_type, entity_id, entity_revision_after);
```

`client_ref` is generated once on the device and retained across retries. The unique constraints make note creation and every logged mutation idempotent. Foreign keys and their exact referenced columns must be added only after verifying the real D1 schema; no `ON DELETE CASCADE` is allowed for audit data.

## IndexedDB v3 additive upgrade

Keep every existing store unchanged and add only:

- `spread_notes`, key `id`; indexes `spread_id`, `notebook_id`, `server_id`, `updated_at`.
- `activity_events`, key `id`; indexes `notebook_id`, `spread_id`, `server_id`, `created_at`.

The existing `sync_queue` is reused with entities `spread_note` and `spread_order`. Upgrade must use `indexedDB.open('blocknotDB', 3)` and only guarded `objectStoreNames.contains(...)` creation. No `deleteObjectStore`, `clear`, or record rewrite.

## API contract

All endpoints use the existing bearer session and verify notebook membership server-side.

### Notes

- `POST /api/spreads/:spreadId/notes`
  - request: `{ client_ref, body, created_at }`
  - response: `{ note }`
  - duplicate `(actor_user_id, client_ref)` returns the original successful `note`.
- `PATCH /api/notes/:noteId`
  - request: `{ client_ref, body, revision }`
  - owner only; transaction updates the note and appends `note_updated` with old/new body.
- `DELETE /api/notes/:noteId`
  - request: `{ client_ref, revision }`
  - owner only; soft delete sets `deleted_at` and appends `note_deleted` with the previous body.
- `GET /api/spreads/:spreadId/notes?before=<cursor>&limit=100`
  - response: `{ notes, next_cursor, has_more }`.

### Activity

- `GET /api/notebooks/:notebookId/activity?before=<cursor>&limit=100`
- `GET /api/spreads/:spreadId/activity?before=<cursor>&limit=100`

Events are created only by the Worker inside the same transaction as the accepted mutation. Clients cannot submit arbitrary actor names or activity events.

### Ordering

- `PUT /api/notebooks/:notebookId/spreads/order`
  - request: `{ client_ref, base_revision, spread_ids: [...] }`
  - response: `{ notebook_revision, spreads, activity_event }`.

The Worker validates ownership/membership, uniqueness, and that `spread_ids` exactly matches the active server spreads. In one transaction it assigns collision-free temporary negative numbers, then final numbers `1..N`, increments affected revisions, and appends one `spreads_reordered` event containing old/new ID-number arrays. Ordinary spread deletion never renumbers anything.

### Existing spread metadata PATCH

Extend, do not remove, the current endpoint with an optional field-level request:

```json
{
  "client_ref": "device mutation id",
  "base_revision": 12,
  "changes": { "title": "new title", "status": "done" }
}
```

Only keys present in `changes` are written. `current_photo_id` is not accepted here. If the server revision advanced, `activity_events.metadata_json.changed_fields` is used to detect overlap since `base_revision`: non-overlapping fields merge; overlapping fields return `409` containing only the conflicting fields. Legacy clients keep the existing contract during rollout.

## Incremental sync model

- Existing `/api/sync?since=...` adds `spread_notes` and `activity_events` collections without removing current collections.
- Notebook snapshot adds `spread_notes`; activity is paged separately to avoid an unbounded snapshot.
- Offline note is stored locally first and one `spread_note` queue item retains the same `client_ref` through exponential retry.
- A note waits while its notebook or spread lacks `server_id`; it is not marked done.
- Pull maps server notebook/spread IDs to local IDs, upserts by `server_id` or `client_ref`, and keeps tombstones for deleted notes.
- Cursor advances only after the complete batch is committed locally.
- Notes have their own revision. They do not participate in the parent spread revision conflict.
- Ordering is a single notebook-level `spread_order` queue operation. A later local reorder coalesces older unsent reorder operations for that notebook.

## Required server-generated actions

`notebook_created`, `notebook_renamed`, `notebook_description_changed`, `spread_created`, `spread_number_changed`, `spreads_reordered`, `spread_deleted`, `spread_restored`, `spread_title_changed`, `spread_tags_changed`, `spread_status_changed`, `photo_added`, `photo_replaced`, `photo_rotated`, `note_added`, `note_updated`, `note_deleted`, `member_added`, and `member_removed` when supported.

## Rollout order

1. Verify and back up the actual D1 schema; run the additive migration only.
2. Deploy backward-compatible Worker endpoints and sync response additions.
3. Test old v3.4.2 against the new Worker.
4. Add the guarded IndexedDB v3 stores and frontend queue handling.
5. Enable notes/history/reorder UI after two-device tests.
6. Keep the local history during transition; label team history separately until server sync is verified.

## Required tests before release

Two simultaneous notes, offline create and retry, duplicate `client_ref`, edit, soft delete with preserved event, reorder `1 ↔ 2`, delete without renumber, explicit renumber, selected-notebook search, direct camera flow, metadata update preserving photo, photo rotation, v3.4.2 IndexedDB upgrade, cursor pagination, membership denial, and the Owner/Partner two-phone plan.
