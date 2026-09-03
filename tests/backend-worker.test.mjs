import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker from '../backend/worker.js';

class TestPreparedStatement {
  constructor(owner, sql, params = []) {
    this.owner = owner;
    this.sql = sql;
    this.params = params;
  }
  bind(...params) {
    assert.ok(params.length <= 100, 'D1 maximum 100 parameters per statement');
    return new TestPreparedStatement(this.owner, this.sql, params);
  }
  async all() {
    const results = this.owner.sqlite.prepare(this.sql).all(...this.params);
    return { success: true, results, meta: { changes: 0 } };
  }
  async first(column) {
    const row = this.owner.sqlite.prepare(this.sql).get(...this.params) || null;
    return column && row ? row[column] : row;
  }
  async run() { return this.runSync(); }
  runSync() {
    const info = this.owner.sqlite.prepare(this.sql).run(...this.params);
    return {
      success: true,
      results: [],
      meta: {
        changes: Number(info.changes),
        last_row_id: Number(info.lastInsertRowid),
      },
    };
  }
}

class TestD1 {
  constructor(sqlite) { this.sqlite = sqlite; }
  prepare(sql) { return new TestPreparedStatement(this, sql); }
  async batch(statements) {
    assert.ok(statements.length <= 40, 'leave room for auth/read queries on D1 Free');
    if (this.beforeBatch) { const hook = this.beforeBatch; this.beforeBatch = null; hook(); }
    this.sqlite.exec('BEGIN IMMEDIATE');
    try {
      const results = statements.map(statement => statement.runSync());
      this.sqlite.exec('COMMIT');
      return results;
    } catch (error) {
      this.sqlite.exec('ROLLBACK');
      throw error;
    }
  }
}

const baseSchema = `
PRAGMA foreign_keys=ON;
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL,
  device_name TEXT,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE TABLE notebooks (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  created_by TEXT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  description TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  seq INTEGER NOT NULL,
  client_ref TEXT,
  deleted_at TEXT,
  deleted_by TEXT
);
CREATE TABLE notebook_members (
  notebook_id TEXT NOT NULL REFERENCES notebooks(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL,
  added_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  seq INTEGER NOT NULL,
  revoked_at TEXT,
  PRIMARY KEY(notebook_id,user_id)
);
CREATE TABLE spreads (
  id TEXT PRIMARY KEY,
  notebook_id TEXT NOT NULL REFERENCES notebooks(id),
  number INTEGER NOT NULL,
  title TEXT,
  note_short TEXT,
  note_full TEXT,
  status TEXT NOT NULL DEFAULT 'Актуально',
  current_photo_id TEXT,
  searchableText TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_by TEXT REFERENCES users(id),
  updated_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  seq INTEGER NOT NULL,
  deleted_at TEXT,
  deleted_by TEXT REFERENCES users(id),
  client_ref TEXT
);
CREATE UNIQUE INDEX ux_spreads_notebook_number
ON spreads(notebook_id, number) WHERE deleted_at IS NULL;
CREATE TABLE photos (
  id TEXT PRIMARY KEY,
  spread_id TEXT NOT NULL REFERENCES spreads(id),
  version INTEGER NOT NULL,
  is_current INTEGER NOT NULL,
  provider TEXT,
  storage_object_id TEXT,
  telegram_message_id TEXT,
  telegram_file_id TEXT,
  telegram_file_unique_id TEXT,
  mime_type TEXT,
  file_size INTEGER,
  created_by TEXT,
  created_at TEXT,
  seq INTEGER NOT NULL,
  client_upload_id TEXT
);
CREATE TABLE history (
  id TEXT PRIMARY KEY,
  notebook_id TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  action TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE change_seq (seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL);
CREATE TABLE tags (
  id TEXT PRIMARY KEY,
  notebook_id TEXT NOT NULL,
  name TEXT,
  normalized_name TEXT,
  seq INTEGER NOT NULL,
  deleted_at TEXT
);
CREATE TABLE spread_tags (
  spread_id TEXT NOT NULL,
  tag_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  deleted_at TEXT,
  PRIMARY KEY(spread_id,tag_id)
);
CREATE TABLE user_favorites (
  user_id TEXT NOT NULL,
  spread_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  deleted_at TEXT,
  PRIMARY KEY(user_id,spread_id)
);
CREATE TABLE invites (
  id TEXT PRIMARY KEY, notebook_id TEXT, code_hash TEXT, role TEXT,
  created_by TEXT, created_at TEXT, expires_at TEXT, used_by TEXT, used_at TEXT
);
CREATE TABLE uploads (
  client_upload_id TEXT PRIMARY KEY, photo_id TEXT, result_json TEXT, created_at TEXT
);
CREATE TABLE photo_previews (
  photo_id TEXT PRIMARY KEY, preview_base64 TEXT, mime_type TEXT, created_at TEXT
);
`;

