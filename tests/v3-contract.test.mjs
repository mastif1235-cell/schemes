import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const manifest = JSON.parse(read('app-v3-manifest.json'));
const paths = manifest.files.map(entry => entry.path);
const consolidated = ['v3-core.js', 'v3-photos.js', 'v3-camera.js', 'v3-history.js', 'v3-ui.js'];

assert.deepEqual(paths.slice(-consolidated.length), consolidated);
for (const file of consolidated) {
  const source = read(file);
  assert.doesNotMatch(source, /new\s+MutationObserver|setInterval\s*\(/, `${file} must remain event-driven`);
  assert.doesNotMatch(source, /catch\s*\(_\)\s*\{\s*\}/, `${file} must not hide errors in empty catches`);
}

const ui = read('v3-ui.js');
const sync = read('v3-sync.js');
assert.match(ui, /placeholder="Поиск в этом блокноте"/);
assert.match(ui, /grid-template-columns:1fr/);
assert.ok(ui.indexOf('number === query') < ui.indexOf('number.startsWith(query)'));
assert.ok(ui.indexOf('number.startsWith(query)') < ui.indexOf('text.includes(query)'));
assert.match(ui, /getAllByIndex\('spreads', 'notebook_id', notebook\.id\)/);
assert.match(ui, /revision === searchRevision/);
assert.match(ui, /host\.replaceChildren\(grid\)/);
assert.match(ui, /<label for="v340SearchNotebook">Блокнот<\/label>/);
assert.match(ui, /<option value="">Все блокноты<\/option>/);
assert.match(ui, /option\.value = notebook\.id/);
assert.match(ui, /row\.notebook_id === selector\.value/);
assert.match(ui, /route\.screen !== 'spreads'/);
assert.match(ui, /route = \{screen:'search', notebookId\}/);
assert.doesNotMatch(ui, /data-scope="global"/);
assert.match(ui, /dataset\.notebookId = notebook\.id/);
assert.match(ui, /Блокнот-скан · v3\.4\.2 · Stable/);
assert.doesNotMatch(ui, /v3\.4\.0 RC/);

const photos = read('v3-photos.js');
assert.ok(photos.indexOf("photo.id + '_orig'") < photos.indexOf('apiBlob('));
for (const state of ['local', 'pending', 'syncing', 'synced', 'error']) {
  assert.match(photos, new RegExp(`state:'${state}'`));
}
assert.doesNotMatch(photos, /state:'(?:failed|uploading|telegram)'/);
assert.match(photos, /queueStatus === 'done'[\s\S]*?state:'synced'[\s\S]*?state:'error'/);
assert.match(photos, /if \(queueStatus\) return \{state:'error'/);
assert.match(photos, /if \(closed\) return;[\s\S]*?URL\.createObjectURL\(resolved\.blob\)/);
assert.match(photos, /finally \{ setTimeout\(\(\) => URL\.revokeObjectURL\(url\), 1000\); \}/);
assert.ok(photos.indexOf('apiBlob(') < photos.indexOf('const thumbnail = allowThumbnail'));
assert.doesNotMatch(photos, /JSON\.stringify\([^)]*queue/);
assert.match(photos, /event\.state\.blocknotViewer === historyToken/);
assert.doesNotMatch(photos, /swipeX|swipeY|Math\.abs\(dx\) > 70/);
assert.match(photos, /v341-nav-zone/);
assert.match(photos, /press\.moved && gesture\.scale <= 1\.001/);
assert.match(photos, /v341-zoomed/);
assert.match(photos, /const maxSide = 3200/);
assert.match(photos, /new ImageDecoder\(\{data:blob\.stream\(\), type:blob\.type\}\)/);
assert.match(photos, /createImageBitmap\(blob, options\)/);
assert.match(photos, /previous original intact/);
assert.match(photos, /Поворот сохранён новой версией фото/);
assert.match(photos, /attachPhoto\(spread, file\)/);
assert.match(photos, /data-action="rotate-left"/);
assert.match(photos, /data-action="rotate-right"/);

const history = read('v3-history.js');
assert.match(history, /История этого устройства/);
assert.match(history, /не синхронизируется/);
assert.match(history, /v340OpenSpread\(spread\)/);
assert.match(history, /data-open="notebook"/);
assert.match(history, /route = \{screen:'spreads', notebookId:targetNotebook\.id\}/);
assert.doesNotMatch(history, /openSpread\(|openSpreadEditor\(/);

const camera = read('v3-camera.js');
assert.match(camera, /const maxSide = 2400/);
assert.match(camera, /bitmap\.close/);
assert.match(camera, /pointercancel/);
assert.match(camera, /blocknotCrop/);
assert.match(camera, /rgba\(0,0,0,\.58\)/);
assert.match(camera, /data-action="rotate-left"/);
assert.match(camera, /data-action="rotate-right"/);
assert.match(camera, /imageOrientation:'from-image'/);
assert.match(camera, /data-choice="camera">📷 Сфотографировать/);
assert.match(camera, /data-choice="gallery">🖼️ Выбрать из галереи/);
assert.match(camera, /choice === 'camera'/);
assert.match(camera, /interactiveCrop\(file, 'auto'\)/);
assert.match(camera, /bitmap\.width >= bitmap\.height \? 'landscape' : 'portrait'/);
assert.doesNotMatch(camera, /data-choice="(?:portrait|landscape)"/);

const core = read('v3-core.js');
assert.match(core, /if \(vNextOpenPromise\) return vNextOpenPromise/);
assert.match(core, /indexedDB\.databases/);
assert.match(core, /databaseExists \? await new Promise/);
assert.match(core, /const ready = connection;[\s\S]*?ready\.onversionchange = \(\) =>/);
assert.match(core, /vNextOpenPromise = null/);
assert.match(read('v3-photos.js'), /\.sheet-backdrop\{z-index:120\}/);
assert.match(core, /notebook_cover_/);
assert.match(core, /Обложка хранится только на этом устройстве/);
assert.match(core, /COVER_PREFIX \+ notebook\.id/);
assert.match(core, /isCoverRemoved\(notebook\.id\)/);
assert.doesNotMatch(core, /COVER_PREFIX \+ notebook\.title/);
assert.match(core, /window\.v340PruneRecents = pruneRecents/);
assert.match(core, /Recent spreads could not be saved/);
assert.match(core, /image\.addEventListener\('load', release/);
assert.match(core, /setTimeout\(release, 30000\)/);
assert.match(ui, /getAll\('user_favorites'\)/);
assert.match(ui, /Stale favorite reference could not be removed/);
assert.match(ui, /window\.v340PruneRecents\(\)/);
assert.match(sync, /pushFavorite[\s\S]*?if \(!sp\.server_id\) return queueResult\('deferred'/);
assert.doesNotMatch(core, /\[\[BNSCOVER:/);

console.log('v3-contract: PASS');
