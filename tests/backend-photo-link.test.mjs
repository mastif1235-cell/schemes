import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import worker from '../backend/worker.js';

function tokenHash(token) { return createHash('sha256').update(token).digest('hex'); }
function now() { return '2026-09-14T00:00:00.000Z'; }

class FakeStatement {
  constructor(db, sql, params = []) { this.db = db; this.sql = sql; this.params = params; }
  bind(...params) { return new FakeStatement(this.db, this.sql, params); }
  async all() { return {success:true, results:this.rows(), meta:{changes:0}}; }
  async first(column) { const row = this.rows()[0] || null; return column && row ? row[column] : row; }
  async run() { return this.runSync(); }
  runSync() {
    const sql = this.sql.replace(/\s+/g, ' ').trim();
    const p = this.params;
    if (/^WITH candidates/.test(sql)) return {success:true, results:this.rows(), meta:{changes:0}};
    if (/^INSERT INTO change_seq/.test(sql)) {
      this.db.seq += 1;
      return {success:true, results:[], meta:{changes:1, last_row_id:this.db.seq}};
    }
    if (/^UPDATE sessions SET last_used_at/.test(sql)) return {success:true, results:[], meta:{changes:1}};
    if (/^UPDATE photos SET is_current=0/.test(sql)) {
      const [seq, spreadId] = p;
      let changes = 0;
      for (const photo of this.db.photos) if (photo.spread_id === spreadId && photo.is_current) {
        photo.is_current = 0; photo.seq = seq; changes++;
      }
      return {success:true, results:[], meta:{changes}};
    }
    if (/^INSERT INTO photos/.test(sql)) {
      const [id, spread_id, version, storage_object_id, telegram_message_id, telegram_file_id,
        telegram_file_unique_id, mime_type, file_size, created_by, created_at, seq, client_upload_id] = p;
      this.db.photos.push({id, spread_id, version, is_current:1, provider:'telegram', storage_object_id,
        telegram_message_id, telegram_file_id, telegram_file_unique_id, mime_type, file_size,
        created_by, created_at, seq, client_upload_id});
      return {success:true, results:[], meta:{changes:1}};
    }
    if (/^UPDATE spreads SET current_photo_id=/.test(sql)) {
      const [photoId, updatedAt, updatedBy, seq, id] = p;
      const spread = this.db.spreads.find(row => row.id === id);
      if (spread) { spread.current_photo_id = photoId; spread.updated_at = updatedAt; spread.updated_by = updatedBy; spread.revision += 1; spread.seq = seq; }
      return {success:true, results:[], meta:{changes:spread ? 1 : 0}};
    }
    if (/^INSERT INTO activity_events/.test(sql)) return {success:true, results:[], meta:{changes:1}};
    if (/^INSERT INTO uploads/.test(sql)) {
      const [client_upload_id, photo_id, result_json, created_at] = p;
      if (this.db.uploads.some(row => row.client_upload_id === client_upload_id)) {
        throw new Error('UNIQUE constraint failed: uploads.client_upload_id');
      }
      this.db.uploads.push({client_upload_id, photo_id, result_json, created_at});
      return {success:true, results:[], meta:{changes:1}};
    }
    if (/^UPDATE uploads SET photo_id=\?, result_json=\? WHERE client_upload_id=\? AND result_json=\?/.test(sql)) {
      const [photo_id, nextJson, client_upload_id, expectedJson] = p;
      const row = this.db.uploads.find(row => row.client_upload_id === client_upload_id);
      if (!row || row.result_json !== expectedJson) return {success:true, results:[], meta:{changes:0}};
      row.photo_id = photo_id ?? row.photo_id; row.result_json = nextJson;
      return {success:true, results:[], meta:{changes:1}};
    }
    if (/^UPDATE uploads SET photo_id=\?, result_json=\? WHERE client_upload_id=\?/.test(sql)) {
      const [photo_id, nextJson, client_upload_id] = p;
      const row = this.db.uploads.find(row => row.client_upload_id === client_upload_id);
      if (!row) return {success:true, results:[], meta:{changes:0}};
      row.photo_id = photo_id ?? row.photo_id; row.result_json = nextJson;
      return {success:true, results:[], meta:{changes:1}};
    }
    return {success:true, results:[], meta:{changes:0}};
  }
  rows() {
    const sql = this.sql.replace(/\s+/g, ' ').trim();
    const p = this.params;
    if (/FROM sessions s JOIN users u/.test(sql)) {
      const session = this.db.sessions.find(row => row.token_hash === p[0] && !row.revoked_at);
      if (!session) return [];
      const user = this.db.users.find(row => row.id === session.user_id);
      return [{session_id:session.id, user_id:session.user_id, expires_at:session.expires_at,
        revoked_at:session.revoked_at || null, display_name:user.display_name}];
    }
    if (/SELECT role FROM notebook_members/.test(sql)) {
      const row = this.db.members.find(m => m.notebook_id === p[0] && m.user_id === p[1] && !m.revoked_at);
      return row ? [{role:row.role}] : [];
    }
    if (/SELECT id FROM notebooks WHERE id=\? AND owner_id=\?/.test(sql)) {
      return this.db.notebooks.filter(row => row.id === p[0] && row.owner_id === p[1]).map(row => ({id:row.id}));
    }
    if (/SELECT \* FROM notebooks WHERE id=\?/.test(sql)) return this.db.notebooks.filter(row => row.id === p[0]).map(row => ({...row}));
    if (/SELECT \* FROM spreads WHERE id=\?/.test(sql)) return this.db.spreads.filter(row => row.id === p[0]).map(row => ({...row}));
    if (/SELECT notebook_id FROM spreads WHERE id=\?/.test(sql)) return this.db.spreads.filter(row => row.id === p[0]).map(row => ({notebook_id:row.notebook_id}));
    if (/SELECT revision FROM spreads WHERE id=\?/.test(sql)) return this.db.spreads.filter(row => row.id === p[0]).map(row => ({revision:row.revision}));
    if (/SELECT \* FROM spreads WHERE notebook_id=\?/.test(sql)) return this.db.spreads.filter(row => row.notebook_id === p[0]).map(row => ({...row}));
    if (/SELECT \* FROM photos WHERE id=\?/.test(sql)) return this.db.photos.filter(row => row.id === p[0]).map(row => ({...row}));
    if (/SELECT \* FROM photos WHERE spread_id IN/.test(sql) && !/^WITH candidates/.test(sql)) {
      const notebookId = p[0];
      const spreadIds = new Set(this.db.spreads.filter(row => row.notebook_id === notebookId).map(row => row.id));
      return this.db.photos.filter(row => spreadIds.has(row.spread_id)).map(row => ({...row}));
    }
    if (/SELECT MAX\(version\) as v FROM photos WHERE spread_id=\?/.test(sql)) {
      const versions = this.db.photos.filter(row => row.spread_id === p[0]).map(row => row.version || 0);
      return [{v:versions.length ? Math.max(...versions) : null}];
    }
    if (/SELECT \* FROM uploads WHERE client_upload_id=\?/.test(sql)) return this.db.uploads.filter(row => row.client_upload_id === p[0]).map(row => ({...row}));
    if (/SELECT result_json FROM uploads WHERE client_upload_id=\?/.test(sql)) return this.db.uploads.filter(row => row.client_upload_id === p[0]).map(row => ({result_json:row.result_json}));
    if (/SELECT client_upload_id, result_json FROM uploads WHERE client_upload_id IN/.test(sql)) {
      return this.db.uploads.filter(row => p.includes(row.client_upload_id))
        .map(row => ({client_upload_id:row.client_upload_id, result_json:row.result_json}));
    }
    if (/SELECT \* FROM photos WHERE client_upload_id=\?/.test(sql)) return this.db.photos.filter(row => row.client_upload_id === p[0]).map(row => ({...row}));
    if (/SELECT name FROM sqlite_master/.test(sql)) return [];
    if (/SELECT MAX\(seq\) as m FROM change_seq/.test(sql)) return [{m:this.db.seq}];
    if (/SELECT \* FROM spread_tags/.test(sql)) return [];
    if (/SELECT \* FROM user_favorites/.test(sql)) return [];
    if (/SELECT \* FROM tags/.test(sql)) return [];
    if (/SELECT \* FROM notebook_members/.test(sql)) return this.db.members.filter(row => row.notebook_id === p[0]).map(row => ({...row}));
    if (/FROM spread_notes sn WHERE notebook_id=\?/.test(sql)) return [];
    if (/SELECT notebook_id FROM notebook_members WHERE user_id=\?/.test(sql)) {
      const ids = new Set(this.db.members.filter(row => row.user_id === p[0] && !row.revoked_at).map(row => row.notebook_id));
      for (const nb of this.db.notebooks) if (nb.owner_id === p[1] && !nb.deleted_at) ids.add(nb.id);
      return [...ids].map(notebook_id => ({notebook_id}));
    }
    if (/^WITH candidates/.test(sql)) return this.syncRows(sql, p);
    return [];
  }
  syncRows(sql, p) {
    const since = p[p.length - 2];
    const notebookIds = p.slice(0, p.length - 2);
    const spreadIds = new Set(this.db.spreads.filter(row => notebookIds.includes(row.notebook_id)).map(row => row.id));
    let rows = [];
    if (/FROM photos WHERE/.test(sql)) rows = this.db.photos.filter(row => spreadIds.has(row.spread_id));
    else if (/FROM notebooks WHERE/.test(sql)) rows = this.db.notebooks.filter(row => notebookIds.includes(row.id));
    else if (/FROM spreads WHERE/.test(sql)) rows = this.db.spreads.filter(row => notebookIds.includes(row.notebook_id));
    else rows = [];
    return rows.filter(row => Number(row.seq || 0) > since).sort((a,b) => Number(a.seq || 0) - Number(b.seq || 0)).map(row => ({...row}));
  }
}