function tokenHash(token) {
  return createHash('sha256').update(token).digest('hex');
}

function createFixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(baseSchema);
  sqlite.exec(readFileSync(new URL('../backend/migrations/0001_team_history_notes.sql', import.meta.url), 'utf8'));
  const now = '2026-09-03T10:00:00.000Z';
  const expiry = '2099-01-01T00:00:00.000Z';
  const seed = sqlite.prepare.bind(sqlite);
  seed('INSERT INTO users VALUES (?,?,?)').run('u1', 'Артём', now);
  seed('INSERT INTO users VALUES (?,?,?)').run('u2', 'Петя', now);
  seed('INSERT INTO sessions(id,user_id,token_hash,device_name,created_at,expires_at) VALUES(?,?,?,?,?,?)')
    .run('session-1', 'u1', tokenHash('token-1'), 'phone-a', now, expiry);
  seed('INSERT INTO sessions(id,user_id,token_hash,device_name,created_at,expires_at) VALUES(?,?,?,?,?,?)')
    .run('session-2', 'u2', tokenHash('token-2'), 'phone-b', now, expiry);
  seed(`INSERT INTO notebooks
    (id,owner_id,created_by,title,created_at,updated_at,revision,seq)
    VALUES(?,?,?,?,?,?,?,?)`).run('n1', 'u1', 'u1', 'Общий', now, now, 1, 1);
  seed(`INSERT INTO notebook_members
    (notebook_id,user_id,role,added_at,updated_at,seq) VALUES(?,?,?,?,?,?)`)
    .run('n1', 'u1', 'OWNER', now, now, 1);
  seed(`INSERT INTO notebook_members
    (notebook_id,user_id,role,added_at,updated_at,seq) VALUES(?,?,?,?,?,?)`)
    .run('n1', 'u2', 'MEMBER', now, now, 1);
  seed(`INSERT INTO spreads
    (id,notebook_id,number,title,note_short,note_full,status,current_photo_id,searchableText,
     created_by,created_at,updated_by,updated_at,revision,seq)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run('s1', 'n1', 1, 'Разворот', 'legacy short', 'legacy full', 'Актуально', null,
      '1 разворот legacy short legacy full', 'u1', now, 'u1', now, 1, 2);
  return { sqlite, env: { DB: new TestD1(sqlite) } };
}

async function api(env, method, path, token = 'token-1', body) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  let requestBody;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    requestBody = JSON.stringify(body);
  }
  const response = await worker.fetch(new Request(`https://worker.test${path}`, {
    method, headers, body: requestBody,
  }), env, { waitUntil() {} });
  const data = response.status === 204 ? null : await response.json();
  return { status: response.status, data, headers: response.headers };
}

const { sqlite, env } = createFixture();

const created = await api(env, 'POST', '/api/spreads/s1/notes', 'token-1', {
  id: 'note-1', client_ref: 'phone-a:create-1', body: 'Проверил муфту',
});
assert.equal(created.status, 201, 'create note');
assert.equal(created.data.note.author_id, 'u1');
assert.equal(created.data.note.body, 'Проверил муфту');

