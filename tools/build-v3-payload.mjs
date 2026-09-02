import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = path.join(root, 'v3-enhancements.js');
const outputPath = path.join(root, 'v3-enhancements.txt');
const source = fs.readFileSync(sourcePath);
const output = zlib.gzipSync(source, {level:9, mtime:0}).toString('base64') + '\n';

if (process.argv.includes('--check')) {
  const current = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8') : '';
  if (current !== output) {
    console.error('v3-enhancements.txt is not generated from v3-enhancements.js');
    process.exit(1);
  }
  console.log('v3 payload: PASS');
} else {
  fs.writeFileSync(outputPath, output, 'utf8');
  console.log('Generated v3-enhancements.txt');
}