class FakeD1 {
  constructor(db) { this.db = db; }
  prepare(sql) { return new FakeStatement(this.db, sql); }
  async batch(statements) { return statements.map(statement => statement.runSync()); }
}

function createEnv() {
  const db = {
    seq: 10,
    users:[{id:'u1', display_name:'Owner'}],
    sessions:[{id:'session-1', user_id:'u1', token_hash:tokenHash('token-1'), expires_at:'2099-01-01T00:00:00.000Z'}],
    notebooks:[{id:'n1', owner_id:'u1', created_by:'u1', title:'Notebook', description:null, archived:0, sort_order:0,
      created_at:now(), updated_at:now(), revision:1, seq:1, deleted_at:null}],
    members:[{notebook_id:'n1', user_id:'u1', role:'OWNER', added_at:now(), updated_at:now(), seq:1, revoked_at:null}],
    spreads:[{id:'s1', notebook_id:'n1', number:1, title:'Spread', note_short:'short', note_full:'full', status:'Актуально',
      current_photo_id:'p-old', searchableText:'spread', created_by:'u1', created_at:now(), updated_by:'u1', updated_at:now(),
      revision:1, seq:2, deleted_at:null}],
    photos:[{id:'p-old', spread_id:'s1', version:1, is_current:1, provider:'telegram', storage_object_id:'storage-old',
      telegram_message_id:'321', telegram_file_id:'file-old', telegram_file_unique_id:'unique-old', mime_type:'image/jpeg',
      file_size:1234, created_by:'u1', created_at:now(), seq:3, client_upload_id:'old-upload'},
    // Legacy row: no telegram_message_id at all — only storage_object_id with the encoded pair.
    {id:'p-legacy', spread_id:'s1', version:2, is_current:0, provider:'telegram',
      storage_object_id:Buffer.from('-100555777:300', 'utf8').toString('base64'),
      telegram_message_id:null, telegram_file_id:'file-legacy', telegram_file_unique_id:'unique-legacy',
      mime_type:'image/jpeg', file_size:2222, created_by:'u1', created_at:now(), seq:4, client_upload_id:'legacy-upload'}],
    uploads:[],
  };
  return {DB:new FakeD1(db), CHAT_ID:'-100555777', BOT_TOKEN:'test-token', __db:db};
}