const retry = await api(env, 'POST', '/api/spreads/s1/notes', 'token-1', {
  id: 'different-id', client_ref: 'phone-a:create-1', body: 'Проверил муфту',
});
assert.equal(retry.status, 200, 'retry note');
assert.equal(retry.data.note.id, 'note-1');
assert.equal(sqlite.prepare('SELECT COUNT(*) AS c FROM spread_notes WHERE client_ref=?').get('phone-a:create-1').c, 1);

const secondPhone = await api(env, 'POST', '/api/spreads/s1/notes', 'token-2', {
  id: 'note-2', client_ref: 'phone-b:create-1', body: 'Обновил бумажный блокнот',
});
assert.equal(secondPhone.status, 201, 'second phone creates independent note');
assert.equal(sqlite.prepare('SELECT COUNT(*) AS c FROM spread_notes').get().c, 2);

const edited = await api(env, 'PATCH', '/api/notes/note-1', 'token-1', {
  client_ref: 'phone-a:edit-1', revision: 1, body: 'Проверил муфту — всё нормально',
});
assert.equal(edited.status, 200, 'edit own note');
assert.equal(edited.data.note.revision, 2);

const editForeign = await api(env, 'PATCH', '/api/notes/note-1', 'token-2', {
  client_ref: 'phone-b:edit-foreign', revision: 2, body: 'Нельзя',
});
assert.equal(editForeign.status, 403, 'cannot edit foreign note');

const deleted = await api(env, 'DELETE', '/api/notes/note-1', 'token-1', {
  client_ref: 'phone-a:delete-1', revision: 2,
});
assert.equal(deleted.status, 200, 'soft delete note');
assert.ok(deleted.data.note.deleted_at);
assert.equal(sqlite.prepare('SELECT COUNT(*) AS c FROM spread_notes WHERE id=?').get('note-1').c, 1);

const deleteEvent = sqlite.prepare("SELECT old_value FROM activity_events WHERE action='note.deleted'").get();
assert.equal(JSON.parse(deleteEvent.old_value).body, 'Проверил муфту — всё нормально');

const activityForMember = await api(env, 'GET', '/api/notebooks/n1/activity', 'token-2');
assert.equal(activityForMember.status, 200, 'activity visible to second member');
assert.ok(activityForMember.data.events.some(event => event.action === 'note.deleted'));

const sync = await api(env, 'GET', '/api/sync?since=2', 'token-2');
assert.equal(sync.status, 200, 'incremental sync');
assert.ok(sync.data.changes.spread_notes.some(note => note.id === 'note-1'));
assert.ok(sync.data.changes.activity_events.some(event => event.action === 'note.deleted'));

sqlite.prepare(`INSERT INTO spread_notes
  (id,spread_id,notebook_id,author_id,body,created_at,updated_at,revision,seq,client_ref)
  VALUES(?,?,?,?,?,?,?,?,?,?)`).run('tie-1', 's1', 'n1', 'u1', 'tie one', 'x', 'x', 1, 1000, 'tie-1');
sqlite.prepare(`INSERT INTO spread_notes
  (id,spread_id,notebook_id,author_id,body,created_at,updated_at,revision,seq,client_ref)
  VALUES(?,?,?,?,?,?,?,?,?,?)`).run('tie-2', 's1', 'n1', 'u2', 'tie two', 'x', 'x', 1, 1000, 'tie-2');
const tiedSync = await api(env, 'GET', '/api/sync?since=999&limit=1', 'token-1');
assert.deepEqual(tiedSync.data.changes.spread_notes.map(note => note.id), ['tie-1', 'tie-2']);
assert.equal(tiedSync.data.next_cursor, 1000);

