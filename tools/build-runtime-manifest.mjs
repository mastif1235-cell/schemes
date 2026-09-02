import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputPath = path.join(root, 'app-v3-manifest.json');
const runtimeFiles = [
  'chunk1.txt', 'chunk2.txt', 'chunk3.txt', 'chunk4.txt',
  'v3-enhancements.txt', 'v3-sync.js', 'v3-core.js', 'v3-photos.js',
  'v3-camera.js', 'v3-history.js', 'v3-ui.js'
];

const manifest = {
  version:'3.4.0-rc.1',
  files:runtimeFiles.map(file => ({
    path:file,
    sha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')
  }))
};
const output = JSON.stringify(manifest, null, 2) + '\n';

if (process.argv.includes('--check')) {
  const current = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8') : '';
  if (current !== output) {
    console.error('app-v3-manifest.json is stale');
    process.exit(1);
  }
  console.log('runtime manifest: PASS');
} else {
  fs.writeFileSync(outputPath, output, 'utf8');
  console.log('Generated app-v3-manifest.json');
}
