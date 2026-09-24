import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../v3-sync.js', import.meta.url), 'utf8');

function createRuntime(seed = {}) {
  const db = {
    notebooks: new Map((seed.notebooks || []).map(row => [row.id, structuredClone(row)])),
    spreads: new Map((seed.spreads || []).map(row => [row.id, structuredClone(row)])),
    tags: new Map((seed.tags || []).map(row => [row.id, structuredClone(row)])),
    photos: new Map((seed.photos || []).map(row => [row.id, structuredClone(row)])),
    spread_notes: new Map((seed.spread_notes || []).map(row => [row.cache_id, structuredClone(row)])),
    activity_events: new Map(),
    blobs: new Map((seed.blobs || []).map(row => [row.id, structuredClone(row)])),
    spread_tags: new Map(),
    user_favorites: new Map(),
    sync_queue: new Map((seed.sync_queue || []).map(row => [row.id, structuredClone(row)]))
  };
  let apiImpl = async () => { throw new Error('Unexpected API request'); };
  let fetchImpl = async () => { throw new Error('Unexpected fetch'); };
  const context = {
    console:{...console, warn() {}, error() {}},
    Date,
    Math,
    Set,
    Object,
    String,
    Number,
    Promise,
    Error,
    window: {},
    settings: {auth_token:'token', user_id:'u1', backend_url:'https://example.test', keep_originals_offline:true, sync_status:'idle', ...(seed.settings || {})},
    syncing: false,
    route: {screen:'notebooks'},
    nowISO: () => new Date().toISOString(),
    normalize: value => String(value || '').toLowerCase(),
    uid: (() => { let i = 0; return () => `generated-${++i}`; })(),
    isAuthed: () => true,
    isOnline: () => true,
    toast: () => {},
    updateSyncIndicator: () => {},
    saveSettings: async () => {},
    syncMembership: async () => {},
    pullChanges: async () => {},
    renderSyncStatus: () => {},
    document: {getElementById: () => null},
    fetch: (...args) => fetchImpl(...args),
    FormData: class { append() {} },
    api: (...args) => apiImpl(...args),
    get: async (store, id) => structuredClone(db[store].get(id)),
    getAll: async store => [...db[store].values()].map(row => structuredClone(row)),
    getAllByIndex: async () => [],
    put: async (store, row) => {
      if (store === 'sync_queue' && Object.hasOwn(row,'id')) assert.notEqual(row.id,undefined,'IndexedDB auto-key requires the id property to be absent');
      const key = store === 'sync_queue' ? (row.id ?? db.sync_queue.size + 1) :
        (store === 'user_favorites' ? row.spread_id : ['spread_notes','activity_events'].includes(store) ? row.cache_id : row.id);
      if (store === 'sync_queue') row.id = key;
      db[store].set(key, structuredClone(row));
      return key;
    },
    del: async (store, id) => db[store].delete(id),
    pushNotebook: async () => {}, pushSpread: async () => {}, pushTagLink: async () => {},
    pushFavorite: async () => {}, pushEntityQueue: async () => {}, pushPhotoQueue: async () => {},
    applyChangeBatch: async () => {}, applySnapshot: async () => {}, fullSync: async () => {}
  };
  vm.createContext(context);
  vm.runInContext(source, context, {filename:'v3-sync.js'});
  context.window.vNextAtomic = async (store, key, update) => {
    const result = update(await context.get(store, key));
    if (result.row) await context.put(store, result.row);
    if (result.item) await context.put('sync_queue', result.item);
    for (const item of result.retired || []) await context.put('sync_queue', item);
  };
  return {context, db, setApi(fn) { apiImpl = fn; }, setFetch(fn) { fetchImpl = fn; }};
}

async function testDeferredDependencyStaysPending() {
  const runtime = createRuntime({
    notebooks:[{id:'nb-local'}],
    spreads:[{id:'sp-local', notebook_id:'nb-local'}],
    sync_queue:[{id:1, entity:'spread', local_id:'sp-local', status:'pending', retry_count:0}]
  });
  await runtime.context.pushEntityQueue(false);
  assert.equal(runtime.db.sync_queue.get(1).status, 'pending');
  assert.match(runtime.db.sync_queue.get(1).last_error, /server id/);
}

async function testFailedRetryBackoffAndManualRetry() {
  const runtime = createRuntime({
    spreads:[{id:'sp-local', server_id:'sp-server'}],
    sync_queue:[{id:2, entity:'favorite', local_id:'sp-local', op:'add', status:'pending', retry_count:0}]
  });
  let calls = 0;
  runtime.setApi(async () => { calls++; throw new Error('temporary'); });
  await runtime.context.pushEntityQueue(false);
  const failed = runtime.db.sync_queue.get(2);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.retry_count, 1);
  assert.ok(Date.parse(failed.next_attempt_at) > Date.now());
  await runtime.context.pushEntityQueue(false);
  assert.equal(calls, 1, 'automatic retry must respect backoff');
  await runtime.context.pushEntityQueue(true);
  assert.equal(calls, 2, 'manual sync may retry immediately');
}

async function testConflictIsNotMarkedDone() {
  const runtime = createRuntime({
    notebooks:[{id:'nb-local', server_id:'nb-server'}],
    spreads:[{id:'sp-local', server_id:'sp-server', notebook_id:'nb-local', title:'local', revision:1}],
    sync_queue:[{id:3, entity:'spread', local_id:'sp-local', status:'pending', retry_count:0}]
  });
  let calls = 0;
  runtime.setApi(async () => {
    calls++;
    const error = new Error('conflict');
    error.status = 409;
    error.data = {server_copy:{title:'remote', revision:2}};
    throw error;
  });
  await runtime.context.pushEntityQueue(false);
  assert.equal(runtime.db.sync_queue.get(3).status, 'conflict');
  assert.equal(runtime.db.spreads.get('sp-local').title, 'local');
  assert.equal(runtime.db.spreads.get('sp-local').conflict.title, 'remote');

  await runtime.context.pushEntityQueue(true);
  assert.equal(runtime.db.sync_queue.get(3).status, 'conflict');
  assert.equal(calls, 1, 'manual retry must not retry conflict rows');
}

