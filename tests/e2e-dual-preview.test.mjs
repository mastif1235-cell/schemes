// CRITICAL E2E (production case, 3.6.5): a real Chromium browser session + the REAL worker code +
// SQLite with the production uploads → photos foreign key + a scripted Telegram mock. Traces the complete chain the production smoke
// reported: settings toggle ON → multipart request with photo_preview=1 → document success →
// temporary preview fail → app must NOT park the queue → forced retry → worker replays the ledger
// → document NEVER re-sent → preview completes → exactly 1 document + 1 preview.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {resolve, extname} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {DualPreviewD1} from './dual-preview-sqlite.mjs';
const worker = (await import(process.env.WORKER_MODULE_PATH
  ? pathToFileURL(process.env.WORKER_MODULE_PATH).href : '../backend/worker.js')).default;

const {chromium} = await import(process.env.PLAYWRIGHT_MODULE_PATH ? pathToFileURL(process.env.PLAYWRIGHT_MODULE_PATH).href : 'playwright');
const root = fileURLToPath(new URL('../', import.meta.url));
const db = new DualPreviewD1();
const workerEnv = {DB:db, CHAT_ID:'-100555777', BOT_TOKEN:'test-token'};

// ---- Telegram mock: document success; sendPhoto temp-fails ONCE, then succeeds --------------
const tg = {docCalls:0, photoCalls:0, photoAllowedAfter:1, docMessage:701, photoMessage:906};
const nativeFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const target = String(url);
  if (!target.startsWith('https://api.telegram.org/')) return nativeFetch(url, init);
  if (target.includes('/sendDocument')) {
    tg.docCalls++;
    return Response.json({ok:true, result:{message_id:tg.docMessage,
      document:{file_id:'doc-file', file_unique_id:'doc-u', file_size:409600, mime_type:'image/jpeg'}}});
  }
  if (target.includes('/sendPhoto')) {
    tg.photoCalls++;
    if (tg.photoCalls <= tg.photoAllowedAfter) {
      return Response.json({ok:false, error_code:500, description:'INTERNAL SERVER ERROR'}, {status:500});
    }
    return Response.json({ok:true, result:{message_id:tg.photoMessage, photo:[
      {file_id:'view-file', file_unique_id:'view-u', width:1280, height:960, file_size:8000}]}});
  }
  throw new Error('unexpected telegram endpoint: ' + target);
};