const scenario = createFixture();
const db2 = scenario.sqlite, env2 = scenario.env;
for (const [id, version, current] of [['p1', 1, 1], ['p2', 2, 0]]) {
  db2.prepare('INSERT INTO photos(id,spread_id,version,is_current,seq) VALUES(?,?,?,?,?)').run(id, 's1', version, current, 1);
}
db2.prepare('UPDATE spreads SET current_photo_id=? WHERE id=?').run('p1', 's1');
const beforePhoto = db2.prepare('SELECT * FROM spreads WHERE id=?').get('s1');
const madeCurrent = await api(env2, 'POST', '/api/spreads/s1/photos/p2/make-current', 'token-1', { client_ref: 'switch-photo' });
assert.equal(madeCurrent.status, 200);
const textMerge = await api(env2, 'PATCH', '/api/spreads/s1', 'token-2', {
  client_ref: 'b:text', base_revision: beforePhoto.revision,
  changes: { title: 'Текст с телефона B' }, base_values: { title: beforePhoto.title },
});
assert.equal(textMerge.status, 200, 'photo update + stale text update merge');
assert.equal(textMerge.data.spread.current_photo_id, 'p2', 'metadata never removes photo');
const phoneAPull = await api(env2, 'GET', '/api/sync?since=0', 'token-1');
assert.equal(phoneAPull.data.changes.spreads.find(row => row.id === 's1').title, 'Текст с телефона B');
assert.equal(phoneAPull.data.changes.spreads.find(row => row.id === 's1').current_photo_id, 'p2');
assert.equal(phoneAPull.data.changes.photos.find(row => row.id === 'p1').is_current, 0);
assert.equal(phoneAPull.data.changes.photos.find(row => row.id === 'p2').is_current, 1);
assert.ok(phoneAPull.data.changes.activity_events.some(event => event.action === 'photo.made_current'));
const sameField = await api(env2, 'PATCH', '/api/spreads/s1', 'token-1', {
  client_ref: 'a:text', changes: { title: 'Другой текст' }, base_values: { title: beforePhoto.title },
});
assert.equal(sameField.status, 409, 'same-field conflict');
assert.equal(sameField.data.error, 'field_conflict');
assert.ok(sameField.data.conflicts.title);
const independent = await api(env2, 'PATCH', '/api/spreads/s1', 'token-1', {
  client_ref: 'a:status', changes: { status: 'Готово' }, base_values: { status: 'Актуально' },
});
assert.equal(independent.status, 200, 'different metadata fields merge');
assert.equal(independent.data.spread.title, 'Текст с телефона B');
const injectPhoto = await api(env2, 'PATCH', '/api/spreads/s1', 'token-1', { current_photo_id: null });
assert.equal(injectPhoto.status, 400);

const addSpread = (id, number) => db2.prepare(`INSERT INTO spreads
  (id,notebook_id,number,title,created_by,created_at,updated_at,revision,seq)
  VALUES(?,?,?,?,?,?,?,?,?)`).run(id, 'n1', number, id, 'u1', 'x', 'x', 1, 1);