async function testReadOnlyConflictDiagnosticsAndPreparedSafeResolution() {
  const local = {id:'sp-local', server_id:'sp-server', notebook_id:'nb-local', number:7,
    title:'Одинаково', status:'Актуально', note_short:'коротко', note_full:'полностью', revision:2,
    current_photo_id:'photo-local', conflict:{title:'old server copy'}};
  const server = {id:'sp-server', notebook_id:'nb-server', number:7,
    title:'Одинаково', status:'Актуально', note_short:'коротко', note_full:'полностью', revision:9,
    updated_at:'2026-09-13T20:00:00.000Z'};
  const runtime = createRuntime({spreads:[local],sync_queue:[
    {id:31,entity:'spread',local_id:'sp-local',status:'conflict',retry_count:1,last_error:'revision conflict',server_copy:server},
    {id:32,entity:'spread',local_id:'sp-local',status:'conflict',retry_count:2,last_error:'revision conflict',server_copy:server},
    {id:33,entity:'spread_fields',local_id:'sp-local',scope:'https://example.test|u1',status:'conflict',retry_count:0,
      payload:{changes:{title:'Телефон'},base_values:{title:'База'},client_ref:'hidden-client-ref',auth_token:'must-not-leak'},
      conflicts:{conflicts:{title:{base:'База',mine:'Телефон',server:'Сервер'}},server_copy:{...server,title:'Сервер'}}}
  ]});
  const before = structuredClone([...runtime.db.sync_queue.values()]);
  const groups = await runtime.context.window.v340Sync.conflictGroups();
  assert.equal(groups.length,2);
  const legacy = groups.find(group=>group.entity==='spread');
  const fields = groups.find(group=>group.entity==='spread_fields');
  assert.equal(legacy.kind,'legacy spread');
  assert.equal(legacy.items.length,2);
  assert.equal(legacy.spread.number,7);
  assert.match(legacy.reason,/не отправляет/);
  assert.deepEqual(JSON.parse(JSON.stringify(fields.items[0].changes)),{title:'Телефон'});
  assert.deepEqual(JSON.parse(JSON.stringify(fields.items[0].base_values)),{title:'База'});
  assert.deepEqual(JSON.parse(JSON.stringify(fields.items[0].server_conflicts)),{title:{base:'База',mine:'Телефон',server:'Сервер'}});
  assert.doesNotMatch(JSON.stringify(groups),/must-not-leak|hidden-client-ref/,'diagnostics omit auth and idempotency values');
  assert.deepEqual([...runtime.db.sync_queue.values()],before,'diagnostics must not change IndexedDB');

  let requests = [];
  runtime.setApi(async (path, options) => { requests.push([path,options]); return {spread:server}; });
  const spreadBeforeCleanup = structuredClone(runtime.db.spreads.get('sp-local'));
  const result = await runtime.context.window.v340Sync.safeResolveDuplicateSpreadConflicts(legacy.key);
  assert.deepEqual(JSON.parse(JSON.stringify(result)),{resolved:true,count:2});
  assert.deepEqual(requests,[['/api/spreads/sp-server',undefined]],'prepared resolver uses one read-only GET');
  assert.deepEqual([runtime.db.sync_queue.get(31).status,runtime.db.sync_queue.get(32).status],['done','done']);
  assert.equal(runtime.db.sync_queue.get(33).status,'conflict','unrelated field conflict stays untouched');
  assert.deepEqual(runtime.db.spreads.get('sp-local'),spreadBeforeCleanup,'cleanup must not change spread, revision or current photo');
  assert.ok(runtime.db.sync_queue.get(31).retired_at,'retired queue row remains stored with audit metadata');

  const mismatch = createRuntime({spreads:[local],sync_queue:[
    {id:41,entity:'spread',local_id:'sp-local',status:'conflict',server_copy:{...server,title:'Сервер'}}
  ]});
  mismatch.setApi(async () => ({spread:{...server,title:'Сервер'}}));
  const mismatchGroup = (await mismatch.context.window.v340Sync.conflictGroups())[0];
  assert.deepEqual(JSON.parse(JSON.stringify(await mismatch.context.window.v340Sync.safeResolveDuplicateSpreadConflicts(mismatchGroup))),
    {resolved:false,reason:'values_differ'});
  assert.equal(mismatch.db.sync_queue.get(41).status,'conflict');
  assert.equal(mismatch.db.spreads.get('sp-local').title,'Одинаково');

  const missingServerData = createRuntime({spreads:[local],sync_queue:[
    {id:51,entity:'spread',local_id:'sp-local',status:'conflict'}
  ]});
  missingServerData.setApi(async () => ({spread:{...server,revision:undefined}}));
  const missingGroup = (await missingServerData.context.window.v340Sync.conflictGroups())[0];
  assert.deepEqual(JSON.parse(JSON.stringify(await missingServerData.context.window.v340Sync.safeResolveDuplicateSpreadConflicts(missingGroup))),
    {resolved:false,reason:'server_data_unavailable'});
  assert.equal(missingServerData.db.sync_queue.get(51).status,'conflict','missing server revision stays unresolved');

  const scopedLegacy = createRuntime({spreads:[local],sync_queue:[
    {id:61,entity:'spread',local_id:'sp-local',scope:'https://example.test|u1',status:'conflict'}
  ]});
  let scopedRequests=0; scopedLegacy.setApi(async () => { scopedRequests++; return {spread:server}; });
  const scopedGroup = (await scopedLegacy.context.window.v340Sync.conflictGroups())[0];
  assert.deepEqual(JSON.parse(JSON.stringify(await scopedLegacy.context.window.v340Sync.safeResolveDuplicateSpreadConflicts(scopedGroup))),
    {resolved:false,reason:'not_unscoped_legacy'});
  assert.equal(scopedRequests,0,'scoped spread conflicts are never inspected or retired as legacy');
  assert.equal(scopedLegacy.db.sync_queue.get(61).status,'conflict');
}

async function testPullPreservesPendingLocalEdit() {
  const runtime = createRuntime({
    notebooks:[{id:'nb-local', server_id:'nb-server'}],
    spreads:[{id:'sp-local', server_id:'sp-server', notebook_id:'nb-local', title:'local', revision:1}],
    sync_queue:[{id:4, entity:'spread', local_id:'sp-local', status:'conflict', retry_count:0}]
  });
  await runtime.context.applyChangeBatch({spreads:[{
    id:'sp-server', notebook_id:'nb-server', title:'remote', number:'1', revision:2
  }]});
  assert.equal(runtime.db.spreads.get('sp-local').title, 'local');
  assert.equal(runtime.db.spreads.get('sp-local').revision, 1);
}

async function testIncrementalPhotoMappingMatchesSnapshotFields() {
  const runtime = createRuntime();
  const mapped = runtime.context.window.v340Sync.mapServerPhoto({}, {
    id:'photo-server', version:3, is_current:1, storage_object_id:'object',
    telegram_message_id:'message', telegram_file_id:'file',
    telegram_file_unique_id:'unique', telegram_link:'link', mime_type:'image/jpeg', file_size:123
  }, 'spread-local');
  assert.equal(mapped.telegram_message_id, 'message');
  assert.equal(mapped.telegram_file_unique_id, 'unique');
  assert.equal(mapped.upload_status, 'synced');
}

async function testQueuedSpreadDeleteSurvivesSnapshot() {
  const runtime = createRuntime({
    notebooks:[{id:'nb-local', server_id:'nb-server'}],
    spreads:[{id:'sp-local', server_id:'sp-server', notebook_id:'nb-local', number:1, deleted_at:'2026-09-12T10:00:00.000Z'}],
    sync_queue:[{id:7, entity:'spread', local_id:'sp-local', status:'pending', retry_count:0, payload:{op:'delete'}}]
  });
  let request = null;
  runtime.setApi(async (path, options) => { request = {path, method:options.method}; return {ok:true}; });
  await runtime.context.pushEntityQueue(false);
  assert.deepEqual(request, {path:'/api/spreads/sp-server', method:'DELETE'}, 'offline delete reaches the server through the existing route');
  assert.equal(runtime.db.sync_queue.get(7).status, 'done');
  assert.ok(runtime.db.spreads.get('sp-local').deleted_at, 'local tombstone is kept');

  const activeSnapshot = async () => ({notebook:{id:'nb-server', title:'nb'},
    spreads:[{id:'sp-server', notebook_id:'nb-server', number:1, deleted_at:null}],
    photos:[], tags:[], spread_tags:[], favorites:[]});
  runtime.db.sync_queue.set(8, {id:8, entity:'spread', local_id:'sp-local', status:'pending', retry_count:0, payload:{op:'delete'}});
  runtime.setApi(activeSnapshot);
  await runtime.context.applySnapshot('nb-server');
  assert.ok(runtime.db.spreads.get('sp-local').deleted_at, 'an unsynced delete must survive a snapshot that still lists the spread');

  runtime.db.sync_queue.set(8, {id:8, entity:'spread', local_id:'sp-local', status:'done'});
  runtime.setApi(async () => ({notebook:{id:'nb-server', title:'nb'},
    spreads:[{id:'sp-server', notebook_id:'nb-server', number:1, deleted_at:'2026-09-12T11:00:00.000Z'}],
    photos:[], tags:[], spread_tags:[], favorites:[]}));
  await runtime.context.applySnapshot('nb-server');
  assert.equal(runtime.db.spreads.get('sp-local').deleted_at, '2026-09-12T11:00:00.000Z', 'confirmed server tombstone wins');
}

await testDeferredDependencyStaysPending();
await testFailedRetryBackoffAndManualRetry();
await testConflictIsNotMarkedDone();
await testReadOnlyConflictDiagnosticsAndPreparedSafeResolution();
await testPullPreservesPendingLocalEdit();
await testIncrementalPhotoMappingMatchesSnapshotFields();
await testQueuedSpreadDeleteSurvivesSnapshot();