async function api(env, method, path, body) {
  const response = await worker.fetch(new Request(`https://worker.test${path}`, {
    method,
    headers:{Authorization:'Bearer token-1'},
    body,
  }), env, {waitUntil() {}});
  return {status:response.status, data:await response.json()};
}

const env = createEnv();
const snapshot = await api(env, 'GET', '/api/notebooks/n1/snapshot');
assert.equal(snapshot.status, 200);
assert.equal(snapshot.data.photos.find(row => row.id === 'p-old').telegram_link, 'https://t.me/c/555777/321',
  'snapshot computes Telegram links for old photo rows without a telegram_link column');
const sync = await api(env, 'GET', '/api/sync?since=0');
assert.equal(sync.status, 200);
assert.equal(sync.data.changes.photos.find(row => row.id === 'p-old').telegram_link, 'https://t.me/c/555777/321',
  'sync computes Telegram links for photo changes');
assert.ok(!Object.hasOwn(env.__db.photos[0], 'telegram_link'), 'test fixture mimics D1 photos without a stored telegram_link column');
assert.equal(snapshot.data.photos.find(row => row.id === 'p-legacy').telegram_link, 'https://t.me/c/555777/300',
  'legacy row without telegram_message_id gets its link derived from storage_object_id');
assert.equal(sync.data.changes.photos.find(row => row.id === 'p-legacy').telegram_link, 'https://t.me/c/555777/300',
  'sync delivers the derived legacy link to every device');
{
  // garbage storage_object_id must not crash publicPhoto nor invent links
  env.__db.photos.push({id:'p-broken', spread_id:'s1', version:3, is_current:0, storage_object_id:'storage-old',
    telegram_message_id:null, telegram_file_id:'x', telegram_file_unique_id:'x', mime_type:'image/jpeg',
    file_size:1, created_by:'u1', created_at:now(), seq:5, client_upload_id:'broken-upload'});
  const brokenSnap = await api(env, 'GET', '/api/notebooks/n1/snapshot');
  assert.equal(brokenSnap.status, 200, 'broken storage_object_id row stays readable');
  assert.equal(brokenSnap.data.photos.find(row => row.id === 'p-broken').telegram_link, null,
    'broken storage_object_id never invents a link');
}