// ---- static app server + chromium -----------------------------------------------------------
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
  browser = await chromium.launch({headless:true});
  const context = await browser.newContext({viewport:{width:412, height:915}, isMobile:true, serviceWorkers:'block'});
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());

  // REAL worker proxy: browser → page route → worker.fetch(node) → telegram mock.
  // INSTRUMENTATION (v3.6.6 diagnostics): every proxied request records the telegram-call deltas
  // it produced plus its client_upload_id, so attempt 1 can PROVE 1 request = 1 doc + 1 sendPhoto.
  const uploadRequests = [];
  const requestLog = [];
  await page.route(origin + '/api/spreads/srv-spE/photos', async route => {
    const request = route.request();
    const contentType = request.headers()['content-type'] || '';
    let bodyBuffer = null;
    try { bodyBuffer = request.postDataBuffer(); } catch { bodyBuffer = null; }
    if (!bodyBuffer) { const text = request.postData(); bodyBuffer = text ? Buffer.from(text, 'utf8') : null; }
    uploadRequests.push(bodyBuffer ? bodyBuffer.toString('latin1') : '');
    const ledgerBefore = JSON.stringify(db.uploads);
    const tgBefore = {doc:tg.docCalls, photo:tg.photoCalls, ok:tg.okCount || 0};
    const proxied = new Request(origin + '/api/spreads/srv-spE/photos', {
      method:'POST',
      headers:{'content-type':contentType, authorization:request.headers()['authorization'] || ''},
      body: bodyBuffer || undefined,
      duplex: bodyBuffer ? 'half' : undefined,
    });
    const response = await worker.fetch(proxied, workerEnv, {waitUntil() {}});
    const payload = await response.text();
    requestLog.push({
      seq: uploadRequests.length, stack: null,
      clientUploadId: ((bodyBuffer || '').toString('latin1').match(/name="client_upload_id"\r\n\r\n([^\r\n]+)/) || [])[1] || null,
      docDelta: tg.docCalls - tgBefore.doc, photoDelta: tg.photoCalls - tgBefore.photo,
      responseStatus: response.status, responseBody: payload, httpTs: Date.now(),
      ledgerDelta: JSON.stringify(db.uploads).length - ledgerBefore.length,
    });
    if (globalThis.__e2eLostResponse) { // crash AFTER the worker committed: response never reaches the client
      return route.abort('failed');
    }
    route.fulfill({status:response.status, contentType:'application/json', body:payload});
  });
  await page.route(origin + '/api/me', route => route.fulfill({json:{user:{id:'u1', display_name:'Owner'}, devices:[], capabilities:{}}}));
  await page.route(origin + '/api/notebooks', route => route.fulfill({json:{notebooks:[{id:'nbE', title:'NB', revision:1, deleted_at:null}]}}));
  await page.route(origin + '/api/sync', route => route.fulfill({json:{changes:{}, next_cursor:100, has_more:false}}));

  await page.goto(origin + '/');
  await page.waitForFunction(() => typeof openDB === 'function' && typeof pushPhotoQueue === 'function');
  // Seed a realistic device state: authenticated session, toggle ON, jpeg ~400 KB, photo queued.
  await page.evaluate(async backend => {
    await openDB();
    await put('settings', {key:'app', theme:'light', backend_url:backend, auth_token:'token-1',
      user_id:'u1', telegram_photo_preview:true});
    await put('notebooks', {id:'nbE', server_id:'nbE-local', title:'NB', revision:1, sort_order:0, deleted_at:null});
    await put('spreads', {id:'spE', server_id:'srv-spE', notebook_id:'nbE', number:1, title:'Spread', revision:1, deleted_at:null, current_photo_id:null});
    await put('photos', {id:'phE2E', spread_id:'spE', version:1, is_current:true, provider:'telegram',
      upload_status:'local_pending', created_at:new Date().toISOString()});
    const bytes = new Uint8Array(409600); // ~400 KB jpeg, like the production smoke photo
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31) % 251;
    await put('blobs', {id:'phE2E_orig', blob:new Blob([bytes], {type:'image/jpeg'})});
    await put('blobs', {id:'phE2E_thumb', blob:new Blob([bytes.slice(0, 2048)], {type:'image/jpeg'})});
  }, origin);
  await page.reload(); // boot reloads settings from IndexedDB (avoids racing the in-memory copy)
  await page.waitForFunction(() => typeof pushPhotoQueue === 'function' && !!settings.auth_token);
  // The boot fullSync may STILL be in flight here; its inner pushPhotoQueue step would pick up
  // the seeded item concurrently with the explicit drain below. Wait for it to finish (empty
  // queue → zero photo requests) before anything else, so attempt boundaries are clean.
  await page.waitForFunction(() => !!settings.last_sync_at ||
    ['idle', 'pending', 'error'].includes(settings.sync_status), null, {timeout:15000});
  // Determinism: freeze the automatic sync loop so ONLY the explicit queue drains below fire
  // requests (the assertion counts depend on one synthetic attempt = one HTTP round trip).
  await page.evaluate(async () => {
    fullSync = async () => {};
    await put('sync_queue', {entity:'photo', photo_id:'phE2E', status:'pending', retry_count:0});
    // page-side proof of the caller chain for EVERY photos request
    window.__fetchStacks = [];
    const realFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      if (String(input).includes('/api/spreads/') && String(input).endsWith('/photos')) {
        window.__fetchStacks.push(new Error('stack').stack);
      }
      return realFetch(input, init);
    };
  });

  const dumpDiag = async label => {
    const stacks = await page.evaluate(() => window.__fetchStacks || []);
    console.log(`DIAG[${label}] requests=`, JSON.stringify(requestLog, null, 1),
      `\nDIAG[${label}] page fetch stacks (${stacks.length}):`, stacks.join('\n---\n'));
  };

  // ---- attempt 1: 1 request = 1 document + 1 sendPhoto attempt; preview pending --------------
  await page.evaluate(() => pushPhotoQueue(true));
  const afterFirst = await page.evaluate(async () => {
    const item = (await getAll('sync_queue')).find(q => q.photo_id === 'phE2E');
    const photo = await get('photos', 'phE2E');
    return {status:item.status, next:!!item.next_attempt_at, error:item.last_error,
      photoStatus:photo.upload_status, pending:photo.preview_pending, permanent:photo.preview_permanent,
      blob:!!(await get('blobs', 'phE2E_orig'))};
  });
  if (uploadRequests.length !== 1 || tg.docCalls !== 1 || tg.photoCalls !== 1) await dumpDiag('attempt1');
  assert.equal(uploadRequests.length, 1,
    'attempt 1 = exactly ONE HTTP request (A: one request with two sends must never happen)');
  assert.equal(tg.docCalls, 1, 'document sent exactly once on attempt 1');
  assert.equal(tg.photoCalls, 1, 'sendPhoto attempted exactly once on attempt 1');
  assert.deepEqual({doc:requestLog[0].docDelta, photo:requestLog[0].photoDelta}, {doc:1, photo:1},
    'attempt 1 request: 1 sendDocument + 1 sendPhoto inside the same Worker request');
  assert.equal(requestLog[0].clientUploadId, 'phE2E');
  assert.equal(afterFirst.photoStatus, 'synced',
    'WHY THE APP SHOWS SYNCHRONIZED: the original is counted remote-safe despite the pending preview');
  assert.equal(afterFirst.pending, true, 'photo row keeps the retryable pending preview');
  assert.equal(afterFirst.permanent, false, 'Telegram 5xx is retry-class, not permanent');
  assert.equal(afterFirst.status, 'failed',
    'queue item is NOT done — a retry is scheduled (the v3.6.4 parking bug, fixed)');
  assert.equal(afterFirst.next, true, 'retry has a scheduled next attempt');
  assert.equal(afterFirst.error, 'telegram preview pending');
  assert.equal(afterFirst.blob, true, 'retry keeps the local original blob');
  assert.ok((uploadRequests[0] || '').includes('name="photo_preview"'),
    'attempt 1 request body really carries photo_preview=1 from settings to the HTTP layer');

  // ---- retry: forced sync re-runs the queue; worker replays the ledger -----------------------
  await page.evaluate(async () => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      await pushPhotoQueue(true);
      const item = (await getAll('sync_queue')).find(q => q.photo_id === 'phE2E');
      if (item && item.status === 'done') break;
    }
  });
  const final = await page.evaluate(async () => {
    const item = (await getAll('sync_queue')).find(q => q.photo_id === 'phE2E');
    const photo = await get('photos', 'phE2E');
    return {status:item.status, preview:photo.preview_message_id, previewFile:photo.preview_file_id,
      pending:photo.preview_pending, method:photo.telegram_method,
      link:photo.telegram_preview_link, docLink:photo.telegram_link,
      message:photo.telegram_message_id, file:photo.telegram_file_id};
  });
  if (uploadRequests.length !== 2 || tg.docCalls !== 1 || tg.photoCalls !== 2) await dumpDiag('attempt2');
  assert.equal(final.status, 'done', 'queue completes ONLY after the preview lands');
  assert.equal(uploadRequests.length, 2, 'attempt 2 = ONE more HTTP request, total = 2');
  assert.equal(tg.docCalls, 1, 'the document was NEVER re-sent during the preview retry');
  assert.equal(tg.photoCalls, 2, 'sendPhoto total: 1 temporary failure + 1 successful retry');
  assert.deepEqual({doc:requestLog[1].docDelta, photo:requestLog[1].photoDelta}, {doc:0, photo:1},
    'attempt 2 request replays the ledger: 0 documents, 1 sendPhoto');
  assert.equal(requestLog[1].clientUploadId, 'phE2E', 'the retry is the same client_upload_id');
  assert.equal(final.preview, 906);
  assert.equal(final.previewFile, 'view-file');
  assert.equal(final.pending, false);
  assert.equal(final.method, 'document+photo');
  assert.equal(final.link, 'https://t.me/c/555777/906', 'the button opens the preview message');
  assert.equal(final.docLink, 'https://t.me/c/555777/701', 'the document link stays the original');
  assert.equal(final.message, 701);
  assert.equal(final.file, 'doc-file', 'restore/download still targets the document file_id');
  assert.ok((uploadRequests[1] || '').includes('name="photo_preview"'),
    'the retry request keeps photo_preview=1');
  const ledgerRow = db.uploads.find(row => row.photo_id &&
    db.photos.some(photo => photo.id === row.photo_id && photo.client_upload_id));
  const ledger = JSON.parse(ledgerRow?.result_json || '{}');
  assert.equal(ledger.extras?.doc?.message_id, 701, 'ledger holds the document descriptors');
  assert.equal(ledger.extras?.preview?.message_id, 906, 'ledger holds the preview descriptors');
  assert.equal(db.photos.length, 1, 'exactly one logical photo record');

  // ---- lost-response: worker committed fully, the RESPONSE never reached the client ----------
  globalThis.__e2eLostResponse = true; // next request: abort AFTER the worker commit
  await page.evaluate(async () => {
    await put('photos', {id:'phE2E3', spread_id:'spE', version:3, is_current:true, provider:'telegram',
      upload_status:'local_pending', created_at:new Date().toISOString()});
    await put('blobs', {id:'phE2E3_orig', blob:new Blob([new Uint8Array(200 * 1024)], {type:'image/jpeg'})});
    await put('sync_queue', {entity:'photo', photo_id:'phE2E3', status:'pending', retry_count:0});
    await pushPhotoQueue(true); // server commits doc+preview; the response is lost on the way back
  });
  globalThis.__e2eLostResponse = false;
  await page.evaluate(async () => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      await pushPhotoQueue(true);
      const item = (await getAll('sync_queue')).find(q => q.photo_id === 'phE2E3');
      if (item && item.status === 'done') break;
    }
  });
  const lost = await page.evaluate(async () => {
    const item = (await getAll('sync_queue')).find(q => q.photo_id === 'phE2E3');
    const photo = await get('photos', 'phE2E3');
    return {status:item.status, preview:photo.preview_message_id, pending:photo.preview_pending};
  });
  const lostRow = db.uploads.find(row => row.photo_id &&
    db.photos.some(photo => photo.id === row.photo_id && photo.client_upload_id === 'phE2E3'));
  const lostLedger = JSON.parse(lostRow?.result_json || '{}');
  if (tg.docCalls !== 2) await dumpDiag('lost-response');
  assert.equal(lost.status, 'done', 'lost-response retry completes without a resend');
  assert.equal(tg.docCalls, 2, 'lost response: the document was NOT re-sent on the retry');
  assert.equal(requestLog[requestLog.length - 1].docDelta, 0, 'lost-response retry sends 0 documents');
  assert.equal((JSON.stringify(lostLedger.extras || {}).match(/"message_id"/g) || []).length, 2,
    'ledger holds exactly 1 document + 1 successful preview message');
  assert.equal(lost.pending, false);
  assert.ok(typeof lost.preview === 'number' && lost.preview > 0);

  // ---- first-try success: same chain, no Telegram hiccup → exactly 1+1 in one attempt ------
  await page.evaluate(async () => {
    await put('photos', {id:'phE2E2', spread_id:'spE', version:2, is_current:true, provider:'telegram',
      upload_status:'local_pending', created_at:new Date().toISOString()});
    const bytes = new Uint8Array(300 * 1024);
    await put('blobs', {id:'phE2E2_orig', blob:new Blob([bytes], {type:'image/jpeg'})});
    await put('sync_queue', {entity:'photo', photo_id:'phE2E2', status:'pending', retry_count:0});
    await pushPhotoQueue(true);
  });
  const phase2 = await page.evaluate(async () => {
    const item = (await getAll('sync_queue')).find(q => q.photo_id === 'phE2E2');
    const photo = await get('photos', 'phE2E2');
    return {status:item.status, preview:photo.preview_message_id, pending:photo.preview_pending,
      photoStatus:photo.upload_status, method:photo.telegram_method};
  });
  if (uploadRequests.length !== 5 || tg.docCalls !== 3 || tg.photoCalls !== 4) await dumpDiag('first-try');
  assert.equal(tg.docCalls, 3, 'third photo: exactly one more document');
  assert.equal(tg.photoCalls, 4, 'third photo: sendPhoto succeeds on the first attempt');
  assert.equal(uploadRequests.length, 5, 'exactly one HTTP round trip per attempt across the whole run');
  assert.deepEqual({doc:requestLog[4].docDelta, photo:requestLog[4].photoDelta}, {doc:1, photo:1},
    'first-try success request: 1 sendDocument + 1 sendPhoto');
  assert.ok((uploadRequests[4] || '').includes('name="photo_preview"'),
    'first-try-success request also carries photo_preview=1');
  assert.equal(phase2.status, 'done');
  assert.equal(phase2.photoStatus, 'synced');
  assert.equal(phase2.preview, 906);
  assert.equal(phase2.pending, false);
  assert.equal(phase2.method, 'document+photo');
  assert.deepEqual(errors, []);
  console.log('e2e-dual-preview: PASS (settings→form→worker→ledger→retry: 1 document + 1 preview, no re-send)');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
  globalThis.fetch = nativeFetch;
  db.close();
}
