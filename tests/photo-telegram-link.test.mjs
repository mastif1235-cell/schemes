import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const photosSource = fs.readFileSync(new URL('../v3-photos.js', import.meta.url), 'utf8');
const workerSource = fs.readFileSync(new URL('../backend/worker.js', import.meta.url), 'utf8');

const context = {
  console:{...console, warn() {}, error() {}},
  URL,
  atob,
  location:{href:'https://mastif1235-cell.github.io/schemes/'},
  get:async () => null,
  put:async () => {},
  del:async () => {},
  getAll:async () => [],
  getAllByIndex:async () => [],
  api:async () => ({}),
  apiBlob:async () => null,
  isAuthed:() => false,
  isOnline:() => false,
  toast:() => {},
  render:() => {},
  fullSync:() => {},
  nowISO:() => new Date().toISOString(),
  uid:() => 'id',
  logHistory:async () => {},
  openSheet:() => ({el:{querySelector:() => null, querySelectorAll:() => [], closest:() => null}, close() {}}),
  confirmAction:() => {},
  makeThumbnail:async () => ({}),
  document:{
    head:{appendChild() {}},
    body:{appendChild() {}},
    createElement:tag => ({tagName:tag.toUpperCase(), style:{}, classList:{add() {}, remove() {}, toggle() {}},
      appendChild() {}, remove() {}, setAttribute() {}, addEventListener() {}, querySelector:() => null,
      querySelectorAll:() => [], innerHTML:'', textContent:''}),
  },
};
context.window = context;
vm.createContext(context);
vm.runInContext(photosSource, context, {filename:'v3-photos.js'});

assert.equal(context.window.v350GetTelegramPhotoLink({telegram_message_id:'321'}), null,
  'message_id alone must not enable a silently broken Telegram button');
assert.equal(context.window.v350GetTelegramPhotoLink({telegram_message_id:'321', telegram_link:'https://t.me/c/555777/321'}),
  'https://t.me/c/555777/321', 'valid server-provided Telegram link is usable exactly');
assert.equal(context.window.v350GetTelegramPhotoLink({telegram_link:'javascript:alert(1)'}), null,
  'non-Telegram links are not considered usable');

assert.match(photosSource, /const telegramLink = getTelegramPhotoLink\(photo\)/,
  'viewer computes Telegram button state through the shared helper');
assert.match(photosSource, /data-action="telegram" \$\{telegramLink \? '' : 'disabled'\}/,
  'viewer disables the Telegram button when the same helper has no link');
assert.match(photosSource, /else if \(action === 'telegram'\)[\s\S]*const link = getTelegramPhotoLink\(photo\)[\s\S]*window\.open\(link, '_blank'\)/,
  'viewer click opens the exact link returned by the same helper');
assert.doesNotMatch(photosSource, /telegram_message_id \? '' : 'disabled'/,
  'viewer must not enable the Telegram button from message_id alone');

// Legacy rows without telegram_link/message_id must still be openable via storage_object_id.
const soi = value => Buffer.from(value, 'utf8').toString('base64');
assert.equal(context.window.v350GetTelegramPhotoLink({telegram_link:null, telegram_message_id:null,
  storage_object_id:soi('-100555777:654')}),
  'https://t.me/c/555777/654', 'legacy storage_object_id yields a working t.me link');
assert.equal(context.window.v350GetTelegramPhotoLink({telegram_link:null, telegram_message_id:null,
  storage_object_id:soi('-100999000:77')}),
  'https://t.me/c/999000/77', 'legacy link keeps its original chat, not the current one');
assert.equal(context.window.v350GetTelegramPhotoLink({storage_object_id:'not-base64!!!'}), null,
  'garbage storage_object_id never produces a link');
assert.equal(context.window.v350GetTelegramPhotoLink({storage_object_id:soi('chat:0')}), null,
  'non-positive message ids never produce a link');
assert.equal(context.window.v350GetTelegramPhotoLink({storage_object_id:soi(':321')}), null,
  'empty chat never produces a link');

// New sendPhoto uploads and legacy document rows share one link rule: message id builds the link.
assert.match(workerSource, /function publicPhoto\(row, env\)/, 'backend has a single public photo mapper');
assert.match(workerSource, /decodeStorageObjectId\(row\.storage_object_id\)/,
  'backend derives the Telegram link for legacy rows from storage_object_id');
assert.match(workerSource, /telegram_link: messageId && messageChatId \? telegramLink\(messageChatId, messageId\)/,
  'backend computes Telegram links from the correct chat and message id');