const nativeFetch = globalThis.fetch;
globalThis.fetch = async url => {
  assert.ok(String(url).startsWith('https://api.telegram.org/'), 'test must not call non-Telegram external services');
  return Response.json({ok:true, result:{message_id:444, document:{file_id:'fresh-file', file_unique_id:'fresh-unique',
    file_size:4, mime_type:'image/jpeg'}}});
};
try {
  const form = new FormData();
  form.append('file', new Blob(['test'], {type:'image/jpeg'}), 'test.jpg');
  form.append('client_upload_id', 'fresh-upload');
  const upload = await api(env, 'POST', '/api/spreads/s1/photos', form);
  assert.equal(upload.status, 200);
  assert.equal(upload.data.message_id, 444);
  assert.equal(upload.data.telegram_link, 'https://t.me/c/555777/444', 'fresh upload response includes computed Telegram link');
  assert.equal(upload.data.photo.telegram_link, upload.data.telegram_link);
  const stored = env.__db.photos.find(row => row.id === upload.data.photo_id);
  assert.ok(stored && !Object.hasOwn(stored, 'telegram_link'), 'computed link is not stored as a D1 photo column');
} finally { globalThis.fetch = nativeFetch; }

// ---- dual storage: 1 document (original) + 1 photo (preview) per new upload ----
const dualMocks = {docMessage: 600, photoMessage: 910};
const originalBytes = new TextEncoder().encode('ORIGINAL-IMAGE-BYTES-SHA');
function dualFetch(calls, {previewFails = false} = {}) {
  return async url => {
    const target = String(url);
    calls.push(target);
    if (target.includes('/sendPhoto')) {
      if (previewFails) {
        return Response.json({ok:false, error_code:400, description:'PHOTO_INVALID_DIMENSIONS'}, {status:400});
      }
      return Response.json({ok:true, result:{message_id:dualMocks.photoMessage, photo:[
        {file_id:'view-small', file_unique_id:'uv-small', width:90, height:67, file_size:100},
        {file_id:'view-file', file_unique_id:'uv-big', width:1280, height:960, file_size:5000}]}});
    }
    if (target.includes('/getFile')) {
      assert.ok(target.includes('file_id=doc-file'), 'restore must ask Telegram for the DOCUMENT file_id');
      return Response.json({ok:true, result:{file_path:'docs/original.jpg'}});
    }
    if (target.includes('/file/bot')) return new Response(originalBytes);
    return Response.json({ok:true, result:{message_id:dualMocks.docMessage++,
      document:{file_id:'doc-file', file_unique_id:'doc-unique', file_size:originalBytes.length,
        mime_type:'image/jpeg'}}});
  };
}
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