const teamSeed = {
  notebooks:[{id:'nb',server_id:'remote-nb'}],
  spreads:[{id:'sp',server_id:'remote-sp',notebook_id:'nb',number:1,title:'before',current_photo_id:'local-photo'}],
  photos:[{id:'local-photo',spread_id:'sp',is_current:true,upload_status:'local_pending'}],
  sync_queue:[{id:1,entity:'photo',photo_id:'local-photo',status:'pending'}]
};
const team = createRuntime(teamSeed), c = team.context;
c.settings.team_capabilities = {scope:c.window.vNextSync.scope(),flags:{team_notes:true,field_merge:true,spread_order:true}};
c.fullSync = async () => {};
await c.window.vNextSync.saveNote(teamSeed.spreads[0], 'Phone A');
const queuedNote = [...team.db.sync_queue.values()].find(row => row.entity === 'spread_note');
assert.ok(queuedNote.payload.client_ref);
let tries = 0;
team.setApi(async (path, options) => {
  assert.equal(path, '/api/spreads/remote-sp/notes');
  assert.equal(options.json.client_ref, queuedNote.payload.client_ref, 'retry identity is immutable');
  if (++tries === 1) throw new Error('response lost');
  return {note:{id:options.json.id,spread_id:'remote-sp',body:'Phone A',author_id:'u1',revision:1}};
});
await c.pushEntityQueue(false);
assert.equal(team.db.sync_queue.get(queuedNote.id).status, 'failed');
await c.pushEntityQueue(true);
assert.equal(team.db.sync_queue.get(queuedNote.id).status, 'done');
assert.equal(team.db.spread_notes.get(queuedNote.local_id).pending, false);
await c.applyChangeBatch({spreads:[{id:'remote-sp',notebook_id:'remote-nb',title:'B text',number:1,revision:5,current_photo_id:'remote-photo'}],
  photos:[{id:'remote-photo',spread_id:'remote-sp',is_current:1}],
  spread_notes:[{id:'b-note',spread_id:'remote-sp',body:'Phone B',author_id:'u2'}],
  activity_events:[{id:'event-1',action:'note.created',actor_user_id:'u2'}]});
assert.equal(team.db.spreads.get('sp').title, 'B text', 'text from B reaches A');
assert.equal(team.db.spreads.get('sp').current_photo_id, 'local-photo', 'pending A photo not overwritten');
assert.equal(team.db.spread_notes.size, 2, 'independent notes retained');
assert.equal(team.db.activity_events.size, 1);
await assert.rejects(c.window.vNextSync.applyTeamChanges({spread_notes:[{id:'orphan',spread_id:'missing'}]}), /ожидает/);
const foreign = [...team.db.spread_notes.values()].find(row => row.author_id === 'u2');
const memberEdit = createRuntime({notebooks:teamSeed.notebooks,spreads:teamSeed.spreads,spread_notes:[foreign]});
memberEdit.context.settings.team_capabilities = {scope:memberEdit.context.window.vNextSync.scope(),flags:{team_notes:true}};
memberEdit.context.fullSync = async () => {};
await memberEdit.context.window.vNextSync.saveNote(teamSeed.spreads[0], 'Исправлено участником', foreign);
const editedForeign = memberEdit.db.spread_notes.get(foreign.cache_id);
assert.equal(editedForeign.author_id, 'u2', 'member edit preserves original author');
assert.equal([...memberEdit.db.sync_queue.values()].find(row=>row.entity==='spread_note').method,'PATCH');
await c.window.vNextSync.saveFields(team.db.spreads.get('sp'), {title:'mine'}, {title:'B text'});
team.setApi(async () => { const error = new Error('field_conflict'); error.status = 409;
  error.data = {conflicts:{title:{base:'B text',mine:'mine',server:'other'}}}; throw error; });
await c.pushEntityQueue(false);
assert.equal(team.db.spreads.get('sp').field_conflicts.title.server, 'other');
assert.equal(team.db.spreads.get('sp').conflict, undefined, 'no whole-record conflict for metadata');
await c.applyChangeBatch({spreads:[{id:'remote-sp',notebook_id:'remote-nb',title:'other',number:2,revision:6,current_photo_id:'remote-photo'}]});
assert.equal(team.db.spreads.get('sp').title, 'mine', 'pending field preserved');
assert.equal(team.db.spreads.get('sp').number, 2, 'independent field pulled');
assert.equal(team.db.spreads.get('sp').current_photo_id, 'local-photo');
c.settings.team_capabilities.flags = {};
await assert.rejects(c.window.vNextSync.saveNote(teamSeed.spreads[0], 'unsupported'), /обновления сервера/);
const pending = {...queuedNote,id:90,status:'pending'};
team.db.sync_queue.set(90,pending);
team.setApi(async () => { throw new Error('Must not send unsupported notes'); });
await c.pushEntityQueue(true);
assert.equal(team.db.sync_queue.get(90).status, 'pending', 'old backend does not discard team outbox');
const snapshotRuntime = createRuntime(teamSeed);
snapshotRuntime.setApi(async () => ({notebook:{title:'nb'},spreads:[{id:'remote-sp',notebook_id:'remote-nb',current_photo_id:'remote-photo'}],
  photos:[{id:'remote-photo',spread_id:'remote-sp',is_current:1}],tags:[],spread_tags:[],favorites:[]}));
await snapshotRuntime.context.applySnapshot('remote-nb');
assert.equal(snapshotRuntime.db.spreads.get('sp').current_photo_id,'local-photo','snapshot preserves pending original');
const orphanRuntime = createRuntime({notebooks:[{id:'nb',server_id:'remote-nb'}]});
orphanRuntime.setApi(async path => {
  assert.equal(path,'/api/notebooks/remote-nb/snapshot');
  return {notebook:{id:'remote-nb',title:'nb'},spreads:[{id:'late-parent',notebook_id:'remote-nb',title:'parent'}],photos:[],tags:[],spread_tags:[],favorites:[]};
});
await orphanRuntime.context.applyChangeBatch({spread_notes:[{id:'child',spread_id:'late-parent',notebook_id:'remote-nb',body:'earlier seq'}]});
assert.equal(orphanRuntime.db.spread_notes.size,1,'parent with later seq recovered without skipping child');
const upload = createRuntime(teamSeed);
upload.db.blobs.set('local-photo_orig',{blob:{}});
upload.context.fetch = async () => {
  upload.db.spreads.set('sp',{...upload.db.spreads.get('sp'),title:'edited during upload',current_photo_id:'newer-photo',revision:8});
  upload.db.photos.set('local-photo',{...upload.db.photos.get('local-photo'),is_current:false});
  return {ok:true,json:async()=>({photo_id:'uploaded',spread_revision:5})};
};
await upload.context.pushPhotoQueue(false);
assert.equal(upload.db.spreads.get('sp').title,'edited during upload');
assert.equal(upload.db.spreads.get('sp').current_photo_id,'newer-photo');
assert.equal(upload.db.spreads.get('sp').revision,8,'upload response cannot roll revision back');
assert.equal(upload.db.photos.get('local-photo').is_current,false,'late response cannot reselect superseded photo');
const upgrade = createRuntime({notebooks:[{id:'nb',server_id:'remote-nb'}]});
upgrade.context.settings.sync_cursor = 9000;
let backfills = 0;
upgrade.setApi(async path => {
  if (path === '/api/me') return {capabilities:{team_notes:true}};
  if (path.startsWith('/api/sync')) return {changes:{}, unread:{notebooks:{},total:0}, next_cursor:9000, has_more:false};
  assert.equal(path,'/api/notebooks/remote-nb/snapshot'); backfills++;
  return {notebook:{id:'remote-nb',title:'nb'},spreads:[{id:'sp',notebook_id:'remote-nb'}],photos:[],tags:[],spread_tags:[],favorites:[],
    spread_notes:[{id:'historic-note',notebook_id:'remote-nb',spread_id:'sp',body:'seq below old cursor',seq:10}]};
});
await upgrade.context.fullSync();
assert.equal(upgrade.db.spread_notes.size,1,'upgrade backfills notes older than saved cursor');
assert.equal(upgrade.context.settings.sync_cursor,9000,'existing sync cursor is not reset');
await upgrade.context.fullSync();
assert.equal(backfills,1,'successful backfill only once per backend/account');
const conflictNote = {id:'n',cache_id:'https://example.test|u1|n',scope:'https://example.test|u1',spread_id:'sp',notebook_id:'nb',author_id:'u1',body:'mine',pending:true,sync_error:'conflict'};
const noteResolution = createRuntime({...teamSeed,spread_notes:[conflictNote],sync_queue:[{
  id:1,entity:'spread_note',local_id:conflictNote.cache_id,spread_id:'sp',note_id:'n',method:'PATCH',scope:conflictNote.scope,status:'conflict',
  payload:{client_ref:'previous',body:'mine',revision:1},conflicts:{server_note:{id:'n',body:'server',revision:3,deleted_at:null}}
}]});
noteResolution.context.fullSync=async()=>{};
await noteResolution.context.window.vNextSync.resolveNote(conflictNote,'mine','merged');
assert.equal(noteResolution.db.sync_queue.get(1).status,'done');
const resolvedItem=[...noteResolution.db.sync_queue.values()].find(item=>item.status==='pending');
assert.equal(resolvedItem.payload.revision,3);
assert.equal(resolvedItem.payload.body,'merged');
assert.notEqual(resolvedItem.payload.client_ref,'previous','resolution is a new explicit operation');
assert.equal(noteResolution.db.spread_notes.get(conflictNote.cache_id).body,'merged');