addSpread('s2', 2);
const orderItems = ids => ids.map(id => {
  const row = db2.prepare('SELECT * FROM spreads WHERE id=?').get(id);
  return { spread_id: id, expected_revision: row.revision, expected_number: row.number };
});
const swap = await api(env2, 'PUT', '/api/notebooks/n1/spreads/order', 'token-2', {
  client_ref: 'swap-12', items: orderItems(['s2', 's1']),
});
assert.equal(swap.status, 200, 'reorder 1 ↔ 2');
assert.deepEqual(swap.data.spreads.map(row => [row.id, row.number]), [['s2', 1], ['s1', 2]]);
addSpread('s3', 3);
const savedOrder = orderItems(['s3', 's1', 's2']);
const reorder3 = await api(env2, 'PUT', '/api/notebooks/n1/spreads/order', 'token-1', {
  client_ref: 'reorder-3', items: savedOrder,
});
assert.equal(reorder3.status, 200, 'reorder 3 spreads');
assert.deepEqual(reorder3.data.spreads.map(row => row.id), ['s3', 's1', 's2']);
const staleOrder = await api(env2, 'PUT', '/api/notebooks/n1/spreads/order', 'token-1', {
  client_ref: 'reorder-stale', items: savedOrder,
});
assert.equal(staleOrder.status, 409, 'stale reorder');
const raceItems = orderItems(['s1', 's2', 's3']);
env2.DB.beforeBatch = () => db2.prepare('UPDATE spreads SET revision=revision+1 WHERE id=?').run('s2');
const racedOrder = await api(env2, 'PUT', '/api/notebooks/n1/spreads/order', 'token-1', {
  client_ref: 'reorder-race', items: raceItems,
});
assert.equal(racedOrder.status, 409, 'atomic reorder guard catches concurrent change');
assert.deepEqual(db2.prepare('SELECT number FROM spreads ORDER BY number').all().map(row => row.number), [1, 2, 3]);
const reorderedSeq = reorder3.data.spreads[0].seq;
const tiedSpreads = await api(env2, 'GET', `/api/sync?since=${reorderedSeq - 1}&limit=1`, 'token-2');
assert.equal(tiedSpreads.data.changes.spreads.length, 3, 'same-seq reorder rows all returned across limit');
const removed = await api(env2, 'DELETE', '/api/spreads/s1', 'token-1');
assert.equal(removed.status, 200);
assert.deepEqual(db2.prepare('SELECT number FROM spreads WHERE deleted_at IS NULL ORDER BY number').all().map(row => row.number), [1, 3], 'delete does not renumber');

const preflight = await worker.fetch(new Request('https://worker.test/api/favorites/s2', {
  method: 'OPTIONS', headers: { Origin: 'https://example.test', 'Access-Control-Request-Method': 'PUT' },
}), env2);
assert.ok(preflight.headers.get('Access-Control-Allow-Methods').split(',').includes('PUT'), 'CORS PUT preflight');
db2.prepare('UPDATE notebook_members SET revoked_at=? WHERE notebook_id=? AND user_id=?').run('x', 'n1', 'u2');
assert.equal((await api(env2, 'PUT', '/api/favorites/s2', 'token-2')).status, 403, 'favorite without membership forbidden');
assert.equal((await api(env2, 'PUT', '/api/favorites/missing', 'token-1')).status, 404);
assert.equal((await api(env2, 'PUT', '/api/favorites/s1', 'token-1')).status, 404, 'favorite deleted spread forbidden');
assert.equal((await api(env2, 'PUT', '/api/favorites/s2', 'token-1')).status, 200);