{ // DUAL-1: fresh upload with photo_preview=1 → document first, preview second, both recorded.
  const calls = [];
  globalThis.fetch = dualFetch(calls);
  try {
    dualMocks.docMessage = 600; dualMocks.photoMessage = 910;
    const form = new FormData();
    form.append('file', new Blob([originalBytes], {type:'image/jpeg'}), 'scan.jpg');
    form.append('client_upload_id', 'dual-1');
    form.append('photo_preview', '1');
    const uploaded = await api(env, 'POST', '/api/spreads/s1/photos', form);
    assert.equal(uploaded.status, 200);
    assert.equal(uploaded.data.message_id, 600, 'canonical id belongs to the DOCUMENT message');
    assert.equal(uploaded.data.file_id, 'doc-file', 'stored file_id is the document, not a PhotoSize');
    assert.equal(uploaded.data.preview_message_id, 910, 'preview message id is tracked separately');
    assert.equal(uploaded.data.preview_file_id, 'view-file', 'preview keeps the largest PhotoSize id');
    assert.equal(uploaded.data.telegram_link, 'https://t.me/c/555777/600');
    assert.equal(uploaded.data.telegram_preview_link, 'https://t.me/c/555777/910',
      'the button opens the preview (sendPhoto) message');
    assert.equal(uploaded.data.preview_pending, false);
    assert.equal(uploaded.data.telegram_method, 'document+photo');
    const docIndex = calls.findIndex(u => u.includes('/sendDocument'));
    const photoIndex = calls.findIndex(u => u.includes('/sendPhoto'));
    assert.ok(docIndex >= 0 && photoIndex > docIndex, 'document is sent BEFORE the preview');
    assert.equal(calls.filter(u => u.includes('/sendDocument')).length, 1, 'exactly 1 document');
    assert.equal(calls.filter(u => u.includes('/sendPhoto')).length, 1, 'exactly 1 preview');
    const stored = env.__db.photos.find(row => row.id === uploaded.data.photo_id);
    assert.equal(stored.telegram_message_id, 600, 'photos row stores the document identifiers');
    assert.equal(stored.telegram_file_id, 'doc-file');
    assert.ok(stored.telegram_file_id !== stored.preview_file_id, 'document/preview ids never mix');
    const ledger = env.__db.uploads.find(row => row.client_upload_id === 'dual-1');
    const parsed = JSON.parse(ledger.result_json);
    assert.equal(parsed.extras.doc.message_id, 600, 'ledger holds the document descriptors');
    assert.equal(parsed.extras.preview.message_id, 910, 'ledger holds the preview descriptors');

    // DUAL-2: restore goes through the document file_id and returns byte-identical original.
    const fileResp = await worker.fetch(new Request(`https://worker.test/api/photos/${uploaded.data.photo_id}/file`,
      {headers:{Authorization:'Bearer token-1'}}), env, {waitUntil() {}});
    assert.equal(fileResp.status, 200);
    const restored = new Uint8Array(await fileResp.arrayBuffer());
    assert.equal(sha256(restored), sha256(originalBytes),
      'SHA256(original before upload) == SHA256(after restore from document)');
    assert.ok(!calls.some(u => u.includes('file_id=view-file')), 'preview NEVER used for restore');

    // DUAL-3 (idempotency A): lost response + full retry → still exactly 1+1 in Telegram.
    const retry = await api(env, 'POST', '/api/spreads/s1/photos', form);
    assert.equal(retry.status, 200);
    assert.equal(retry.data.photo_id, uploaded.data.photo_id, 'retry replays the same photo row');
    assert.equal(retry.data.preview_message_id, 910);
    assert.equal(calls.filter(u => u.includes('/sendDocument')).length, 1,
      'lost-response retry never re-sends the document');
    assert.equal(calls.filter(u => u.includes('/sendPhoto')).length, 1,
      'lost-response retry never re-sends the preview');
  } finally { globalThis.fetch = nativeFetch; }
}

