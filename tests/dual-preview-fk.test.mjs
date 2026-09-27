import assert from 'node:assert/strict';
import worker from '../backend/worker.js';
import { DualPreviewD1 } from './dual-preview-sqlite.mjs';

const originalFetch = globalThis.fetch;
const image = new Blob([new Uint8Array(4096)], { type: 'image/jpeg' });

function telegramMock({ docGate = null, photoGate = null, previewFailures = 0 } = {}) {
  const counts = { document: 0, preview: 0 };
  globalThis.fetch = async url => {
    const target = String(url);
    if (target.includes('/sendDocument')) {
      counts.document++;
      if (docGate) await docGate;
      return Response.json({ ok: true, result: { message_id: 100 + counts.document,
        document: { file_id: 'original-file', file_unique_id: 'original-unique', file_size: image.size,
          mime_type: 'image/jpeg' } } });
    }
    if (target.includes('/sendPhoto')) {
      counts.preview++;
      if (photoGate) await photoGate;
      if (counts.preview <= previewFailures)
        return Response.json({ ok: false, error_code: 500, description: 'temporary' }, { status: 500 });
      return Response.json({ ok: true, result: { message_id: 200 + counts.preview,
        photo: [{ file_id: 'preview-file', file_unique_id: 'preview-unique', width: 800,
          height: 600, file_size: 1000 }] } });
    }
    throw new Error(`Unexpected external request: ${target}`);
  };
  return counts;
}

async function upload(db, id = 'client-upload') {
  const body = new FormData();
  body.append('file', image, 'photo.jpg');
  body.append('client_upload_id', id);
  body.append('photo_preview', '1');
  const response = await worker.fetch(new Request('https://worker.test/api/spreads/srv-spE/photos', {
    method: 'POST', headers: { Authorization: 'Bearer token-1' }, body,
  }), { DB: db, CHAT_ID: '-100555777', BOT_TOKEN: 'test-token' });
  return { status: response.status, body: await response.json() };
}

