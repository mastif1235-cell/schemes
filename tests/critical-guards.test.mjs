// Stage 3 CRITICAL guards: legacy runtime removal, cover picker isolation, photo target
// validation, single release version, and photo-control leak regression.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const manifest = JSON.parse(read('app-v3-manifest.json'));
const release = JSON.parse(read('version.json')).version;
const runtimeFiles = manifest.files.filter(entry => !entry.path.startsWith('chunk')).map(entry => entry.path);
const index = read('index.html');
const sw = read('sw.js');

// --- CRITICAL 1: the legacy runtime is gone and nothing re-adds its global hooks -------------
assert.ok(!manifest.files.some(entry => entry.path === 'v3-enhancements.txt'), 'legacy payload must not be in the runtime manifest');
assert.ok(!sw.includes('v3-enhancements'), 'legacy payload must not be precached');
assert.ok(!index.includes('v3-enhancements'), 'legacy payload must not be fetched by index.html');
assert.ok(fs.existsSync(path.join(root, 'legacy/v3-enhancements.js')), 'legacy source must be kept, not deleted');
assert.ok(!fs.existsSync(path.join(root, 'v3-loader.js')), 'the unused legacy loader must not stay in the published root');
assert.ok(fs.existsSync(path.join(root, 'legacy/v3-loader.js')), 'the unused legacy loader is archived, not deleted');

