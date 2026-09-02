import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = path.join(root, 'v3-enhancements.js');
const outputPath = path.join(root, 'v3-enhancements.txt');
const source = Buffer.from(fs.readFileSync(sourcePath, 'utf8').replace(/\r\n?/g, '\n'));
const compressed = zlib.gzipSync(source, {level:9, mtime:0});
// RFC 1952's OS byte is metadata only. Normalize it so Windows and Linux
// produce the same checked-in payload.
compressed[9] = 255;
const output = compressed.toString('base64') + '\n';

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