// Legacy notebook conflicts: identical server state closes every stale duplicate without PATCH.
const notebookSame = createRuntime({notebooks:[{id:'nb',server_id:'remote-nb',title:'Общий',description:'',archived:false,revision:1}],sync_queue:[
  {id:1,entity:'notebook',local_id:'nb',status:'conflict',server_copy:{title:'Старое',revision:2}},
  {id:2,entity:'notebook',local_id:'nb',status:'conflict',server_copy:{title:'Старое',revision:2}}
]});
let notebookCalls=0;
notebookSame.setApi(async path=>{notebookCalls++;assert.equal(path,'/api/notebooks/remote-nb');return {notebook:{id:'remote-nb',title:'Общий',description:'',archived:0,revision:7}};});
assert.equal(await notebookSame.context.window.v340Sync.reconcileNotebookConflicts(),2);
assert.equal(notebookSame.db.notebooks.get('nb').revision,7);
assert.deepEqual([...notebookSame.db.sync_queue.values()].map(row=>row.status),['done','done']);
assert.equal(notebookCalls,1,'one server refresh per conflicted notebook');

// A genuine difference keeps one user choice and collapses all old outbox duplicates.
const notebookDifferent = createRuntime({notebooks:[{id:'nb',server_id:'remote-nb',title:'Телефон',description:'локально',archived:false,revision:1}],sync_queue:[
  {id:1,entity:'notebook',local_id:'nb',status:'conflict'}, {id:2,entity:'notebook',local_id:'nb',status:'conflict'}
]});
notebookDifferent.setApi(async()=>({notebook:{id:'remote-nb',title:'Сервер',description:'удалённо',archived:0,revision:5}}));
const [notebookGroup] = await notebookDifferent.context.window.v340Sync.notebookConflictGroups(true);
await notebookDifferent.context.window.v340Sync.resolveNotebookConflict(notebookGroup,'local');
assert.equal(notebookDifferent.db.notebooks.get('nb').title,'Телефон');
assert.equal(notebookDifferent.db.notebooks.get('nb').revision,5);
assert.equal([...notebookDifferent.db.sync_queue.values()].filter(row=>row.status==='pending').length,1);
assert.equal([...notebookDifferent.db.sync_queue.values()].filter(row=>row.status==='done').length,1);
await notebookDifferent.context.queueEntityChange('notebook','nb');
assert.equal(notebookDifferent.db.sync_queue.size,2,'new notebook edits reuse the one pending outbox row');

// Shared cover + server unread: sync applies server cover state, but never over a pending local change.
const coverApplied = [];
const coverRuntime = createRuntime({notebooks:[{id:'nb-c',server_id:'remote-nb-c'}]});
coverRuntime.context.window.v340ApplyServerCover = async (notebook, cover) => { coverApplied.push([notebook.id, cover.deleted_at]); return true; };
coverRuntime.context.window.v340CoverBlobId = id => 'notebook_cover_' + id;
await coverRuntime.context.applyChangeBatch({notebook_covers:[{notebook_id:'remote-nb-c',cover_revision:2,deleted_at:null,seq:5}]});
assert.equal(coverApplied.length,1,'server cover reaches the local notebook');
assert.equal(coverApplied[0][1],null);
coverRuntime.db.sync_queue.set(11,{id:11,entity:'notebook_cover',local_id:'nb-c',status:'pending',payload:{op:'put',client_ref:'x'}});
await coverRuntime.context.applyChangeBatch({notebook_covers:[{notebook_id:'remote-nb-c',cover_revision:3,deleted_at:'2026-09-12T00:00:00.000Z',seq:6}]});
assert.equal(coverApplied.length,1,'a pending local cover change is not overwritten by sync');
coverRuntime.db.sync_queue.set(11,{...coverRuntime.db.sync_queue.get(11),status:'done'});
await coverRuntime.context.applyChangeBatch({notebook_covers:[{notebook_id:'remote-nb-c',cover_revision:3,deleted_at:'2026-09-12T00:00:00.000Z',seq:6}]});
assert.equal(coverApplied.length,2,'a cover tombstone is applied once the local change is done');
assert.equal(coverApplied[1][1],'2026-09-12T00:00:00.000Z');
coverRuntime.setApi(async () => ({changes:{}, unread:{notebooks:{'remote-nb-c':{count:2,max_seq:9}},spreads:{'remote-sp':{count:1,max_seq:9}},total:2}, next_cursor:9, has_more:false}));
coverRuntime.context.settings.sync_cursor = 0;
await coverRuntime.context.pullChanges();
assert.equal(coverRuntime.context.settings.unread_by_notebook['remote-nb-c'].count,2,'server unread reaches the badge state');
assert.equal(coverRuntime.context.settings.unread_spreads['remote-sp'].count,1,'per-spread unread reaches the client');
for (const failingStep of ['pushEntityQueue','pushPhotoQueue','syncMembership']) {
  const r = createRuntime(); let pulled = 0;
  r.setApi(async () => ({capabilities:{}}));
  r.context[failingStep] = async () => { throw new Error(failingStep); };
  r.context.pullChanges = async () => { pulled++; };
  await r.context.fullSync();
  assert.equal(pulled, 1, failingStep + ' must not block pull');
  assert.equal(r.context.settings.sync_status, 'error', 'isolated failure stays diagnostic');
}
for (const status of [0,503,401,403]) {
  const r = createRuntime(); let pulls = 0, pushes = 0;
  r.context.settings.team_capabilities = {scope:r.context.window.vNextSync.scope(), flags:{activity:true}};
  r.setApi(async () => { throw Object.assign(new Error('session failure'), {status}); });
  r.context.pushEntityQueue = r.context.pushPhotoQueue = async () => { pushes++; };
  r.context.pullChanges = async () => { pulls++; };
  await r.context.fullSync();
  assert.equal(pushes, 0, 'unverified session never pushes');
  assert.equal(pulls, status === 401 || status === 403 ? 0 : 1);
  assert.equal(r.context.window.vNextSync.enabled('activity'), true, 'transient failure preserves scoped capabilities');
}
{
  const r = createRuntime({notebooks:[{id:'n',server_id:'server'}]}); let attempts=0;
  r.setApi(async path => {
    if (path === '/api/me') return {capabilities:{team_notes:true}};
    if (path.endsWith('/snapshot')) { attempts++; throw new Error('snapshot offline'); }
    return {changes:{},next_cursor:12,has_more:false};
  });
  await r.context.fullSync(); await r.context.fullSync();
  assert.equal(attempts, 2, 'failed backfill retried next sync');
  assert.equal(r.context.settings.team_snapshot_scope, undefined);
  assert.equal(r.context.settings.sync_cursor, 12, 'failed optional backfill does not prevent pull');
}
{
  const r = createRuntime();
  r.setApi(async () => ({capabilities:{}})); r.context.pullChanges=async()=>{};
  r.context.saveSettings = async () => { throw new Error('disk unavailable'); };
  await r.context.fullSync();
  assert.equal(r.context.syncing, false, 'settings write failure cannot permanently lock fullSync');
  assert.equal(r.context.settings.sync_status, 'error');
}
{
  const r = createRuntime(teamSeed);
  r.context.settings.sync_cursor = 5;
  r.setApi(async () => ({changes:{activity_events:[{id:'durable-event',seq:8}]},next_cursor:8,has_more:false}));
  const original = r.context.put;
  r.context.put = async (store,row) => { if(store==='activity_events') throw new Error('IDB failure'); return original(store,row); };
  await assert.rejects(r.context.pullChanges(), /IDB failure/);
  assert.equal(r.context.settings.sync_cursor, 5, 'failed apply keeps cursor');
  r.context.put=original; await r.context.pullChanges();
  assert.equal(r.context.settings.sync_cursor,8); assert.equal(r.db.activity_events.size,1);
}
{
  const r=createRuntime();r.context.settings.sync_cursor=4;
  r.setApi(async()=> {r.context.settings.user_id='other';return {changes:{activity_events:[{id:'wrong-account'}]},next_cursor:50};});
  await assert.rejects(r.context.pullChanges(),/Аккаунт/);
  assert.equal(r.db.activity_events.size,0);assert.equal(r.context.settings.sync_cursor,4);
}
{
  const r=createRuntime({sync_queue:[{id:1,entity:'spread_note',status:'conflict'}]});
  assert.equal((await r.context.window.v340Sync.diagnostics()).label,'Конфликт: note');
  r.db.sync_queue.set(1,{id:1,entity:'photo',status:'failed'});
  assert.equal((await r.context.window.v340Sync.diagnostics()).label,'Ошибка: photos');
  r.db.sync_queue.set(1,{id:1,entity:'photo',status:'pending'});
  assert.equal((await r.context.window.v340Sync.diagnostics()).label,'Ожидает отправки: 1');
  r.db.sync_queue.clear();assert.equal((await r.context.window.v340Sync.diagnostics()).label,'Синхронизировано');
  r.context.isOnline=()=>false;assert.equal((await r.context.window.v340Sync.diagnostics()).label,'Нет сети');
}
{
  const r=createRuntime();r.context.settings.sync_cursor=2;
  r.setApi(async path=>{
    if(path.startsWith('/api/sync'))return {changes:{photos:[{id:'photo',spread_id:'late-parent',seq:3}]},next_cursor:3};
    throw new Error('parent unavailable');
  });
  await assert.rejects(r.context.pullChanges(),/parent unavailable/);
  assert.equal(r.context.settings.sync_cursor,2,'orphan photo cannot be skipped');
  r.setApi(async path=>{
    if(path.startsWith('/api/sync'))return {changes:{photos:[{id:'photo',spread_id:'late-parent',seq:3}]},next_cursor:3};
    if(path.startsWith('/api/spreads/'))return {spread:{notebook_id:'parent-nb'}};
    return {notebook:{id:'parent-nb'},spreads:[{id:'late-parent',notebook_id:'parent-nb'}],tags:[],photos:[],spread_tags:[],favorites:[]};
  });
  await r.context.pullChanges();assert.equal(r.context.settings.sync_cursor,3);assert.equal(r.db.photos.size,1);
}