for (const file of [...runtimeFiles, 'index.html', 'sw.js']) {
  const source = read(file);
  assert.doesNotMatch(source, /^\s*(URL\.(?:create|revoke)ObjectURL)\s*=/m, `${file} must not monkey-patch URL helpers`);
  assert.doesNotMatch(source, /^\s*get\s*=\s*(?:async\s*)?function/m, `${file} must not override the IndexedDB get helper`);
  assert.doesNotMatch(source, /document\.addEventListener\('click'[\s\S]{0,220}type\s*!==\s*'file'/, `${file} must not intercept image file inputs`);
}
const legacy = read('legacy/v3-enhancements.js');
assert.match(legacy, /v3BlobKeyByUrl/, 'legacy reference file is expected to keep the removed patch');

// --- CRITICAL 4: cover picker is explicit, identity-bound, and IndexedDB-tombstoned ---------
const core = read('v3-core.js');
assert.match(core, /input\.dataset\.v3InternalPicker = '1'/);
assert.match(core, /COVER_PREFIX \+ notebook\.id/);
assert.doesNotMatch(core, /get\('blobs', notebook\.cover_photo_id \+ '_thumb'\)[\s\S]{0,200}return URL\.createObjectURL/, 'cover rendering must not fall back to legacy cover_photo_id');
assert.match(core, /localStorage\.getItem\(COVER_REMOVED_PREFIX \+ notebook\.id\)/, 'legacy localStorage tombstone must be migrated');
assert.match(core, /await setCoverRemoved\(notebook\.id, true\)/);
const camera = read('v3-camera.js');
assert.match(camera, /input\.dataset\.v3InternalPicker = '1'/, 'capture inputs are explicitly flagged');
assert.doesNotMatch(core, /localStorage\.setItem\(COVER_REMOVED_PREFIX/, 'IndexedDB is the tombstone source of truth');

// --- CRITICAL 2: photo target guard (behavioural) -------------------------------------------
const sandbox = {
  console:{...console, warn(){}, error(){}},
  localStorage:{store:new Map(), getItem(key){return this.store.has(key) ? this.store.get(key) : null;},
    setItem(key, value){this.store.set(key, String(value));}, removeItem(key){this.store.delete(key);}},
  openDB:async () => ({}), openNotebookEditor:() => {}, openNotebookEditorV2:null,
  get:async () => null, put:async () => {}, del:async () => {}, getAll:async () => [], getAllByIndex:async () => [],
  nowISO:() => new Date().toISOString(), toast:() => {}, render:() => {}, isAuthed:() => false,
  queueEntityChange:async () => {}, uid:() => 'generated', indexedDB:{}, db:null
};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(read('v3-core.js'), sandbox, {filename:'v3-core.js'});
const validate = sandbox.v340ValidatePhotoTarget;
assert.equal(typeof validate, 'function');
assert.equal(validate({id:'s1', notebook_id:'nb1'}, {notebookId:'nb1', spreadId:null}), null);
assert.match(validate({id:'s1', notebook_id:'nb1'}, {notebookId:'nb1', spreadId:'s9'}), /Разворот изменился/);
assert.match(validate({id:'s1', notebook_id:'nb1'}, {notebookId:'nb2', spreadId:'s1'}), /другому блокноту/);
assert.match(validate({id:'s1', notebook_id:'nb1', deleted_at:'2026-09-12'}, {notebookId:'nb1', spreadId:'s1'}), /удалён/);
assert.match(validate({id:'s1', notebook_id:'nb1'}, null), /целевой блокнот/);
const setTarget = sandbox.BlocknotV3.photoTarget.set({notebookId:'nb1'});
assert.equal(setTarget.notebookId, 'nb1');
assert.equal(setTarget.spreadId, null);
assert.ok(setTarget.startedAt > 0);
assert.equal(sandbox.BlocknotV3.photoTarget.current().notebookId, 'nb1');
assert.equal(sandbox.BlocknotV3.photoTarget.current().spreadId, null);
sandbox.BlocknotV3.photoTarget.clear();
assert.equal(sandbox.BlocknotV3.photoTarget.current().notebookId, null);
const photos = read('v3-photos.js');
assert.match(photos, /window\.v340ValidatePhotoTarget\(latest, target\)/, 'the guard must re-run on the value read inside the write transaction');
assert.match(photos, /const UNSYNCED_QUEUE = new Set\(\['pending','syncing','failed','conflict'\]\)/);
assert.match(camera, /window\.BlocknotV3\.photoTarget\.set\(\{notebookId:targetNotebookId, spreadId:null\}\)/);

// --- CRITICAL 3: spread delete stays queued and is not overwritten by a snapshot ------------
const sync = read('v3-sync.js');
assert.match(sync, /item\.payload\.op === 'delete'/, 'a queued spread delete must reach the server');
assert.match(sync, /api\(`\/api\/spreads\/\$\{sp\.server_id\}`, \{method:'DELETE'\}\)/, 'delete uses the existing DELETE route');
assert.match(sync, /queueHasUnsynced\(queue, 'spread', localSp\.id\)/, 'snapshot must keep a local unsynced spread change');
assert.match(photos, /payload:\{op:'delete'\}/, 'local delete writes an unsynced spread change');

// --- CRITICAL 5: photo controls cannot leak outside the viewer/cards ------------------------
for (const file of runtimeFiles) {
  const source = read(file);
  assert.doesNotMatch(source, /Удалить фото|Скачать фото/, `${file} must not add standalone photo actions`);
  assert.doesNotMatch(source, /new MutationObserver/, `${file} must stay event-driven`);
}
assert.match(read('v3-ui.js'), /badge\.className = 'v340-photo-state'/, 'status badge lives on the spread card only');
assert.match(photos, /v340-viewer-state/, 'viewer status lives inside the viewer');

// --- CRITICAL 6: one release version -------------------------------------------------------
assert.equal(manifest.version, release);
assert.equal(read('version.js').includes(JSON.stringify(release)), true);
assert.match(sw, /const RELEASE = String\(self\.__BLOCKNOT_VERSION__/);
assert.match(read('v3-ui.js'), /window\.__BLOCKNOT_APP_VERSION__/);
assert.match(index, /window\.__BLOCKNOT_APP_VERSION__ = /);
for (const file of runtimeFiles) {
  assert.doesNotMatch(read(file), /['"]3\.4\.2['"]/, `${file} must not hardcode the release version`);
}

// --- CRITICAL 7: every runtime asset belongs to the same release ---------------------------
for (const entry of manifest.files) {
  const content = read(entry.path).replace(/\r\n?/g, '\n');
  assert.equal(crypto.createHash('sha256').update(content).digest('hex'), entry.sha256, `${entry.path} hash mismatch`);
  assert.ok(sw.includes(`'./${entry.path}'`), `${entry.path} must be precached`);
}
for (const asset of ['./version.json', './version.js']) assert.ok(sw.includes(asset), `${asset} must be precached`);
assert.match(sw, /c\.addAll\(SHELL\)/, 'install keeps the atomic addAll shell');
assert.doesNotMatch(index, /unregister|getRegistrations|location\.replace/);
assert.match(index, /blocknot_release_reload_once/, 'automatic reload is limited to one per session');

// --- CROSS-DEVICE COVER + SHARED HISTORY/UNREAD (stage 4A/4B) -------------------------------
const worker = read('backend/worker.js');
for (const route of [
  "on('GET', '/api/notebooks/:id/cover'",
  "on('PUT', '/api/notebooks/:id/cover'",
  "on('DELETE', '/api/notebooks/:id/cover'",
  "on('GET', '/api/notebooks/:id/cover/file'",
  "on('GET', '/api/notebooks/:id/cover/preview'",
  "on('PUT', '/api/notebooks/:id/activity/seen'",
]) {
  assert.ok(worker.includes(route), `worker must expose ${route}`);
}
assert.match(worker, /name: 'notebook_covers'/);
assert.match(worker, /unread\.notebooks\[row\.notebook_id\]/);
assert.match(worker, /hasCoverSchema/, 'new tables must degrade safely before the migration is applied');
assert.doesNotMatch(worker, /SELECT \* FROM notebook_covers WHERE notebook_id IN \(\$\{ph\}\)/, 'sync must not ship preview base64');
const migration2 = read('backend/migrations/0002_notebook_covers_activity_seen.sql');
assert.match(migration2, /CREATE TABLE notebook_covers/);
assert.match(migration2, /CREATE TABLE activity_seen/);
assert.doesNotMatch(migration2, /DROP\s|ALTER TABLE|DELETE FROM/i, 'migration must stay additive');

assert.match(sync, /pushNotebookCover/);
assert.match(sync, /item\.entity === 'notebook_cover'/);
assert.match(sync, /changes\.notebook_covers/);
assert.match(sync, /settings\.unread_by_notebook/);
assert.match(sync, /pullChanges = async function/);
assert.match(core, /v340ApplyServerCover/);
assert.match(core, /queueCoverChange/);
assert.match(core, /cover_state_known/);
assert.match(core, /enabled\('notebook_cover'\)/);
const history = read('v3-history.js');
assert.match(history, /enabled\('activity_seen'\)/);
assert.match(history, /markNotebookSeen/);
assert.match(history, /activity\/seen/);
assert.match(history, /unread-change/);
assert.match(history, /serverUnreadCount/);
// BUG 3: newest first everywhere (seq DESC, created_at/id fallback) and a re-render when a cover arrives.
assert.match(history, /\(Number\(b\.seq\)\|\|0\)-\(Number\(a\.seq\)\|\|0\)/);
assert.match(history, /eventTime\(b\) - eventTime\(a\)/);
assert.match(read('v3-photos.js'), /\(Number\(b\.seq\)\|\|0\)-\(Number\(a\.seq\)\|\|0\)[\s\S]{0,120}localeCompare/);
assert.match(worker, /ORDER BY sn\.seq DESC, sn\.id DESC/);
assert.match(worker, /ORDER BY ae\.seq DESC, ae\.id DESC/);
assert.match(core, /BlocknotV3\.emit\('cover-change', notebook\.id\)/);
assert.match(read('v3-ui.js'), /BlocknotV3\.on\('cover-change'/);

console.log('critical-guards: PASS');