{ // DUAL-4 (idempotency B): preview fail → photo still saved; retry adds ONLY the preview.
  const calls = [];
  globalThis.fetch = dualFetch(calls, {previewFails: true});
  try {
    const form = new FormData();
    form.append('file', new Blob([originalBytes], {type:'image/jpeg'}), 'scan.jpg');
    form.append('client_upload_id', 'dual-4');
    form.append('photo_preview', '1');
    const uploaded = await api(env, 'POST', '/api/spreads/s1/photos', form);
    assert.equal(uploaded.status, 200, 'preview failure does not fail the saved original');
    assert.equal(uploaded.data.telegram_method, 'document', 'only the document exists so far');
    assert.equal(uploaded.data.preview_pending, true, 'preview carries a retry-able pending state');
    assert.equal(uploaded.data.preview_message_id, null);
    assert.ok(uploaded.data.telegram_link, 'document link still present');

    globalThis.fetch = dualFetch(calls, {previewFails: false});
    const retry = await api(env, 'POST', '/api/spreads/s1/photos', form);
    assert.equal(retry.status, 200);
    assert.equal(retry.data.photo_id, uploaded.data.photo_id);
    assert.equal(retry.data.preview_message_id, dualMocks.photoMessage, 'retry completed the preview');
    assert.equal(retry.data.preview_pending, false);
    assert.equal(retry.data.telegram_preview_link, `https://t.me/c/555777/${dualMocks.photoMessage}`);
    assert.equal(calls.filter(u => u.includes('/sendDocument')).length, 1,
      'the document was never re-sent');
    assert.equal(calls.filter(u => u.includes('/sendPhoto')).length, 2,
      'sendPhoto attempted once per failure + once for the retry (single successful preview)');
    const parsed = JSON.parse(env.__db.uploads.find(row => row.client_upload_id === 'dual-4').result_json);
    assert.equal(parsed.extras.preview.message_id, dualMocks.photoMessage, 'ledger converged on the live preview');
  } finally { globalThis.fetch = nativeFetch; }
}

{ // DUAL-5 (idempotency C): crash after sendDocument, before preview+insert → resume adopt doc.
  const calls = [];
  globalThis.fetch = dualFetch(calls);
  try {
    env.__db.uploads.push({client_upload_id:'dual-5', photo_id:null, created_at:now(),
      result_json: JSON.stringify({response:null, extras:{doc:{message_id:720, chat_id:'-100555777',
        file_id:'doc-file', file_unique_id:'u-c', mime_type:'image/jpeg', file_size:5}, preview:null}})});
    dualMocks.photoMessage = 703;
    const form = new FormData();
    form.append('file', new Blob([originalBytes], {type:'image/jpeg'}), 'scan.jpg');
    form.append('client_upload_id', 'dual-5');
    form.append('photo_preview', '1');
    const resumed = await api(env, 'POST', '/api/spreads/s1/photos', form);
    assert.equal(resumed.status, 200);
    assert.equal(calls.filter(u => u.includes('/sendDocument')).length, 0,
      'resume recognized the existing original and skipped sendDocument');
    assert.equal(calls.filter(u => u.includes('/sendPhoto')).length, 1, 'resume created only the missing preview');
    const stored = env.__db.photos.find(row => row.client_upload_id === 'dual-5');
    assert.equal(stored.telegram_message_id, 720, 'photo row adopted the survived document');
    assert.equal(resumed.data.telegram_link, 'https://t.me/c/555777/720');
    assert.equal(resumed.data.preview_message_id, 703);
    assert.equal(resumed.data.telegram_method, 'document+photo');
  } finally { globalThis.fetch = nativeFetch; }
}

