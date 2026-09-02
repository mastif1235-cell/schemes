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
}

const ui = read('v3-ui.js');
assert.match(ui, /placeholder="Поиск в этом блокноте"/);
assert.match(ui, /grid-template-columns:1fr/);
assert.ok(ui.indexOf('number === query') < ui.indexOf('number.startsWith(query)'));
assert.ok(ui.indexOf('number.startsWith(query)') < ui.indexOf('text.includes(query)'));
assert.match(ui, /dataset\.notebookId = notebook\.id/);

const photos = read('v3-photos.js');
assert.ok(photos.indexOf("photo.id + '_orig'") < photos.indexOf('apiBlob('));
assert.ok(photos.indexOf('apiBlob(') < photos.indexOf('const thumbnail = allowThumbnail'));
assert.doesNotMatch(photos, /JSON\.stringify\([^)]*queue/);
assert.match(photos, /event\.state\.blocknotViewer === historyToken/);

const history = read('v3-history.js');
assert.match(history, /История этого устройства/);
assert.match(history, /не синхронизируется/);
assert.match(history, /v340OpenSpread\(spread\)/);

const camera = read('v3-camera.js');
assert.match(camera, /const maxSide = 2400/);
assert.match(camera, /bitmap\.close/);
assert.match(camera, /pointercancel/);
assert.match(camera, /blocknotCrop/);
assert.match(camera, /rgba\(0,0,0,\.58\)/);

const core = read('v3-core.js');
assert.match(core, /notebook_cover_/);
assert.match(core, /Обложка хранится только на этом устройстве/);
assert.doesNotMatch(core, /\[\[BNSCOVER:/);

console.log('v3-contract: PASS');