{
  const r = createRuntime();
  const preserved = r.context.window.v340Sync.mapServerPhoto(
    {id:'local-photo', telegram_link:'https://t.me/c/111/5'},
    {id:'server-photo', version:1, is_current:1, telegram_message_id:'5', mime_type:'image/jpeg', file_size:10},
    'spread-local'
  );
  assert.equal(preserved.telegram_link, 'https://t.me/c/111/5', 'sync without link preserves an already usable local Telegram link');
  const replaced = r.context.window.v340Sync.mapServerPhoto(
    {id:'local-photo', telegram_link:'https://t.me/c/111/stale'},
    {id:'server-photo', version:1, is_current:1, telegram_message_id:'6', telegram_link:'https://t.me/c/222/6'},
    'spread-local'
  );
  assert.equal(replaced.telegram_link, 'https://t.me/c/222/6', 'fresh server Telegram link replaces stale local link');
}
{
  const r = createRuntime({
    notebooks:[{id:'nb-local', server_id:'nb-server', owner_id:'u1', title:'Owner notebook'}],
    spreads:[
      {id:'mtlf4xgftqrtxh', server_id:'srv-spread', notebook_id:'nb-local', number:3,
        title:'9-10', status:'Актуально', note_short:'short', note_full:'full', revision:4,
        current_photo_id:'photo-local', deleted_at:null},
      {id:'duplicate-local', server_id:'srv-duplicate', notebook_id:'nb-local', number:3,
        title:'duplicate', status:'Актуально', revision:2, deleted_at:null}
    ],
    photos:[{id:'photo-local', server_id:'srv-photo', spread_id:'mtlf4xgftqrtxh', version:2, is_current:true,
      upload_status:'synced', storage_object_id:'storage', telegram_message_id:'321', telegram_file_id:'file',
      telegram_file_unique_id:'unique', telegram_link:'https://t.me/c/999/321', mime_type:'image/jpeg',
      file_size:12345, client_upload_id:'photo-local'}],
    sync_queue:[
      {id:281, entity:'spread', local_id:'other-pending', status:'pending', retry_count:0},
      {id:282, entity:'photo', photo_id:'photo-local', status:'failed', retry_count:2, last_error:'temporary'},
      {id:283, entity:'spread_note', local_id:'note-cache', spread_id:'mtlf4xgftqrtxh', status:'syncing', retry_count:0},
      {id:287, entity:'spread', local_id:'mtlf4xgftqrtxh', status:'conflict', retry_count:0,
        last_error:'revision conflict', payload:{revision:null, client_ref:'safe-to-show', auth_token:'secret-token'},
        server_copy:null},
      {id:300, entity:'favorite', local_id:'mtlf4xgftqrtxh', status:'done', retry_count:0}
    ]
  });
  r.db.blobs.set('photo-local_orig', {blob:{size:12345, type:'image/jpeg', raw:'rawbinary'}});
  r.db.blobs.set('photo-local_thumb', {blob:{size:456, type:'image/webp', raw:'thumbbinary'}});
  const beforeQueue = JSON.stringify([...r.db.sync_queue.values()]);
  let fullSyncCalls = 0, retryCalls = 0;
  r.context.fullSync = async () => { fullSyncCalls++; };
  r.context.pushEntityQueue = async () => { retryCalls++; };
  r.context.pushPhotoQueue = async () => { retryCalls++; };
  const report = await r.context.window.v340Sync.buildReadOnlyDiagnosticReport();
  assert.deepEqual(JSON.parse(JSON.stringify(report.queue_counts)), {total_unsynced:4, pending:1, syncing:1, failed:1, conflict:1}, 'diagnostic counts keep statuses separate');
  assert.equal(report.current_role, 'OWNER');
  assert.equal(report.items.length, 4, 'diagnostic screen data lists unfinished queue rows only');
  const conflict = report.items.find(item => item.id === 287);
  assert.equal(conflict.local_spread.exists, true, 'conflict diagnostic shows local spread exists');
  assert.equal(conflict.local_spread.id, 'mtlf4xgftqrtxh');
  assert.equal(conflict.local_spread.number, 3);
  assert.equal(conflict.local_spread.revision, 4);
  assert.equal(conflict.local_spread.duplicate_number.exists, true);
  assert.equal(conflict.local_spread.duplicate_number.count, 2);
  assert.equal(conflict.payload.auth_token, '[redacted]');
  const photoItem = report.items.find(item => item.id === 282);
  assert.equal(photoItem.photos[0].telegram_link, 'https://t.me/c/999/321');
  assert.equal(photoItem.photos[0].blobs.orig.exists, true);
  assert.equal(photoItem.photos[0].blobs.orig.size, 12345);
  assert.equal(photoItem.photos[0].blobs.thumb.exists, true);
  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, /secret-token|rawbinary|thumbbinary|Bearer/, 'diagnostic report must not include auth tokens or blob contents');
  assert.equal(JSON.stringify([...r.db.sync_queue.values()]), beforeQueue, 'diagnostic opening/building does not change sync_queue');
  assert.equal(fullSyncCalls, 0, 'diagnostic opening/building does not run fullSync');
  assert.equal(retryCalls, 0, 'diagnostic opening/building does not retry queue rows');
  const calls = [];
  r.setApi(async (path, options) => {
    calls.push({path, options});
    return {spread:{id:'srv-spread', number:3, title:'9-10', status:'Актуально', note_short:'short', note_full:'full', revision:9}};
  });
  const checked = await r.context.window.v340Sync.checkSpreadOnServerReadOnly('srv-spread', conflict.local_spread);
  assert.equal(checked.method, 'GET');
  assert.equal(checked.path, '/api/spreads/srv-spread');
  assert.equal(checked.exists, true);
  assert.equal(checked.same_business_fields, true);
  assert.deepEqual(calls, [{path:'/api/spreads/srv-spread', options:undefined}], 'server check uses only a GET api(path) call');
  const impossible = await r.context.window.v340Sync.checkSpreadOnServerReadOnly(null, conflict.local_spread);
  assert.match(impossible.message, /отсутствует server_id/);
}