{ // DUAL-6 (idempotency D): near-parallel duplicates → exactly 1 logical record, 1 doc + 1 preview.
  const calls = [];
  globalThis.fetch = dualFetch(calls);
  try {
    dualMocks.photoMessage = 930;
    const formA = new FormData();
    formA.append('file', new Blob([originalBytes], {type:'image/jpeg'}), 'scan.jpg');
    formA.append('client_upload_id', 'dual-6');
    formA.append('photo_preview', '1');
    const formB = new FormData();
    formB.append('file', new Blob([originalBytes], {type:'image/jpeg'}), 'scan.jpg');
    formB.append('client_upload_id', 'dual-6');
    formB.append('photo_preview', '1');
    const first = api(env, 'POST', '/api/spreads/s1/photos', formA);
    await new Promise(resolve => setTimeout(resolve, 20)); // let A write its ledger row
    const second = api(env, 'POST', '/api/spreads/s1/photos', formB);
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.status, 200); assert.equal(b.status, 200);
    assert.equal(a.data.photo_id, b.data.photo_id, 'one logical photo record for both requests');
    assert.equal(env.__db.photos.filter(row => row.client_upload_id === 'dual-6').length, 1,
      'exactly one photos row');
    assert.equal(calls.filter(u => u.includes('/sendDocument')).length, 1, 'exactly one document');
    assert.equal(calls.filter(u => u.includes('/sendPhoto')).length, 1, 'exactly one preview');
  } finally { globalThis.fetch = nativeFetch; }
}

{ // mime guard: preview requested for a non-photo mime → document only (Telegram would reject).
  const calls = [];
  globalThis.fetch = dualFetch(calls);
  try {
    const form = new FormData();
    form.append('file', new Blob(['gif'], {type:'image/gif'}), 'anim.gif');
    form.append('client_upload_id', 'dual-gif');
    form.append('photo_preview', '1');
    const uploaded = await api(env, 'POST', '/api/spreads/s1/photos', form);
    assert.equal(uploaded.data.telegram_method, 'document', 'gif skips the preview pre-check');
    assert.equal(uploaded.data.preview_pending, false, 'no spurious pending state when pre-check skips');
    assert.equal(calls.filter(u => u.includes('/sendPhoto')).length, 0, 'no sendPhoto attempt for gif');
    assert.equal(calls.filter(u => u.includes('/sendDocument')).length, 1);
  } finally { globalThis.fetch = nativeFetch; }
}

// H: every generation stays visible after sync — the second phone receives BOTH ids.
globalThis.fetch = dualFetch([]); // sync itself must not call Telegram
try {
  const afterAll = await api(env, 'GET', '/api/sync?since=0');
  for (const id of ['p-old', 'p-legacy']) {
    assert.ok(afterAll.data.changes.photos.find(row => row.id === id).telegram_link?.startsWith('https://t.me/c/555777/'),
      `photo ${id} keeps a usable link after all changes`);
  }
  const dualRow = afterAll.data.changes.photos.find(row => row.client_upload_id === 'dual-1');
  assert.equal(dualRow.telegram_preview_link, 'https://t.me/c/555777/910',
    'second phone receives the preview link through incremental sync');
  assert.equal(dualRow.preview_message_id, 910);
  const snapshotAll = await api(env, 'GET', '/api/notebooks/n1/snapshot');
  const dualSnapshotRow = snapshotAll.data.photos.find(row => row.client_upload_id === 'dual-1');
  assert.equal(dualSnapshotRow.telegram_preview_link, 'https://t.me/c/555777/910',
    'second phone receives the preview link through the notebook snapshot');
  const singlePhoto = await api(env, 'GET', `/api/photos/${dualRow.id}`);
  assert.equal(singlePhoto.data.photo.telegram_preview_link, 'https://t.me/c/555777/910',
    'single-photo endpoint also exposes the preview reference');
} finally { globalThis.fetch = nativeFetch; }
console.log('backend-photo-link: PASS');
