import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const photosSource = fs.readFileSync(new URL('../v3-photos.js', import.meta.url), 'utf8');
const workerSource = fs.readFileSync(new URL('../backend/worker.js', import.meta.url), 'utf8');

const context = {
  console:{...console, warn() {}, error() {}},
  URL,
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

assert.match(workerSource, /function publicPhoto\(row, env\)/, 'backend has a single public photo mapper');
assert.match(workerSource, /telegram_link: messageId && env\.CHAT_ID \? telegramLink\(env\.CHAT_ID, messageId\)/,
  'backend computes Telegram links from server-side CHAT_ID and telegram_message_id');
assert.match(workerSource, /photos: publicPhotos\(photos\.results, env\)/,
  'snapshot returns mapped public photos with computed links');
assert.match(workerSource, /changes\[tables\[i\]\.name\] = tables\[i\]\.name === 'photos' \? publicPhotos\(rows, env\) : rows/,
  'sync returns mapped public photos with computed links');
assert.match(workerSource, /return json\(\{ photo: publicPhoto\(photo, env\) \}\)/,
  'photo GET returns mapped public photo metadata');
assert.match(workerSource, /uploadedPhoto = publicPhoto/,
  'fresh upload response is built from mapped public photo metadata');

console.log('photo-telegram-link: PASS');