function repair910Fixture() {
  const serverNotebookId = 'deb42fd8-38a3-4da0-862d-e5538cade2f6';
  const anchorId = 'c260e443-099c-4797-8f0a-4f02a7d374aa';
  const serverSpreads = Array.from({length:27}, (_, index) => {
    const number = index + 1;
    return {
      id:number === 3 ? anchorId : `server-${number}`,
      notebook_id:serverNotebookId,
      client_ref:number === 3 ? 'mtlf3c95g2wsiv' : `local-${number}`,
      number,
      title:number === 3 ? '3-4' : number === 4 ? '11-12' : `spread-${number}`,
      status:'Актуально', note_short:null, note_full:null,
      revision:number === 3 ? 6 : number === 4 ? 3 : 1,
      created_at:'2026-09-01T00:00:00.000Z', updated_at:'2026-09-01T00:00:00.000Z',
      current_photo_id:null, deleted_at:null,
    };
  });
  const localSpreads = serverSpreads.map(row => ({
    id:row.client_ref, server_id:row.id, notebook_id:'mtk0xajzs8tiep', number:row.number,
    title:row.title, status:row.status, note_short:row.note_short, note_full:row.note_full,
    revision:row.revision, current_photo_id:null, deleted_at:null,
  }));
  localSpreads.push({
    id:'mtlf4xgftqrtxh', notebook_id:'mtk0xajzs8tiep', number:3, title:'9-10',
    status:'Актуально', note_short:null, note_full:null, revision:null, server_id:null,
    current_photo_id:'mtlf4xmzkbhq9s', created_at:'2026-09-01T00:00:00.000Z',
    updated_at:'2026-09-01T00:00:00.000Z', deleted_at:null,
  });
  return {
    serverNotebookId, anchorId, serverSpreads,
    seed:{
      settings:{backend_url:'https://blocknot-proxy.mastif1235.workers.dev'},
      notebooks:[{id:'mtk0xajzs8tiep', server_id:serverNotebookId}],
      spreads:localSpreads,
      photos:[{id:'mtlf4xmzkbhq9s', spread_id:'mtlf4xgftqrtxh', version:1, is_current:true,
        upload_status:'local_pending', file_size:4950282, server_id:null}],
      blobs:[
        {id:'mtlf4xmzkbhq9s_orig', blob:{size:4950282, type:'image/jpeg'}},
        {id:'mtlf4xmzkbhq9s_thumb', blob:{size:24520, type:'image/webp'}},
      ],
      sync_queue:[
        {id:286, entity:'photo', photo_id:'mtlf4xmzkbhq9s', status:'pending', retry_count:0, last_error:'spread has no server id'},
        {id:287, entity:'spread', local_id:'mtlf4xgftqrtxh', status:'conflict', retry_count:1, last_error:'revision conflict'},
        {id:367, entity:'spread', local_id:'another-spread', status:'conflict', retry_count:2, payload:{number:32}},
      ],
    },
  };
}

async function testRepair910PreviewIsReadOnly() {
  const fixture = repair910Fixture();
  const runtime = createRuntime(fixture.seed);
  const before = structuredClone(Object.fromEntries(Object.entries(runtime.db).map(([key,value]) => [key,[...value.entries()]])));
  const calls = [];
  runtime.setApi(async (path, options) => {
    calls.push({path, options});
    if (path.endsWith('/spreads')) return {spreads:structuredClone(fixture.serverSpreads)};
    if (path === `/api/spreads/${fixture.anchorId}`) return {spread:structuredClone(fixture.serverSpreads[2])};
    throw new Error(`Unexpected API request: ${path}`);
  });
  const preview = await runtime.context.window.v340Sync.buildRepair910Preview();
  assert.equal(preview.eligible, true);
  assert.equal(preview.checks.every(check => check.pass), true);
  assert.equal(preview.plan.queue_367.includes('never update'), true);
  assert.equal(preview.backup.queue_286.id, 286);
  assert.equal(preview.backup.queue_287.id, 287);
  assert.equal(preview.backup.spread_mtlf4xgftqrtxh.id, 'mtlf4xgftqrtxh');
  assert.equal(preview.backup.photo_mtlf4xmzkbhq9s.id, 'mtlf4xmzkbhq9s');
  assert.equal(calls.length, 2);
  assert.equal(calls.every(call => call.options === undefined), true, 'Preview must use GET-only api calls');
  const after = structuredClone(Object.fromEntries(Object.entries(runtime.db).map(([key,value]) => [key,[...value.entries()]])));
  assert.deepEqual(after, before, 'Preview must not mutate IndexedDB state');
}

async function testRepair910ApplyTouchesOnly286And287() {
  const fixture = repair910Fixture();
  const runtime = createRuntime(fixture.seed);
  let serverSpreads = structuredClone(fixture.serverSpreads);
  let serverPhoto = null;
  const queue367Before = structuredClone(runtime.db.sync_queue.get(367));
  const mutatingCalls = [];
  runtime.setApi(async (path, options) => {
    if (!options) {
      if (path.endsWith('/spreads')) return {spreads:structuredClone(serverSpreads)};
      if (path === `/api/spreads/${fixture.anchorId}`) return {spread:structuredClone(serverSpreads.find(row => row.id === fixture.anchorId))};
      if (path === '/api/photos/photo-server-910') return {photo:structuredClone(serverPhoto)};
    }
    if (path.endsWith('/spreads') && options?.method === 'POST') {
      mutatingCalls.push({path, method:'POST'});
      const created = {id:'spread-server-910', notebook_id:fixture.serverNotebookId, client_ref:'mtlf4xgftqrtxh',
        number:28, title:'9-10', status:'Актуально', note_short:null, note_full:null, revision:1,
        current_photo_id:null, deleted_at:null, created_at:'2026-09-15T10:00:00.000Z', updated_at:'2026-09-15T10:00:00.000Z'};
      serverSpreads.push(created);
      return {spread:structuredClone(created)};
    }
    if (path.endsWith('/spreads/order') && options?.method === 'PUT') {
      mutatingCalls.push({path, method:'PUT'});
      assert.equal(options.json.items.length, 28);
      assert.equal(new Set(options.json.items.map(item => item.spread_id)).size, 28);
      const ids = options.json.items.map(item => item.spread_id);
      serverSpreads = ids.map((id,index) => {
        const row = serverSpreads.find(candidate => candidate.id === id);
        return {...row, number:index + 1, revision:Number(row.revision) + 1, updated_at:'2026-09-15T10:01:00.000Z'};
      });
      return {spreads:structuredClone(serverSpreads)};
    }
    throw new Error(`Unexpected API request: ${path} ${options?.method || 'GET'}`);
  });
  runtime.setFetch(async (url, options) => {
    mutatingCalls.push({path:String(url), method:options?.method});
    assert.equal(options.method, 'POST');
    const target = serverSpreads.find(row => row.id === 'spread-server-910');
    target.revision += 1;
    target.current_photo_id = 'photo-server-910';
    serverPhoto = {id:'photo-server-910', spread_id:target.id, telegram_message_id:'777',
      telegram_link:'https://t.me/c/1/777'};
    return {ok:true, status:200, json:async () => ({photo_id:serverPhoto.id, storage_object_id:'object-910',
      message_id:serverPhoto.telegram_message_id, file_id:'file-910', file_unique_id:'unique-910',
      telegram_link:serverPhoto.telegram_link, spread_revision:target.revision})};
  });
  const preview = await runtime.context.window.v340Sync.buildRepair910Preview();
  const result = await runtime.context.window.v340Sync.applyRepair910(preview.guard);
  assert.equal(result.completed, true);
  assert.equal(result.spread_server_id, 'spread-server-910');
  assert.equal(result.final_number, 4);
  assert.equal(result.photo_server_id, 'photo-server-910');
  assert.equal(result.telegram_message_id_present, true);
  assert.equal(result.telegram_link_present, true);
  assert.equal(runtime.db.sync_queue.get(286).status, 'done');
  assert.equal(runtime.db.sync_queue.get(287).status, 'done');
  assert.deepEqual(runtime.db.sync_queue.get(367), queue367Before, '#367 must remain byte-equivalent');
  assert.equal(runtime.db.blobs.has('mtlf4xmzkbhq9s_orig'), true);
  assert.equal(runtime.db.blobs.has('mtlf4xmzkbhq9s_thumb'), true);
  assert.deepEqual(mutatingCalls.map(call => call.method), ['POST','PUT','POST']);
}