try {
  {
    const db = new DualPreviewD1();
    try {
      const counts = telegramMock();
      const first = await upload(db);
      assert.equal(first.status, 200);
      assert.deepEqual(counts, { document: 1, preview: 1 });
      assert.equal(db.photos.length, 1);
      assert.equal(db.photos[0].provider, 'telegram');
      assert.equal(db.uploads.length, 1);
      assert.equal(db.uploads[0].photo_id, db.photos[0].id);
      assert.equal(db.sqlite.prepare('PRAGMA foreign_key_check').all().length, 0);
      assert.equal(first.body.telegram_method, 'document+photo');
      assert.equal(first.body.photo.telegram_file_id, 'original-file');
      const retry = await upload(db);
      assert.equal(retry.status, 200);
      assert.deepEqual(counts, { document: 1, preview: 1 }, 'lost response replays the same logical photo');
      assert.equal(retry.body.photo_id, first.body.photo_id);
    } finally { db.close(); }
  }
  {
    const db = new DualPreviewD1();
    try {
      const counts = telegramMock({ previewFailures: 1 });
      const first = await upload(db);
      assert.equal(first.status, 200);
      assert.equal(first.body.preview_pending, true);
      assert.deepEqual(counts, { document: 1, preview: 1 });
      const retry = await upload(db);
      assert.equal(retry.status, 200);
      assert.equal(retry.body.preview_pending, false);
      assert.deepEqual(counts, { document: 1, preview: 2 });
      assert.equal(db.photos.length, 1);
    } finally { db.close(); }
  }
  {
    // If the second statement of the reservation fails, D1.batch rolls back the first.
    const db = new DualPreviewD1();
    try {
      const counts = telegramMock();
      let once = true;
      db.beforeBatchStatement = (_statement, index) => {
        if (once && index === 1) { once = false; throw new Error('injected reservation crash'); }
      };
      const failed = await upload(db);
      assert.equal(failed.status, 500);
      assert.equal(db.photos.length, 0);
      assert.equal(db.uploads.length, 0);
      assert.deepEqual(counts, { document: 0, preview: 0 });
      db.beforeBatchStatement = null;
      assert.equal((await upload(db)).status, 200);
      assert.deepEqual(counts, { document: 1, preview: 1 });
    } finally { db.close(); }
  }
  {
    // Telegram may have accepted the document while the Worker crashes before persisting its
    // identifiers. No API can infer that result, so retries must NOT send another original.
    const db = new DualPreviewD1();
    try {
      const counts = telegramMock();
      let once = true;
      db.beforeRun = (sql, params) => {
        if (once && sql.startsWith('UPDATE uploads SET') && String(params[1]).includes('document_stored')) {
          once = false;
          throw new Error('injected crash after sendDocument');
        }
      };
      const failed = await upload(db);
      assert.equal(failed.status, 500);
      assert.deepEqual(counts, { document: 1, preview: 0 });
      assert.equal(db.photos[0].provider, 'upload_pending');
      assert.equal(JSON.parse(db.uploads[0].result_json).extras.phase, 'sending');
      const hidden = await worker.fetch(new Request(`https://worker.test/api/photos/${db.photos[0].id}`, {
        headers: { Authorization: 'Bearer token-1' },
      }), { DB: db, CHAT_ID: '-100555777', BOT_TOKEN: 'test-token' });
      assert.equal(hidden.status, 404, 'provisional photo is not public');
      db.beforeRun = null;
      const retry = await upload(db);
      assert.equal(retry.status, 503, 'uncertain Telegram outcome remains explicit and retryable');
      assert.deepEqual(counts, { document: 1, preview: 0 }, 'never send a duplicate document');
    } finally { db.close(); }
  }
  {
    // Before the CAS claim, no Telegram call can have started; a retry can safely take over.
    const db = new DualPreviewD1();
    try {
      const counts = telegramMock();
      let once = true;
      db.beforeRun = (sql, params) => {
        if (once && sql.startsWith('UPDATE uploads SET') && String(params[1]).includes('"phase":"sending"')) {
          once = false;
          throw new Error('injected crash before document claim');
        }
      };
      assert.equal((await upload(db)).status, 500);
      assert.equal(JSON.parse(db.uploads[0].result_json).extras.phase, 'reserved');
      assert.deepEqual(counts, { document: 0, preview: 0 });
      db.beforeRun = null;
      assert.equal((await upload(db)).status, 200);
      assert.deepEqual(counts, { document: 1, preview: 1 });
    } finally { db.close(); }
  }
  {
    // A fully persisted document can be adopted after finalization transaction failure.
    const db = new DualPreviewD1();
    try {
      const counts = telegramMock();
      let once = true;
      db.beforeBatchStatement = (statement, index) => {
        if (once && index === 0 && statement.sql.startsWith('UPDATE photos SET is_current=0')) {
          once = false;
          throw new Error('injected finalization crash');
        }
      };
      const failed = await upload(db);
      assert.equal(failed.status, 500);
      assert.equal(db.photos[0].provider, 'upload_pending');
      assert.equal(JSON.parse(db.uploads[0].result_json).extras.doc.file_id, 'original-file');
      db.beforeBatchStatement = null;
      const recovered = await upload(db);
      assert.equal(recovered.status, 200);
      assert.equal(db.photos[0].provider, 'telegram');
      assert.deepEqual(counts, { document: 1, preview: 1 });
    } finally { db.close(); }
  }
  {
    const db = new DualPreviewD1();
    try {
      let releaseDocument;
      const gate = new Promise(resolve => { releaseDocument = resolve; });
      const counts = telegramMock({ docGate: gate });
      const owner = upload(db);
      while (counts.document === 0) await new Promise(resolve => setTimeout(resolve, 5));
      const follower = upload(db);
      releaseDocument();
      const results = await Promise.all([owner, follower]);
      assert.ok(results.every(result => result.status === 200));
      assert.deepEqual(counts, { document: 1, preview: 1 });
      assert.equal(db.photos.length, 1);
      assert.equal(db.uploads.length, 1);
      assert.equal(db.sqlite.prepare('PRAGMA foreign_key_check').all().length, 0);
    } finally { db.close(); }
  }
  console.log('dual-preview-fk: PASS (real FK, rollback, uncertain crash, retry, lost response, parallel)');
} finally {
  globalThis.fetch = originalFetch;
}
