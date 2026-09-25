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

// sendPhoto is opt-in, guarded, and always falls back to lossless sendDocument.
assert.match(workerSource, /async function telegramSendPhoto\(env, blob, filename\)/, 'worker implements sendPhoto');
assert.match(workerSource, /\/sendPhoto`, \{ method: 'POST', body: fd \}\)/, 'sendPhoto posts to the sendPhoto endpoint');
assert.match(workerSource, /form\.get\('send_as'\) \|\| ''\) === 'photo'/, 'sendPhoto is client opt-in only');
assert.match(workerSource, /image\\\/\(jpeg\|png\|webp\)\$\/\.test/, 'sendPhoto is limited to photo mime types');
assert.match(workerSource, /Number\(file\.size\) <= 10 \* 1024 \* 1024/, 'sendPhoto respects the 10 MB photo limit');
assert.match(workerSource, /falling back to sendDocument/, 'sendPhoto failure falls back to sendDocument');
assert.match(workerSource, /telegram_method: telegramMethod/, 'upload response records the actual Telegram method');
assert.match(workerSource, /if \(!tgResult\) tgResult = await telegramSendDocument/,
  'document upload always succeeds when sendPhoto is not used');
assert.match(workerSource, /photos: publicPhotos\(photos\.results, env\)/,
  'snapshot returns mapped public photos with computed links');
assert.match(workerSource, /changes\[tables\[i\]\.name\] = tables\[i\]\.name === 'photos' \? publicPhotos\(rows, env\) : rows/,
  'sync returns mapped public photos with computed links');
assert.match(workerSource, /return json\(\{ photo: publicPhoto\(photo, env\) \}\)/,
  'photo GET returns mapped public photo metadata');
assert.match(workerSource, /uploadedPhoto = publicPhoto/,
  'fresh upload response is built from mapped public photo metadata');

console.log('photo-telegram-link: PASS');