async function testRepair910StopsIfStateChangesAfterPreview() {
  const fixture = repair910Fixture();
  const runtime = createRuntime(fixture.seed);
  let mutations = 0;
  runtime.setApi(async (path, options) => {
    if (options) { mutations++; throw new Error('mutation must not run'); }
    if (path.endsWith('/spreads')) return {spreads:structuredClone(fixture.serverSpreads)};
    if (path === `/api/spreads/${fixture.anchorId}`) return {spread:structuredClone(fixture.serverSpreads[2])};
    throw new Error(`Unexpected API request: ${path}`);
  });
  const preview = await runtime.context.window.v340Sync.buildRepair910Preview();
  runtime.db.sync_queue.get(367).retry_count = 3;
  await assert.rejects(
    runtime.context.window.v340Sync.applyRepair910(preview.guard),
    /состояние изменилось после Preview/,
  );
  assert.equal(mutations, 0);
  assert.equal(runtime.db.spreads.get('mtlf4xgftqrtxh').server_id, null);
  assert.equal(runtime.db.sync_queue.get(286).status, 'pending');
  assert.equal(runtime.db.sync_queue.get(287).status, 'conflict');
}

async function testNullableTextConflictNormalization() {
  const runtime = createRuntime({
    settings:{team_capabilities:{scope:'https://example.test|u1',flags:{field_merge:true}}},
    spreads:[{id:'nullable-local',server_id:'nullable-server',notebook_id:'nb',number:26,
      title:'Пер пионерский',note_short:null,note_full:null,revision:2,current_photo_id:'photo-kept'}],
    sync_queue:[{id:782,entity:'spread_fields',local_id:'nullable-local',server_id:'nullable-server',
      scope:'https://example.test|u1',status:'pending',retry_count:0,
      payload:{client_ref:'nullable-test',changes:{title:'Пер пионерский'},base_values:{title:''}}}],
  });
  const sync = runtime.context.window.v340Sync;
  assert.equal(sync.fieldValuesEquivalent('title','',null),true);
  assert.equal(sync.fieldValuesEquivalent('note_short',null,''),true);
  assert.equal(sync.fieldValuesEquivalent('note_full','Локально','Сервер'),false);
  assert.equal(sync.fieldValuesEquivalent('status','',null),false);
  let patchPayload = null;
  runtime.setApi(async (path,options) => {
    assert.equal(path,'/api/spreads/nullable-server');
    if (!options) return {spread:{id:'nullable-server',title:null,revision:2,deleted_at:null}};
    patchPayload = structuredClone(options.json);
    return {spread:{id:'nullable-server',number:26,title:'Пер пионерский',status:'Актуально',
      note_short:null,note_full:null,revision:3,current_photo_id:'server-photo',deleted_at:null}};
  });
  await runtime.context.pushEntityQueue(false);
  assert.equal(patchPayload.base_values.title,null,'empty base uses the exact fresh server representation');
  assert.equal(runtime.db.sync_queue.get(782).payload.base_values.title,'','stored queue backup remains unchanged');
  assert.equal(runtime.db.sync_queue.get(782).status,'done','queue closes only after confirmed PATCH');
  assert.equal(runtime.db.spreads.get('nullable-local').title,'Пер пионерский');
  assert.equal(runtime.db.spreads.get('nullable-local').current_photo_id,'photo-kept');

  const realConflict = createRuntime({
    settings:{team_capabilities:{scope:'https://example.test|u1',flags:{field_merge:true}}},
    spreads:[{id:'real-local',server_id:'real-server',notebook_id:'nb',title:'Моё',revision:2}],
    sync_queue:[{id:900,entity:'spread_fields',local_id:'real-local',server_id:'real-server',
      scope:'https://example.test|u1',status:'pending',retry_count:0,
      payload:{changes:{title:'Моё'},base_values:{title:''}}}],
  });
  let sentBase;
  realConflict.setApi(async (path,options) => {
    if (!options) return {spread:{id:'real-server',title:'Чужое',revision:3,deleted_at:null}};
    sentBase = options.json.base_values.title;
    const error = new Error('field_conflict'); error.status = 409;
    error.data = {conflicts:{title:{base:'',mine:'Моё',server:'Чужое'}}};
    throw error;
  });
  await realConflict.context.pushEntityQueue(false);
  assert.equal(sentBase,'','different nonempty server text must not be normalized away');
  assert.equal(realConflict.db.sync_queue.get(900).status,'conflict');
  assert.equal(realConflict.db.spreads.get('real-local').title,'Моё');
}

function repair367Fixture({serverContiguous = false} = {}) {
  const backend = 'https://blocknot-proxy.mastif1235.workers.dev';
  const localNotebookId = 'mtk0pu3k5wrwma';
  const serverNotebookId = '2225c8d5-ed4e-435f-93da-8d365c4fc112';
  const duplicatedId = '47eabd6b-abc0-4b9a-8ddf-c83980b36219';
  const serverSpreads = Array.from({length:50}, (_,index) => ({
    id:index === 0 ? duplicatedId : `order-server-${index + 1}`,
    client_ref:index === 0 ? 'mtk12qcznnzdex' : `order-local-${index + 1}`, notebook_id:serverNotebookId,
    number:serverContiguous || index < 31 ? index + 1 : index + 2,
    title:index === 0 ? '1-2' : `Order ${index + 1}`, status:'Актуально', note_short:null, note_full:null,
    revision:index === 0 ? 20 : index + 1, current_photo_id:null, deleted_at:null,
  }));
  const localSpreads = serverSpreads.map((row,index) => ({
    id:row.client_ref, server_id:row.id, notebook_id:localNotebookId, number:index + 1,
    title:row.title, status:row.status, note_short:null, note_full:null,
    revision:row.revision, current_photo_id:null, deleted_at:null,
  }));
  const brokenItems = serverSpreads.map((row,index) => ({spread_id:row.id, expected_revision:row.revision,
    expected_number:index < 31 ? index + 1 : index + 2}));
  brokenItems[brokenItems.length - 1].spread_id = duplicatedId;
  localSpreads.push({...localSpreads[0], id:duplicatedId});
  const fieldRepairs = [
    {queueId:782, localId:'mtwpwsgv6yctqj', serverId:'9204e6e2-040d-46cb-b57c-a5d122d145f7',
      number:26, mine:'Пер пионерский'},
    {queueId:783, localId:'mtwppwd4f7po1n', serverId:'22f7dbe6-f34a-4f68-ac66-d39909f686cc',
      number:8, mine:'Теплична'},
  ];
  const fieldServers = Object.fromEntries(fieldRepairs.map(repair => [repair.serverId, {
    id:repair.serverId, notebook_id:'8acccef3-4747-4bda-b7da-ad97fedf7d83', number:repair.number,
    title:null, status:'Актуально', note_short:null, note_full:null, revision:2,
    current_photo_id:`server-photo-${repair.queueId}`, client_ref:repair.localId, deleted_at:null,
  }]));
  localSpreads.push(...fieldRepairs.map(repair => ({
    id:repair.localId, server_id:repair.serverId, notebook_id:'mtwpkdb563vhqm', number:repair.number,
    title:repair.mine, status:'Актуально', note_short:null, note_full:null, revision:2,
    current_photo_id:`local-photo-${repair.queueId}`, deleted_at:null,
    fields_pending:true, field_conflicts:{title:{base:'', mine:repair.mine, server:null}},
  })));
  return {
    backend, localNotebookId, serverNotebookId, duplicatedId, serverSpreads, fieldRepairs, fieldServers,
    seed:{
      settings:{backend_url:backend, team_capabilities:{scope:`${backend}|u1`, flags:{spread_order:true, field_merge:true}}},
      notebooks:[{id:localNotebookId, server_id:serverNotebookId, title:'Notebook #367'},
        {id:'mtwpkdb563vhqm', server_id:'8acccef3-4747-4bda-b7da-ad97fedf7d83', title:'Field repairs'}],
      spreads:localSpreads,
      sync_queue:[{id:367, entity:'spread_order', local_id:localNotebookId, scope:`${backend}|u1`,
        status:'failed', retry_count:110, last_error:'invalid_order', payload:{client_ref:'broken-367', items:brokenItems}},
      ...fieldRepairs.map(repair => ({id:repair.queueId, entity:'spread_fields', local_id:repair.localId,
        server_id:repair.serverId, scope:`${backend}|u1`, status:'conflict', retry_count:0,
        last_error:'field_conflict', payload:{client_ref:`old-${repair.queueId}`, changes:{title:repair.mine},
          base_values:{title:''}}, conflicts:{conflicts:{title:{base:'', mine:repair.mine, server:null}},
          server_copy:structuredClone(fieldServers[repair.serverId])}}))],
    },
  };
}

