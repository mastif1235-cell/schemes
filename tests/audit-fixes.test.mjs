// AUDIT FIXES regression tests (F1–F7, F10) in real Chromium against the production runtime.
// A synthetic in-page backend replaces the Worker; no production service is touched.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {resolve, extname} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
const {chromium} = await import(process.env.PLAYWRIGHT_MODULE_PATH ? pathToFileURL(process.env.PLAYWRIGHT_MODULE_PATH).href : 'playwright');
const root = fileURLToPath(new URL('../', import.meta.url));
const server = createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const file = resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
  if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
  try {
    res.setHeader('Content-Type', ({'.html':'text/html','.js':'text/javascript','.json':'application/json','.txt':'text/plain','.svg':'image/svg+xml'})[extname(file)] || 'application/octet-stream');
    res.end(readFileSync(file));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({headless:true, ...(process.env.CHROME_PATH ? {executablePath:process.env.CHROME_PATH} : {})});
  const context = await browser.newContext({viewport:{width:412,height:915}, isMobile:true, hasTouch:true, serviceWorkers:'block'});
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());

  // Synthetic backend state, controlled per scenario.
  const apiState = {spreads:{}, notebooks:{}, log:[], dropNextRestore:false, online:true, oldWorker:false, photoAttempts:0};
  await page.route(origin + '/api/**', async route => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    const path = url.pathname;
    if (!apiState.online) return route.abort();
    apiState.log.push(method + ' ' + path);
    const J = (o, status=200) => route.fulfill({status, contentType:'application/json', body:JSON.stringify(o)});
    if (path === '/api/me') return J({user:{id:'u1', display_name:'U'}, devices:[],
      capabilities:{field_merge:true, team_notes:true, spread_order:true}});
    if (path === '/api/notebooks' && method === 'GET') {
      while (apiState.holdMembership) await new Promise(r => setTimeout(r, 25));
      return J({notebooks:Object.values(apiState.notebooks).filter(nb => !nb.deleted_at)});
    }
    let m = path.match(/^\/api\/spreads\/([^/]+)$/);
    if (m && method === 'DELETE') {
      const sp = apiState.spreads[m[1]];
      if (!sp) return J({error:'not_found'}, 404);
      sp.deleted_at = '2026-09-24T10:00:00.000Z'; return J({ok:true});
    }
    if (m && method === 'PATCH') {
      const sp = apiState.spreads[m[1]];
      if (!sp) return J({error:'not_found'}, 404);
      const body = JSON.parse(route.request().postData() || '{}');
      Object.assign(sp, {title:body.title ?? sp.title, note_short:body.note_short ?? sp.note_short,
        revision:(sp.revision || 1) + 1, updated_at:'2026-09-25T00:00:00.000Z'});
      return J({spread:sp});
    }
    m = path.match(/^\/api\/spreads\/([^/]+)\/restore$/);
    if (m && method === 'POST') {
      if (apiState.oldWorker) return J({error:'no_such_route'}, 404); // v3.5.9 worker: no such route
      if (apiState.dropNextRestore) { apiState.dropNextRestore = false; return route.abort(); } // lost response
      const sp = apiState.spreads[m[1]];
      if (!sp) return J({error:'not_found'}, 404);
      const restored = !!sp.deleted_at;
      sp.deleted_at = null; sp.revision = (sp.revision || 1) + (restored ? 1 : 0);
      return J({spread:sp, restored});
    }
    m = path.match(/^\/api\/notebooks\/([^/]+)$/);
    if (m && method === 'DELETE') {
      const nb = apiState.notebooks[m[1]];
      if (!nb) return J({error:'not_found'}, 404);
      nb.deleted_at = '2026-09-24T10:00:00.000Z'; return J({ok:true});
    }
    m = path.match(/^\/api\/notebooks\/([^/]+)\/restore$/);
    if (m && method === 'POST') {
      if (apiState.oldWorker) return J({error:'no_such_route'}, 404);
      const nb = apiState.notebooks[m[1]];
      if (!nb) return J({error:'not_found'}, 404);
      const restored = !!nb.deleted_at;
      nb.deleted_at = null; nb.revision = (nb.revision || 1) + (restored ? 1 : 0);
      return J({notebook:nb, restored});
    }
    if (path === '/api/sync') {
      return J({changes:{notebooks:Object.values(apiState.notebooks), spreads:Object.values(apiState.spreads)},
        next_cursor:100, has_more:false});
    }
    return J({error:'unexpected ' + method + ' ' + path}, 500);
  });
  await page.goto(origin + '/');
  await page.waitForFunction(() => typeof openDB === 'function' && typeof fullSync === 'function');

  await page.evaluate(async backend => {
    await openDB();
    const scope = backend + '|u1';
    await put('settings', {key:'app', theme:'light', backend_url:backend, auth_token:'t', user_id:'u1',
      sync_cursor:0, known_notebook_ids:[], sync_status:'idle', last_sync_at:null,
      keep_originals_offline:true, keep_old_photos_policy:'none', default_search_scope:'current',
      team_capabilities:{scope, flags:{}}});
    settings = await get('settings', 'app');
    await put('notebooks', {id:'nb1', server_id:'srv-nb1', title:'NB', description:'', archived:false, sort_order:0,
      created_at:'2026-09-20T00:00:00.000Z', updated_at:'2026-09-20T00:00:00.000Z', deleted_at:null, revision:1});
  }, origin);
  apiState.notebooks['srv-nb1'] = {id:'srv-nb1', title:'NB', description:null, archived:0, sort_order:0,
    revision:1, deleted_at:null, updated_at:'2026-09-20T00:00:00.000Z', created_at:'2026-09-20T00:00:00.000Z'};

  // helper injected once: perform the same atomic delete the viewer button does
  await page.evaluate(() => {
    window.__testDeleteSpread = async spreadId => {
      const queue = await getAll('sync_queue');
      const photoIds = new Set((await getAll('photos')).filter(row => row.spread_id === spreadId).map(row => row.id));
      const retired = queue.filter(item => ['pending','syncing','failed','conflict','blocked'].includes(item.status)
          && ((item.entity === 'spread' && item.local_id === spreadId) || (item.entity === 'photo' && photoIds.has(item.photo_id))))
        .map(item => ({...item, status:'done', last_error:'superseded by local spread delete'}));
      await window.vNextAtomic('spreads', spreadId, current => {
        const now = nowISO();
        return {row:{...current, deleted_at:current.deleted_at || now, favorite:false, updated_at:now},
          item:{entity:'spread', local_id:spreadId, status:'pending', retry_count:0, payload:{op:'delete'}},
          retired};
      });
    };
    window.__apiLog = [];
    // App-internal scheduling (background sync, one-shot reload guard) can make a direct
    // fullSync() call a no-op; retry calls until the predicate holds, like a user would.
    window.__syncUntil = async (predicate, timeoutMs = 10000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        await fullSync(true);
        if (await predicate()) return true;
        await new Promise(r => setTimeout(r, 120));
      }
      return predicate();
    };
    window.__queueDone = async () => (await getAll('sync_queue')).every(q => q.status === 'done');
  });

  // ---------- Scenario A: delete → restore BEFORE sync → sync (original F1 POC chain) ----------
  apiState.spreads['srv-spA'] = {id:'srv-spA', notebook_id:'srv-nb1', number:1, title:'victim A', revision:3,
    deleted_at:null, updated_at:'2026-09-20T00:00:00.000Z', created_at:'2026-09-01T00:00:00.000Z', current_photo_id:null};
  let result = await page.evaluate(async () => {
    await put('spreads', {id:'spA', server_id:'srv-spA', notebook_id:'nb1', number:1, title:'victim A',
      status:'Актуально', favorite:false, current_photo_id:null, created_at:'2026-09-20T00:00:00.000Z',
      updated_at:'2026-09-20T00:00:00.000Z', deleted_at:null, revision:3});
    await window.__testDeleteSpread('spA');                    // user deletes (goes offline etc.)
    await window.vNextSync.restoreFromTrash('spread', 'spA');  // ...and restores from trash before sync
    const sp = await get('spreads', 'spA');
    const queue = await getAll('sync_queue');
    return {deleted_at:sp.deleted_at, queue:[...queue.map(q => ({op:q.payload?.op || null, status:q.status}))]};
  });
  const drainedA = await page.evaluate(() => window.__syncUntil(() => window.__queueDone()));
  if (!drainedA) {
    console.error('DEBUG queue:', JSON.stringify(await page.evaluate(async () => (await getAll('sync_queue')).map(q => ({op:q.payload?.op||null,status:q.status,err:q.last_error})))));
    console.error('DEBUG page errors:', JSON.stringify(errors));
  }
  assert.ok(drainedA, 'queue fully drained after restore+sync');
  result = await page.evaluate(async () => ({deleted_at:(await get('spreads','spA')).deleted_at,
    queue:(await getAll('sync_queue')).map(q => ({op:q.payload?.op || null, status:q.status}))}));
  assert.equal(result.deleted_at, null, 'F1: restored spread survives the sync (was re-deleted before the fix)');
  assert.ok(result.queue.length >= 2 && result.queue.every(q => q.status === 'done'), 'queue fully drained');
  assert.ok(!apiState.log.some(line => line.startsWith('DELETE /api/spreads/srv-spA')), 'retired pending delete never reaches the server');
  assert.ok(apiState.log.some(line => line === 'POST /api/spreads/srv-spA/restore'), 'restore op reaches the server');
  assert.equal(apiState.spreads['srv-spA'].deleted_at, null);

  // ---------- Scenario B: delete → sync → restore → sync; lost response; reload persistence ----
  apiState.spreads['srv-spB'] = {id:'srv-spB', notebook_id:'srv-nb1', number:2, title:'victim B', revision:2,
    deleted_at:null, updated_at:'2026-09-20T00:00:00.000Z', created_at:'2026-09-01T00:00:00.000Z', current_photo_id:null};
  result = await page.evaluate(async () => {
    await put('spreads', {id:'spB', server_id:'srv-spB', notebook_id:'nb1', number:2, title:'victim B',
      status:'Актуально', favorite:false, current_photo_id:null, created_at:'2026-09-20T00:00:00.000Z',
      updated_at:'2026-09-20T00:00:00.000Z', deleted_at:null, revision:2});
    await window.__testDeleteSpread('spB');
    await window.__syncUntil(async () => (await getAll('sync_queue')).every(q => q.status === 'done')); // delete reaches the server, pull applies the tombstone
    return {deleted_at:(await get('spreads','spB')).deleted_at};
  });
  assert.ok(result.deleted_at, 'synced delete leaves the tombstone locally');
  assert.ok(apiState.spreads['srv-spB'].deleted_at, 'server tombstoned');
  // restore with one lost response on the way
  apiState.dropNextRestore = true;
  result = await page.evaluate(async () => {
    await window.vNextSync.restoreFromTrash('spread', 'spB');
    return {queue:(await getAll('sync_queue')).map(q => ({local_id:q.local_id, op:q.payload?.op||null, status:q.status}))};
  });
  const restoreItem = result.queue.find(q => q.op === 'restore' && q.local_id === 'spB');
  assert.ok(['pending','failed'].includes(restoreItem.status), 'lost restore response keeps the op retryable (transient)');
  result = await page.evaluate(async () => {
    await window.__syncUntil(async () => (await getAll('sync_queue')).every(q => q.status === 'done')); // manual sync retries immediately
    const sp = await get('spreads', 'spB');
    return {deleted_at:sp.deleted_at, revision:sp.revision,
      queueDone:(await getAll('sync_queue')).every(q => q.status === 'done')};
  });
  assert.equal(result.deleted_at, null, 'restore survives retry after lost response');
  assert.equal(result.revision, 3, 'revision follows the restored server row (2+1)');
  assert.equal(result.queueDone, true);
  assert.equal(apiState.spreads['srv-spB'].deleted_at, null);
  const restoreCalls = apiState.log.filter(line => line === 'POST /api/spreads/srv-spB/restore').length;
  assert.ok(restoreCalls >= 1);

  // reload → sync must not resurrect the deletion (durable after restart)
  await page.reload();
  await page.waitForFunction(() => typeof openDB === 'function' && typeof fullSync === 'function');
  await page.evaluate(() => {
    window.__syncUntil = async (predicate, timeoutMs = 10000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        await fullSync(true);
        if (await predicate()) return true;
        await new Promise(r => setTimeout(r, 120));
      }
      return predicate();
    };
    window.__testDeleteSpread = async spreadId => {
      const queue = await getAll('sync_queue');
      const photoIds = new Set((await getAll('photos')).filter(row => row.spread_id === spreadId).map(row => row.id));
      const retired = queue.filter(item => ['pending','syncing','failed','conflict','blocked'].includes(item.status)
          && ((item.entity === 'spread' && item.local_id === spreadId) || (item.entity === 'photo' && photoIds.has(item.photo_id))))
        .map(item => ({...item, status:'done', last_error:'superseded by local spread delete'}));
      await window.vNextAtomic('spreads', spreadId, current => {
        const now = nowISO();
        return {row:{...current, deleted_at:current.deleted_at || now, favorite:false, updated_at:now},
          item:{entity:'spread', local_id:spreadId, status:'pending', retry_count:0, payload:{op:'delete'}},
          retired};
      });
    };
  });
  result = await page.evaluate(async () => {
    await openDB();
    settings = await get('settings', 'app');
    await window.__syncUntil(async () => true, 3000); // one pull-round
    return {deleted_at:(await get('spreads','spB')).deleted_at};
  });
  assert.equal(result.deleted_at, null, 'restore persists across reload + sync');

  // repeat restore is a no-op
  result = await page.evaluate(async () => ({ok:await window.vNextSync.restoreFromTrash('spread', 'spB')}));
  assert.equal(result.ok, false, 'repeat restore is idempotent on the client');

  // ---------- Scenario C: notebook delete offline → reconnect; pull must not resurrect ----------
  apiState.online = false;
  result = await page.evaluate(async () => {
    const ok = await window.vNextSync.deleteNotebookToTrash('nb1'); // while the network is down
    return {ok, nb:await get('notebooks','nb1'), queue:(await getAll('sync_queue')).map(q => ({entity:q.entity, op:q.payload?.op||null, status:q.status}))};
  });
  if (!result.nb.deleted_at) {
    console.error('DEBUG C:', JSON.stringify({ok:result.ok, nb:result.nb, queue:result.queue}), 'errors:', JSON.stringify(errors));
  }
  assert.ok(result.nb.deleted_at, 'notebook tombstoned locally');
  assert.ok(result.queue.some(q => q.entity === 'notebook' && q.op === 'delete' && q.status === 'pending'), 'delete op persisted while offline');
  apiState.online = true;
  result = await page.evaluate(async () => {
    await window.__syncUntil(async () => (await getAll('sync_queue')).every(q => q.status === 'done'));
    return {nb:await get('notebooks','nb1'), serverListed:null};
  });
  assert.ok(apiState.log.some(line => line === 'DELETE /api/notebooks/srv-nb1'), 'queued notebook delete reaches the server after reconnect');
  assert.ok(result.nb.deleted_at, 'local notebook stays deleted after sync');
  // and restore brings it back through the outbox as well
  result = await page.evaluate(async () => {
    await window.vNextSync.restoreFromTrash('notebook', 'nb1');
    await window.__syncUntil(async () => (await getAll('sync_queue')).every(q => q.status === 'done'));
    return {deleted_at:(await get('notebooks','nb1')).deleted_at};
  });
  assert.equal(result.deleted_at, null, 'notebook restore syncs and survives the pull');
  assert.ok(apiState.log.some(line => line === 'POST /api/notebooks/srv-nb1/restore'), 'notebook restore reaches the server');
  assert.equal(apiState.notebooks['srv-nb1'].deleted_at, null);

  // ---------- F3 race: in-flight membership refresh must not clobber a local delete ----------
  apiState.holdMembership = true;
  result = await page.evaluate(async () => {
    const syncRun = fullSync(); // starts with a held membership request
    await new Promise(r => setTimeout(r, 300)); // membership fetch is in flight now
    await window.vNextSync.deleteNotebookToTrash('nb1');
    return {deleted_at:(await get('notebooks','nb1')).deleted_at, syncRun};
  });
  assert.ok(result.deleted_at, 'tombstone set locally while membership was held');
  apiState.holdMembership = false; // release the stale membership response
  await page.evaluate(syncRun => syncRun, result.syncRun);
  result = await page.evaluate(async () => ({deleted_at:(await get('notebooks','nb1')).deleted_at}));
  assert.ok(result.deleted_at, 'stale membership response does not resurrect the notebook');
  // clean up: sync the delete and restore the notebook for the following scenarios
  await page.evaluate(() => window.__syncUntil(async () => (await getAll('sync_queue')).every(q => q.status === 'done')));
  await page.evaluate(async () => {
    await window.vNextSync.restoreFromTrash('notebook', 'nb1');
    await window.__syncUntil(async () => (await getAll('sync_queue')).every(q => q.status === 'done'));
  });

  // ---------- F10: permanent 413 blocks a photo op; retry only manual ----------
  result = await page.evaluate(async () => {
    await put('photos', {id:'phX', spread_id:'spA', version:1, is_current:true, upload_status:'local_pending', created_at:nowISO()});
    await put('blobs', {id:'phX_orig', blob:new Blob([new Uint8Array(100)])});
    await put('sync_queue', {entity:'photo', photo_id:'phX', status:'pending', retry_count:0});
    return true;
  });
  const tooLargeHandler = route => {
    apiState.photoAttempts++;
    return route.fulfill({status:413, contentType:'application/json', body:'{"error":"too_large"}'});
  };
  await page.route(origin + '/api/spreads/srv-spA/photos', tooLargeHandler); // later registration wins
  result = await page.evaluate(async () => {
    await window.__syncUntil(async () => {
      const item = (await getAll('sync_queue')).find(q => q.photo_id === 'phX');
      return item && (item.status === 'blocked' || item.status === 'done');
    });
    const queue = await getAll('sync_queue');
    const item = queue.find(q => q.photo_id === 'phX');
    return {status:item.status, reason:item.blocked_reason || null,
      photo:(await get('photos','phX')).upload_status, blob:!!(await get('blobs','phX_orig'))};
  });
  assert.equal(result.status, 'blocked', '413 blocks instead of infinite retry');
  assert.equal(result.reason, 'too_large');
  assert.equal(result.blob, true, 'original blob stays local');
  // Review D: a manual sync retries the blocked op exactly once per pass, then parks again.
  // If the classification were wrong, this would spin the upload in a tight loop.
  apiState.photoAttempts = 0;
  let oneShotDelta = 0;
  for (let i = 0; i < 3 && oneShotDelta < 1; i++) {
    const before = apiState.photoAttempts;
    await page.evaluate(() => fullSync(true));
    oneShotDelta = apiState.photoAttempts - before;
    if (oneShotDelta < 1) await page.waitForTimeout(250);
  }
  assert.equal(oneShotDelta, 1, 'one manual sync = exactly one retry attempt, then blocked again');
  result = await page.evaluate(async () => ({status:(await getAll('sync_queue')).find(q => q.photo_id === 'phX').status}));
  assert.equal(result.status, 'blocked', '413 again parks the op instead of looping');
  await page.unroute(origin + '/api/spreads/srv-spA/photos', tooLargeHandler);

  // ---------- F4: without auth no upload attempt happens ----------
  result = await page.evaluate(async () => {
    settings.auth_token = null;
    await saveSettings();
    const before = JSON.stringify((await getAll('sync_queue')).filter(q => q.entity === 'photo').map(q => q.status));
    await pushPhotoQueue(false);
    const after = JSON.stringify((await getAll('sync_queue')).filter(q => q.entity === 'photo').map(q => q.status));
    settings.auth_token = 't'; await saveSettings();
    return {before, after, photo:(await get('photos','phX')).upload_status};
  });
  assert.equal(result.before, result.after, 'queue untouched without auth');
  assert.notEqual(result.photo, 'synced');
  await page.evaluate(async () => {
    for (const q of await getAll('sync_queue')) if (q.photo_id === 'phX') await del('sync_queue', q.id);
    await del('photos', 'phX');
  });

  // ---------- F5: export never contains credentials ----------
  result = await page.evaluate(async () => {
    const originalCreate = URL.createObjectURL;
    let captured = null;
    URL.createObjectURL = blob => { captured = blob; return 'blob:stub'; };
    try { await exportBackup(); } finally { URL.createObjectURL = originalCreate; }
    const data = JSON.parse(await captured.text());
    return {settings:data.settings, hasQueue:Array.isArray(data.sync_queue)};
  });
  const exportedSettings = result.settings[0] || {};
  assert.ok(!('auth_token' in exportedSettings), 'auth_token is stripped from exported settings');
  assert.ok(!Object.keys(exportedSettings).some(key => /token|secret|session/i.test(key)),
    'no token/secret/session-shaped fields at all');
  assert.equal(result.hasQueue, true, 'queue still exported for diagnostics');

  // ---------- F6: safe import ----------
  result = await page.evaluate(async () => {
    const messages = [];
    const oldToast = window.toast, oldConfirm = window.confirmAction;
    window.toast = msg => messages.push(String(msg));
    // confirmAction is fire-and-forget for the caller: capture the yes-callback and run it.
    window.confirmAction = (msg, fn) => { window.__pendingImport = fn; };
    try {
      await importBackup(new File(['{not valid json'], 'bad.json', {type:'application/json'}));
      await window.__pendingImport();
      const badToast = messages.at(-1);
      messages.length = 0;
      // valid file: duplicates + stale queue + stale settings + older spread copy
      const fresh = await get('spreads', 'spA');
      fresh.updated_at = '2026-09-24T20:00:00.000Z'; fresh.title = 'Новая правка';
      await put('spreads', fresh);
      const payload = {
        notebooks:[{id:'nb1', server_id:'srv-nb1', title:'Старое имя', updated_at:'2026-09-10T00:00:00.000Z'}],
        spreads:[{...fresh, title:'Устаревшая копия', updated_at:'2026-09-01T00:00:00.000Z'}],
        photos:[{id:'photo-existing',server_id:'old-photo',upload_status:'local_pending',is_current:false,
          telegram_message_id:null,telegram_link:null}], tags:[{id:'tag-imp1', name:'импорт'}],
        spread_tags:[{id:999, spread_id:'spA', tag_id:'tag-imp1'}, {id:998, spread_id:'spA', tag_id:'tag-imp1'}],
        history:[{id:55, spread_id:'spA', action:'X', timestamp:'2026-09-01T00:00:00.000Z'},
                 {id:56, spread_id:'spA', action:'X', timestamp:'2026-09-01T00:00:00.000Z'}],
        sync_queue:[{id:777, entity:'spread', local_id:'spA', status:'pending', retry_count:0, payload:{op:'delete'}}],
        settings:[{key:'app', auth_token:'STOLEN'}]
      };
      await put('photos',{id:'photo-existing',server_id:'new-photo',upload_status:'synced',is_current:true,
        telegram_message_id:123,telegram_link:'https://t.me/example/123'});
      await importBackup(new File([JSON.stringify(payload)], 'ok.json', {type:'application/json'}));
      await window.__pendingImport();
      const okToast = messages.at(-1);
      const queueIds = (await getAll('sync_queue')).map(q => q.id);
      const links = (await getAll('spread_tags')).filter(l => l.spread_id === 'spA' && l.tag_id === 'tag-imp1');
      const hist = (await getAll('history')).filter(h => h.spread_id === 'spA' && h.action === 'X');
      return {badToast, okToast,
        queueHas777:queueIds.includes(777),
        linkCount:links.length, linkHasBackupId:links.some(l => l.id === 999),
        histCount:hist.length,
        spreadTitle:(await get('spreads','spA')).title,
        nbTitle:(await get('notebooks','nb1')).title,
        settingsToken:(await get('settings','app')).auth_token,
        photo:(await get('photos','photo-existing'))};
    } finally { window.toast = oldToast; window.confirmAction = oldConfirm; }
  });
  assert.match(result.badToast, /повреждён|JSON/i, 'corrupted file shows an error toast');
  assert.equal(result.queueHas777, false, 'sync_queue from backup is never re-imported');
  assert.equal(result.linkCount, 1, 'spread_tags deduplicated by natural key');
  assert.equal(result.linkHasBackupId, false, 'backup autoincrement ids are not reused');
  assert.equal(result.histCount, 1, 'history deduplicated');
  assert.equal(result.spreadTitle, 'Новая правка', 'fresher local row wins over older backup copy');
  assert.equal(result.nbTitle, 'NB', 'fresher local notebook row wins over older backup copy');
  assert.equal(result.settingsToken, 't', 'credentials are never restored from a file');
  assert.deepEqual({server_id:result.photo.server_id,upload_status:result.photo.upload_status,
    is_current:result.photo.is_current,telegram_message_id:result.photo.telegram_message_id,
    telegram_link:result.photo.telegram_link},
    {server_id:'new-photo',upload_status:'synced',is_current:true,telegram_message_id:123,
      telegram_link:'https://t.me/example/123'}, 'old photo backup cannot overwrite current server metadata');

  // ---------- F2: escaping of server-controlled values in list rendering ----------
  result = await page.evaluate(async () => {
    window.__xssFired = 0;
    await put('spreads', {id:'spX', server_id:'srv-spX', notebook_id:'nb1', number:'1<img src=x onerror="window.__xssFired++">',
      title:'x', status:'Ок<script>window.__xssFired++</script>', favorite:false, current_photo_id:null,
      created_at:'2026-09-20T00:00:00.000Z', updated_at:'2026-09-20T00:00:00.000Z', deleted_at:null, revision:1});
    route = {screen:'spreads', notebookId:'nb1'};
    await render();
    const card = document.querySelector('.spread-grid .spread-card');
    const num = [...document.querySelectorAll('.spread-grid .spread-card .num')].map(el => el.textContent)
      .find(text => text.includes('<img'));
    return {xss:window.__xssFired, numLiteral:num || null, cardHtml:card ? card.innerHTML.slice(0, 400) : null};
  });
  assert.equal(result.xss, 0, 'payload never executes');
  assert.ok(result.numLiteral, 'number renders as literal escaped text');
  assert.ok(!result.cardHtml.includes('<img src=x onerror'), 'no raw HTML from number/status in card markup');

  // ---------- F7: photo retention is strictly OPT-IN (never on plain upgrade) ----------
  result = await page.evaluate(async () => {
    const currentScope = settings.backend_url.replace(/\/$/, '') + '|' + settings.user_id;
    await put('notebooks', {...await get('notebooks','nb1'),scope:currentScope});
    await put('spreads', {id:'spR', server_id:'srv-spR', notebook_id:'nb1', number:9, title:'ret',
      status:'Актуально', deleted_at:null, current_photo_id:'phCur', revision:1,scope:currentScope});
    const mk = (id, version, current, status, server_id) => ({id, spread_id:'spR', version, is_current:current,
      upload_status:status, server_id, scope:currentScope,created_at:'2026-09-01T00:00:00.000Z'});
    await put('photos', mk('phCur', 4, true, 'synced', 'srv-phCur'));
    await put('photos', mk('phV3', 3, false, 'synced', 'srv-phV3'));
    await put('photos', mk('phV2', 2, false, 'synced', 'srv-phV2'));
    await put('photos', mk('phBusy', 1, false, 'local_pending', null)); // still pending upload
    for (const id of ['phCur','phV3','phV2','phBusy']) {
      await put('blobs', {id:id+'_orig', blob:new Blob(['orig-'+id])});
      await put('blobs', {id:id+'_thumb', blob:new Blob(['thumb-'+id])});
    }
    await put('sync_queue', {entity:'photo', photo_id:'phBusy', status:'pending', retry_count:0});
    // instrument every prune invocation (own calls + possible background hook)
    window.__pruneCalls = [];
    const origPrune = window.v340PruneOldPhotos;
    window.v340PruneOldPhotos = async (...a) => {
      const r = await origPrune(...a);
      window.__pruneCalls.push({force:!!(a[0]||{}).force, r});
      return r;
    };
    const has = async id => !!(await get('blobs', id));
    const snap = async () => ({cur:await has('phCur_orig'), v3:await has('phV3_orig'), v2:await has('phV2_orig'),
      busy:await has('phBusy_orig'), thumb:await has('phV2_thumb')});

    // 1) plain upgrade: existing user, old dead default 'none', opt-in marker never set
    delete settings.photo_retention_configured;
    delete settings.photo_retention_scopes;
    settings.keep_old_photos_policy = 'none';
    await saveSettings();
    const upgrade = await window.v340PruneOldPhotos({force:true});
    const afterUpgrade = await snap();
    // 2) existing user + successful sync: the post-sync hook must also delete nothing
    await window.__syncUntil(async () => true, 2000); // real sync incl. the retention hook
    const afterSync = await snap();

    // 3) explicit choice via the real settings select (the UI wiring sets the opt-in marker)
    // The product-side post-sync hook may legitimately beat the measurement below; count
    // pruning via the instrumented total, not the single call's return value.
    const last1Span = [window.__pruneCalls.length];
    await renderSettings();
    const selPolicyEl = document.querySelector('#selPolicy');
    selPolicyEl.value = 'last1';
    selPolicyEl.dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 120));
    const markerAfterSelect = !!settings.photo_retention_configured &&
      settings.photo_retention_scopes?.[currentScope]?.policy === 'last1';
    // deterministic: the settings-select race with the post-sync hook is excluded by
    // pre-setting the daily throttle timestamp right before each forced run
    const pruneDeterministic = async policy => {
      settings.keep_old_photos_policy = policy;
      settings.photo_retention_scopes[currentScope] = {policy,last_at:nowISO()}; // hook skips today
      await saveSettings();
      return window.v340PruneOldPhotos({force:true});
    };
    const last1 = await pruneDeterministic('last1');
    last1Span.push(window.__pruneCalls.length);
    const afterLast1 = await snap();
    // 4) explicit Last 3 afterwards: everything now fits the keep limit
    const last3More = await pruneDeterministic('last3');
    const afterLast3 = await snap();
    // 5) explicit None: old synced originals go; current/pending/blocked/failed never; thumbs stay
    const busyItem = (await getAll('sync_queue')).find(q => q.photo_id === 'phBusy');
    busyItem.status = 'blocked'; await put('sync_queue', busyItem);
    const noneRun = await pruneDeterministic('none');
    const afterNone = await snap();
    busyItem.status = 'failed'; await put('sync_queue', busyItem);
    const noneAgain = await pruneDeterministic('none');
    const afterFail = await snap();
    // 6) explicit All never deletes anything, even after opt-in
    const allRun = await pruneDeterministic('all');
    const afterAll = await snap();
    // test fixture cleanup so later drain-style waits stay photo-free
    await del('sync_queue', busyItem.id);
    await del('photos', 'phBusy');
    return {upgrade, afterUpgrade, afterSync, markerAfterSelect,
      last1, afterLast1, last1Span, last3More, afterLast3, noneRun, afterNone, noneAgain, afterFail, allRun, afterAll, pruneLog:window.__pruneCalls};
  });
  assert.equal(result.upgrade.pruned, 0, 'upgrade with the old default prunes nothing');
  assert.equal(result.upgrade.notOptedIn, true, 'prune reports opt-in required');
  assert.deepEqual(result.afterUpgrade, {cur:true, v3:true, v2:true, busy:true, thumb:true},
    'existing local blobs untouched on upgrade');
  assert.deepEqual(result.afterSync, {cur:true, v3:true, v2:true, busy:true, thumb:true},
    'existing local blobs untouched after a successful sync');
  assert.equal(result.markerAfterSelect, true, 'settings select sets the explicit opt-in marker');
  const prunedSum = span => result.pruneLog.slice(span[0], span[1]).reduce((n, c) => n + (c.r.pruned || 0), 0);
  assert.equal(prunedSum(result.last1Span), 1,
    'explicit Last 1 prunes exactly the overflow, exactly once (counter includes the sync hook if it fired)');
  assert.deepEqual(result.afterLast1, {cur:true, v3:true, v2:false, busy:true, thumb:true},
    'Last 1 keeps current + newest old version + pending photo');
  assert.equal(result.last3More.pruned, 0, 'explicit Last 3 no-ops once the limit fits');
  assert.deepEqual(result.afterLast3, result.afterLast1);
  assert.equal(result.noneRun.pruned, 1, 'explicit None prunes the remaining old synced original');
  assert.deepEqual(result.afterNone, {cur:true, v3:false, v2:false, busy:true, thumb:true},
    'None prunes all old synced originals; blocked-upload photo kept');
  assert.equal(result.noneAgain.pruned, 0, 'failed upload photo is never pruned');
  assert.deepEqual(result.afterFail, result.afterNone);
  assert.equal(result.allRun.pruned, 0, 'explicit All never deletes');
  assert.deepEqual(result.afterAll, result.afterNone);

  // Policy and proof of server ownership must both match the active account/backend.
  result = await page.evaluate(async () => {
    const aScope = settings.backend_url.replace(/\/$/, '') + '|' + settings.user_id;
    const bBackend = 'https://other-backend.example';
    const bScope = bBackend + '|user-b';
    for (const [suffix,scope] of [['A',aScope],['B',bScope]]) {
      await put('notebooks',{id:'nbScope'+suffix,server_id:'srv-nb-'+suffix,scope});
      await put('spreads',{id:'spScope'+suffix,notebook_id:'nbScope'+suffix,
        server_id:'srv-sp-'+suffix,scope,deleted_at:null,current_photo_id:'cur'+suffix});
      for (const [id,version,current] of [['cur'+suffix,3,true],['old2'+suffix,2,false],['old1'+suffix,1,false]]) {
        await put('photos',{id,spread_id:'spScope'+suffix,scope,version,is_current:current,
          server_id:'srv-'+id,upload_status:'synced'});
        await put('blobs',{id:id+'_orig',blob:new Blob([id])});
      }
    }
    // A legacy row has no proven scope and must remain untouched too.
    await put('photos',{id:'unknownA',spread_id:'spScopeA',version:0,is_current:false,
      server_id:'srv-unknown',upload_status:'synced'});
    await put('blobs',{id:'unknownA_orig',blob:new Blob(['unknown'])});
    settings.photo_retention_scopes[aScope] = {policy:'last1'};
    const originalBackend = settings.backend_url, originalUser = settings.user_id;
    settings.backend_url = bBackend; settings.user_id = 'user-b';
    const bResult = await window.v340PruneOldPhotos({force:true});
    const bBefore = !!(await get('blobs','old1B_orig'));
    settings.backend_url = originalBackend; settings.user_id = originalUser;
    const aResult = await window.v340PruneOldPhotos({force:true});
    return {bResult,bBefore,aResult,
      aOld:!!(await get('blobs','old1A_orig')),bOld:!!(await get('blobs','old1B_orig')),
      unknown:!!(await get('blobs','unknownA_orig'))};
  });
  assert.equal(result.bResult.notOptedIn,true,'A policy does not activate for B/backend B');
  assert.equal(result.bBefore,true);
  assert.equal(result.aResult.pruned,1,'returning to A applies A policy only to proven A rows');
  assert.equal(result.aOld,false);
  assert.equal(result.bOld,true,'B original survives A pruning');
  assert.equal(result.unknown,true,'unscoped legacy original is preserved');

  // ---------- new client + OLD (v3.5.9) worker that does not know /restore ----------
  apiState.spreads['srv-spY'] = {id:'srv-spY', notebook_id:'srv-nb1', number:10, title:'victim Y', revision:1,
    deleted_at:null, updated_at:'2026-09-20T00:00:00.000Z', created_at:'2026-09-01T00:00:00.000Z', current_photo_id:null};
  apiState.oldWorker = true;
  result = await page.evaluate(async () => {
    await put('spreads', {id:'spY', server_id:'srv-spY', notebook_id:'nb1', number:10, title:'victim Y',
      status:'Актуально', favorite:false, current_photo_id:null, created_at:'2026-09-20T00:00:00.000Z',
      updated_at:'2026-09-20T00:00:00.000Z', deleted_at:null, revision:1});
    await window.__testDeleteSpread('spY');
    await window.__syncUntil(async () => (await getAll('sync_queue')).every(q => q.status === 'done'));
    return {local:(await get('spreads','spY')).deleted_at};
  });
  assert.ok(result.local && apiState.spreads['srv-spY'].deleted_at, 'delete syncs fine on the old worker');
  result = await page.evaluate(async () => {
    await window.vNextSync.restoreFromTrash('spread', 'spY');
    // let the op hit the old worker: it must NOT become 'done'
    await window.__syncUntil(async () => {
      const op = (await getAll('sync_queue')).filter(q => q.local_id === 'spY' && q.payload?.op === 'restore').at(-1);
      return op && op.status !== 'pending' && op.status !== 'syncing';
    }, 4000);
    const op = (await getAll('sync_queue')).filter(q => q.local_id === 'spY' && q.payload?.op === 'restore').at(-1);
    return {status:op.status, reason:op.blocked_reason || null, local:(await get('spreads','spY')).deleted_at};
  });
  assert.equal(result.status, 'blocked', 'unsupported /restore parks the op instead of faking success');
  assert.equal(result.reason, 'unsupported_endpoint', 'blocked op explains that the worker is outdated');
  assert.equal(result.local, null, 'locally restored record is kept while the op waits');
  assert.ok(apiState.spreads['srv-spY'].deleted_at, 'server still holds the tombstone (nothing was faked)');
  // pull protection: one more sync round while the op is parked — tombstone must not win
  result = await page.evaluate(async () => {
    await window.__syncUntil(async () => true, 1600);
    return (await get('spreads','spY')).deleted_at;
  });
  assert.equal(result, null, 'blocked restore still shields the record from the server tombstone');
  // Review C: independent changes keep syncing while the restore op is parked
  result = await page.evaluate(async () => {
    const spA = await get('spreads','spA');
    await put('spreads', {...spA, title:'independent edit', updated_at:nowISO()});
    await put('sync_queue', {entity:'spread', local_id:'spA', status:'pending', retry_count:0, payload:{}});
    const drained = await window.__syncUntil(async () =>
      (await getAll('sync_queue')).every(q => q.local_id !== 'spA' || q.entity === 'photo' || q.status === 'done'));
    const ops = (await getAll('sync_queue')).filter(q => q.local_id === 'spA')
      .map(q => ({entity:q.entity, status:q.status, err:q.last_error || null}));
    return {drained, ops, restore:(await getAll('sync_queue')).filter(q => q.local_id === 'spY' && q.payload?.op === 'restore').at(-1).status};
  });
  if (!result.drained) console.error('SIBLING DEBUG', JSON.stringify(result), JSON.stringify(apiState.log.slice(-12)));
  assert.equal(result.restore, 'blocked', 'parked restore undisturbed while siblings sync');
  assert.ok(apiState.log.some(line => line === 'PATCH /api/spreads/srv-spA'), 'sibling change reached the server');
  assert.equal(apiState.spreads['srv-spA'].title, 'independent edit');
  // after the worker rollout (deployment order is worker-first) the parked op completes
  apiState.oldWorker = false;
  result = await page.evaluate(async () => {
    await window.__syncUntil(async () => (await getAll('sync_queue')).every(q => q.status === 'done'));
    return {op:(await getAll('sync_queue')).filter(q => q.local_id === 'spY' && q.payload?.op === 'restore').at(-1).status,
      local:(await get('spreads','spY')).deleted_at};
  });
  assert.equal(result.op, 'done', 'restore op completes once the worker supports it');
  assert.equal(result.local, null);
  assert.equal(apiState.spreads['srv-spY'].deleted_at, null, 'server tombstone cleared after the rollout');

  assert.deepEqual(errors, [], 'no page errors during audit-fix scenarios');
  console.log('audit-fixes: PASS (F1 trash restore chains incl. offline/lost-response/reload, F3 notebook outbox, F10 blocked retry, F4 auth-gated upload, F5 sanitized export, F6 safe import, F2 escaping, F7 retention)');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