const snapshot = await api(env2, 'GET', '/api/notebooks/n1/snapshot', 'token-1');
assert.equal(snapshot.status, 200, 'v3.4.2 snapshot remains readable');
for (const key of ['notebook', 'spreads', 'photos', 'tags', 'spread_tags', 'favorites', 'members', 'cursor']) assert.ok(key in snapshot.data);
assert.equal(snapshot.data.spreads.find(row => row.id === 's1').note_full, 'legacy full');
assert.equal(snapshot.data.photos.length, 2, 'original photo rows remain');
const invite = await api(env2, 'POST', '/api/invites', 'token-1', { notebook_id: 'n1' });
assert.equal(invite.status, 200);
assert.equal((await api(env2, 'GET', '/api/invites?notebook_id=n1')).data.invites.length, 1);
assert.equal((await api(env2, 'GET', '/api/me')).status, 200);
assert.equal((await api(env2, 'GET', '/api/notebooks')).status, 200);
assert.equal((await api(env2, 'GET', '/api/notebooks', null)).status, 401);
assert.equal(db2.prepare('SELECT COUNT(*) AS c FROM users').get().c, 2, 'users not reset');
const nativeFetch = globalThis.fetch;
globalThis.fetch = async url => {
  assert.ok(String(url).startsWith('https://api.telegram.org/'), 'test must not contact external services');
  return Response.json({ ok: true, result: { message_id: 100, document: {
    file_id: 'fixture-file', file_unique_id: 'fixture-unique', file_size: 4, mime_type: 'image/jpeg',
  } } });
};
try {
  const form = new FormData();
  form.append('file', new Blob(['test'], { type: 'image/jpeg' }), 'test.jpg');
  form.append('client_upload_id', 'fixture-upload');
  const uploaded = await worker.fetch(new Request('https://worker.test/api/spreads/s2/photos', {
    method: 'POST', headers: { Authorization: 'Bearer token-1' }, body: form,
  }), { ...env2, CHAT_ID: 'fixture-chat', BOT_TOKEN: 'fixture-only' });
  assert.equal(uploaded.status, 200, 'existing photo upload SQL remains valid');
  const uploadedData = await uploaded.json();
  assert.equal(db2.prepare('SELECT current_photo_id FROM spreads WHERE id=?').get('s2').current_photo_id, uploadedData.photo_id);
  assert.ok(db2.prepare("SELECT id FROM activity_events WHERE action='photo.added'").get());
} finally { globalThis.fetch = nativeFetch; }
db2.prepare('INSERT INTO history VALUES(?,?,?,?,?,?,?)').run('legacy-event', 'n1', 'spread', 's2', 'u1', 'spread_created', '2026-01-01');
const legacyRead = await api(env2, 'GET', '/api/spreads/s2/activity');
assert.ok(legacyRead.data.legacy_events.some(event => event.id === 'legacy-event' && event.legacy && event.old_value === null));
assert.deepEqual(db2.prepare('PRAGMA foreign_key_check').all(), []);
const large = createFixture();
for (let i = 2; i <= 200; i++) large.sqlite.prepare(`INSERT INTO spreads
  (id,notebook_id,number,title,created_by,created_at,updated_at,revision,seq)
  VALUES(?,?,?,?,?,?,?,?,?)`).run('s'+i, 'n1', i, 'title '+i, 'u1', 'x', 'x', 1, 1);
const largeItems = large.sqlite.prepare('SELECT * FROM spreads ORDER BY number DESC').all().map(row =>
  ({spread_id:row.id, expected_revision:row.revision, expected_number:row.number}));
const largeOrder = await api(large.env, 'PUT', '/api/notebooks/n1/spreads/order', 'token-1', {client_ref:'large-order', items:largeItems});
assert.equal(largeOrder.status, 200, '200-spread reorder respects D1 parameter/query limits');
assert.equal(largeOrder.data.spreads[0].id, 's200');
assert.equal(largeOrder.data.spreads[199].id, 's1');
assert.equal((await api(large.env, 'GET', '/api/notebooks/n1/snapshot')).data.spreads.length,200,'large reordered notebook remains readable');
db2.prepare(`INSERT INTO activity_events
  (id,notebook_id,entity,entity_id,actor_user_id,action,created_at,seq,client_ref)
  VALUES(?,?,?,?,?,?,?,?,?)`).run('activity-tie-a','n1','spread','s2','u1','fixture','x',2000,'activity-tie-a');
db2.prepare(`INSERT INTO activity_events
  (id,notebook_id,entity,entity_id,actor_user_id,action,created_at,seq,client_ref)
  VALUES(?,?,?,?,?,?,?,?,?)`).run('activity-tie-b','n1','spread','s2','u1','fixture','x',2000,'activity-tie-b');
const activityTie = await api(env2, 'GET', '/api/notebooks/n1/activity?limit=1');
assert.equal(activityTie.data.events.length, 2, 'history pagination includes all seq ties');
assert.equal(activityTie.data.next_before_seq, 2000);
console.log('backend notes/activity/merge/reorder/photo/security compatibility tests passed (22 required scenarios + race checks)');