// Dual storage contract: sendDocument = canonical original (always, first), sendPhoto = the
// auxiliary preview (opt-in, guarded, after the document, never a restore source).
assert.match(workerSource, /async function telegramSendPhoto\(env, blob, filename\)/, 'worker implements sendPhoto');
assert.match(workerSource, /\/sendPhoto`, \{ method: 'POST', body: fd \}\)/, 'sendPhoto posts to the sendPhoto endpoint');
assert.match(workerSource, /async function sendTelegramPreview\(env, blob, spreadId, version\)/,
  'preview sending is isolated in a soft-fail helper');
assert.match(workerSource, /form\.get\('photo_preview'\) \|\| ''\) === '1'/,
  'preview creation is an explicit client request');
assert.match(workerSource, /\^image\\\/\(jpeg\|png\|webp\)\$\/\.test/, 'preview is limited to photo mime types');
assert.match(workerSource, /Number\(file\.size\) <= 10 \* 1024 \* 1024/, 'preview respects the 10 MB photo limit');
assert.match(workerSource, /const tgResult = await telegramSendDocument/,
  'the canonical original always goes through sendDocument');
assert.match(workerSource, /docExtras\.message_id, docExtras\.file_id,/,
  'photos row persists the DOCUMENT identifiers (source of truth)');
assert.match(workerSource, /telegram_preview_link: mapped\.telegram_preview_link/,
  'preview link is exposed alongside the document link');
assert.match(workerSource, /\{ pending: true, phase: 'sending' \}/, 'preview has a pending/in-flight state');
assert.match(workerSource, /AND result_json=\?/, 'preview claim is a compare-and-swap on the idempotency ledger');
assert.match(workerSource, /dualLedgerJson/, 'dual state lives in the uploads ledger (no D1 migration)');
assert.match(workerSource, /'document\+photo' : 'document'/, 'upload response records the actual Telegram mode');
assert.match(workerSource, /SELECT \* FROM photos WHERE client_upload_id=\?/,
  'retry/crash-resume converges on the existing photo row');
assert.match(workerSource, /await photosWithPreview\(env, photos\.results\)/,
  'snapshot returns photos with merged preview references');
assert.match(workerSource, /await photosWithPreview\(env, rows\)/,
  'sync returns photos with merged preview references');
assert.match(workerSource, /return json\(\{ photo: await photoWithPreview\(env, photo\) \}\)/,
  'photo GET returns mapped public photo + preview metadata');
assert.ok(workerSource.indexOf('telegramSendDocument(env, file') <
  workerSource.indexOf('await sendTelegramPreview(env, file'), 'document is sent BEFORE the preview in the upload flow');
assert.match(workerSource, /const doc = tgResult\.document;/,
  'the canonical file_id comes from the sendDocument document only');
assert.doesNotMatch(workerSource, /INSERT INTO photos[\s\S]{0,700}previewExtras/,
  'the photos INSERT never uses preview identifiers');
// Preview retry classification (root cause E: pending preview used to park the upload forever).
assert.match(workerSource, /error\.tgErrorCode = Number\(data\.error_code\)/,
  'worker keeps Telegram error codes for retry classification');
assert.match(workerSource, /Number\(previewError\.tgErrorCode\) >= 400 && Number\(previewError\.tgErrorCode\) < 500/,
  'Telegram 4xx marks the preview error as permanent, so clients do not retry forever');
assert.match(workerSource, /preview_permanent: !!mapped\.preview_permanent/,
  'upload responses expose the permanent classification');

// Client contract: queue must not complete while the preview is pending, and upgrades default ON.
const syncSource = fs.readFileSync(new URL('../v3-sync.js', import.meta.url), 'utf8');
assert.match(syncSource, /if \(settings\.telegram_photo_preview !== false\) fd\.append\('photo_preview', '1'\)/,
  'upgrade default: existing 3.6.2 settings (key absent) still request the preview');
assert.match(syncSource, /!!photo\.preview_pending\n?\s*&& !photo\.preview_permanent && !photo\.preview_stopped_at/,
  'a synced photo with a retryable pending preview stays in the upload queue');
assert.match(syncSource, /!!data\.preview_pending && !data\.preview_permanent/,
  'a pending preview keeps the queue retryable instead of marking it done (root bug E)');
assert.match(syncSource, /markRetry\(item, new Error\('telegram preview pending'\)\)/,
  'the retry schedules only the missing preview (worker never re-sends the document)');
assert.match(syncSource, /continue; \/\/ keep the local original blob/,
  'the preview retry keeps the local original blob needed to resend');
assert.match(syncSource, /preview_stopped_at/,
  'preview retries are bounded and parked after the retry budget');

console.log('photo-telegram-link: PASS');