function installRepair367Api(runtime, fixture, {serverContiguous = false} = {}) {
  let orderSpreads = structuredClone(fixture.serverSpreads);
  const fieldServers = structuredClone(fixture.fieldServers);
  const calls = [];
  runtime.setApi(async (path, options) => {
    calls.push({path, options:structuredClone(options)});
    if (path === `/api/notebooks/${fixture.serverNotebookId}/spreads`) return {spreads:structuredClone(orderSpreads)};
    const fieldRepair = fixture.fieldRepairs.find(repair => path === `/api/spreads/${repair.serverId}`);
    if (fieldRepair) {
      if (!options) return {spread:structuredClone(fieldServers[fieldRepair.serverId])};
      assert.equal(options.method, 'PATCH');
      assert.deepEqual(JSON.parse(JSON.stringify(options.json.changes)), {title:fieldRepair.mine});
      assert.equal(options.json.base_values.title, null, 'repair must use the fresh server null as optimistic base');
      const current = fieldServers[fieldRepair.serverId];
      fieldServers[fieldRepair.serverId] = {...current, title:fieldRepair.mine, revision:current.revision + 1};
      return {spread:structuredClone(fieldServers[fieldRepair.serverId])};
    }
    assert.equal(path, `/api/notebooks/${fixture.serverNotebookId}/spreads/order`);
    assert.equal(options.method, 'PUT');
    assert.equal(serverContiguous, false, 'already-correct order must not be written');
    assert.equal(options.json.client_ref, 'repair-spread-order-367-v1');
    assert.equal(options.json.items.length, 50);
    assert.equal(new Set(options.json.items.map(row => row.spread_id)).size, 50, 'fresh reorder cannot contain duplicate IDs');
    assert.notEqual(options.json.client_ref, 'broken-367', 'old payload identity cannot be reused');
    orderSpreads = options.json.items.map((item,index) => {
      const current = orderSpreads.find(row => row.id === item.spread_id);
      return {...current, number:index + 1, revision:current.revision + 1};
    });
    return {spreads:structuredClone(orderSpreads)};
  });
  return {calls, fieldServers};
}

async function testRepair367PreviewAndFreshReorder() {
  const fixture = repair367Fixture();
  const runtime = createRuntime(fixture.seed);
  const api = installRepair367Api(runtime,fixture);
  const before = structuredClone(Object.fromEntries(Object.entries(runtime.db).map(([key,value]) => [key,[...value.entries()]])));
  const preview = await runtime.context.window.v340Sync.buildRepair367Preview();
  assert.equal(preview.eligible, true);
  assert.equal(preview.notebook.local_id, fixture.localNotebookId);
  assert.equal(preview.notebook.server_id, fixture.serverNotebookId);
  assert.equal(preview.comparison.server_has_legacy_gap_32, true);
  assert.equal(preview.comparison.action, 'fresh_reorder_then_retire');
  assert.equal(preview.comparison.local_rows_before, 51);
  assert.equal(preview.comparison.local_rows_after_legacy_retire, 50);
  assert.equal(preview.comparison.legacy_reference_count, 0);
  assert.equal(preview.backup.canonical_spread.id, 'mtk12qcznnzdex');
  assert.equal(preview.backup.legacy_spread.id, fixture.duplicatedId);
  assert.equal(preview.backup.queue_367.id, 367);
  assert.equal(api.calls.filter(call => call.options).length, 0, 'Preview must be GET-only');
  const afterPreview = structuredClone(Object.fromEntries(Object.entries(runtime.db).map(([key,value]) => [key,[...value.entries()]])));
  assert.deepEqual(afterPreview, before, 'Preview must not mutate local data');
  const result = await runtime.context.window.v340Sync.applyRepair367(preview.guard);
  assert.equal(result.completed, true);
  assert.equal(result.action, 'fresh_reorder_then_retire');
  assert.equal(api.calls.filter(call => call.options?.method === 'PUT').length, 1);
  assert.equal(api.calls.filter(call => call.options?.method === 'PATCH').length, 2);
  assert.equal(runtime.db.sync_queue.get(367).status, 'done');
  assert.equal(runtime.db.sync_queue.get(782).status, 'done');
  assert.equal(runtime.db.sync_queue.get(783).status, 'done');
  assert.equal(runtime.db.spreads.size, 52);
  assert.equal(runtime.db.spreads.has(fixture.duplicatedId), false);
  assert.equal(runtime.db.spreads.has('mtk12qcznnzdex'), true);
  for (const repair of fixture.fieldRepairs) {
    const local = runtime.db.spreads.get(repair.localId);
    assert.equal(local.title, repair.mine);
    assert.equal(local.revision, 3);
    assert.equal(local.current_photo_id, `local-photo-${repair.queueId}`);
  }
  assert.equal(runtime.db.photos.size, 0);
  assert.equal(runtime.db.blobs.size, 0);
}

async function testRepair367RetiresWithoutWriteWhenServerAlreadyCorrect() {
  const fixture = repair367Fixture({serverContiguous:true});
  const runtime = createRuntime(fixture.seed);
  const api = installRepair367Api(runtime,fixture,{serverContiguous:true});
  const preview = await runtime.context.window.v340Sync.buildRepair367Preview();
  assert.equal(preview.eligible, true);
  assert.equal(preview.comparison.action, 'retire_only');
  const result = await runtime.context.window.v340Sync.applyRepair367(preview.guard);
  assert.equal(result.action, 'retire_only');
  assert.equal(api.calls.filter(call => call.options?.method === 'PUT').length, 0);
  assert.equal(api.calls.filter(call => call.options?.method === 'PATCH').length, 2);
  assert.equal(runtime.db.sync_queue.get(367).status, 'done');
}

async function testRepair367StopsOnAmbiguousMapping() {
  const fixture = repair367Fixture();
  fixture.seed.spreads.pop();
  const runtime = createRuntime(fixture.seed);
  let mutations = 0;
  runtime.setApi(async (path, options) => {
    if (options) mutations++;
    return {spreads:structuredClone(fixture.serverSpreads)};
  });
  const preview = await runtime.context.window.v340Sync.buildRepair367Preview();
  assert.equal(preview.eligible, false);
  await assert.rejects(runtime.context.window.v340Sync.applyRepair367(preview.guard), /ничего не применено/);
  assert.equal(mutations, 0);
  assert.equal(runtime.db.sync_queue.get(367).status, 'failed');
}

async function testRepair367StopsWhenLegacyHasAReference() {
  const fixture = repair367Fixture();
  fixture.seed.photos = [{id:'legacy-photo', spread_id:fixture.duplicatedId, upload_status:'synced'}];
  const runtime = createRuntime(fixture.seed);
  let mutations = 0;
  runtime.setApi(async (path, options) => {
    if (options) mutations++;
    return {spreads:structuredClone(fixture.serverSpreads)};
  });
  const preview = await runtime.context.window.v340Sync.buildRepair367Preview();
  assert.equal(preview.eligible, false);
  assert.equal(preview.comparison.legacy_reference_count, 1);
  assert.equal(preview.backup.legacy_references.photos[0].id, 'legacy-photo');
  await assert.rejects(runtime.context.window.v340Sync.applyRepair367(preview.guard), /ничего не применено/);
  assert.equal(mutations, 0);
  assert.equal(runtime.db.spreads.has(fixture.duplicatedId), true);
  assert.equal(runtime.db.photos.has('legacy-photo'), true);
}

await testRepair910PreviewIsReadOnly();
await testRepair910ApplyTouchesOnly286And287();
await testRepair910StopsIfStateChangesAfterPreview();
await testNullableTextConflictNormalization();
await testRepair367PreviewAndFreshReorder();
await testRepair367RetiresWithoutWriteWhenServerAlreadyCorrect();
await testRepair367StopsOnAmbiguousMapping();
await testRepair367StopsWhenLegacyHasAReference();

console.log('sync-safety: PASS (push/session isolation, backfill retry, cursor durability, orphan recovery, diagnostics, repairs 9-10/#367)');
