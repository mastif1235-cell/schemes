/**
 * Блокнот-скан — backend API (Cloudflare Worker + D1)  v2
 * ---------------------------------------------------------
 * Заменяет старый однофункциональный worker.js (только /upload).
 * Причина замены: в multi-user режиме приём фото и чтение/запись данных
 * обязаны проверять сессию и membership на каждом запросе (требование
 * безопасности из ТЗ) — анонимный /upload было бы дырой. Логика похода
 * в Telegram (sendDocument) переиспользована как есть, просто теперь
 * вызывается изнутри авторизованного маршрута.
 *
 * D1 таблицы — см. schema.sql. Bot token и chat_id — только в Secrets,
 * frontend их не получает никогда, ни в каком виде.
 *
 * Секреты и биндинги (см. README-v2.md):
 *   wrangler secret put BOT_TOKEN
 *   wrangler secret put CHAT_ID
 *   wrangler secret put BOOTSTRAP_SECRET
 *   [[d1_databases]] binding = "DB"  database_name = "blocknot"
 */

// ---------------------------------------------------------------- helpers

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}
function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...cors() } });
}
function err(status, code, detail) {
  return json({ error: code, detail: detail || null }, status);
}
function nowISO() { return new Date().toISOString(); }
function uuid() { return crypto.randomUUID(); }

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}
function randomCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 12);
}
function normalizeTag(name) {
  return name.toLowerCase().normalize('NFKD').replace(/\s+/g, ' ').trim();
}
function normalizeSearch(s) {
  return (s || '').toLowerCase().normalize('NFKD').replace(/\s+/g, ' ').trim();
}

async function nextSeq(env) {
  const r = await env.DB.prepare('INSERT INTO change_seq(at) VALUES (?)').bind(nowISO()).run();
  return r.meta.last_row_id;
}

async function authenticate(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const m = auth.match(/^Bearer\s+(.+)$/);
  if (!m) return null;
  const hash = await sha256Hex(m[1]);
  const row = await env.DB.prepare(
    `SELECT s.id as session_id, s.user_id, s.expires_at, s.revoked_at, u.display_name
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ?`
  ).bind(hash).first();
  if (!row || row.revoked_at || new Date(row.expires_at) < new Date()) return null;
  env.DB.prepare('UPDATE sessions SET last_used_at=? WHERE id=?').bind(nowISO(), row.session_id).run().catch(() => {});
  return { userId: row.user_id, sessionId: row.session_id, displayName: row.display_name };
}
async function requireAuth(request, env) {
  const u = await authenticate(request, env);
  if (!u) throw new HttpError(401, 'unauthorized');
  return u;
}
async function requireMembership(env, userId, notebookId, needOwner = false) {
  const row = await env.DB.prepare(
    'SELECT role FROM notebook_members WHERE notebook_id=? AND user_id=? AND revoked_at IS NULL'
  ).bind(notebookId, userId).first();
  if (!row) throw new HttpError(403, 'no_access');
  if (needOwner && row.role !== 'OWNER') throw new HttpError(403, 'owner_required');
  return row.role;
}
class HttpError extends Error {
  constructor(status, code, detail) { super(code); this.status = status; this.code = code; this.detail = detail; }
}
async function logHistory(env, { notebook_id, entity, entity_id, user_id, action }) {
  await env.DB.prepare(
    `INSERT INTO history (id, notebook_id, entity, entity_id, user_id, action, created_at) VALUES (?,?,?,?,?,?,?)`
  ).bind(uuid(), notebook_id, entity, entity_id, user_id, action, nowISO()).run();
}

// -------------------------------------------------------------- Telegram

async function telegramSendDocument(env, blob, filename) {
  const fd = new FormData();
  fd.append('chat_id', env.CHAT_ID);
  fd.append('document', blob, filename);
  const resp = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendDocument`, { method: 'POST', body: fd });
  const data = await resp.json();
  if (!data.ok) {
    console.error('TELEGRAM SEND ERROR:', {
      httpStatus: resp.status,
      errorCode: data.error_code,
      description: data.description
    });
    throw new HttpError(502, 'telegram_error', data.description);
  }
  return data.result;
}
function telegramLink(chatId, messageId) {
  const raw = String(chatId).replace(/^-100/, '');
  return `https://t.me/c/${raw}/${messageId}`;
}
async function telegramFetchFile(env, fileId) {
  const infoResp = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/getFile?file_id=${encodeURIComponent(fileId)}`);
  const info = await infoResp.json();
  if (!info.ok) throw new HttpError(502, 'telegram_error', info.description);
  const fileUrl = `https://api.telegram.org/file/bot${env.BOT_TOKEN}/${info.result.file_path}`;
  const fileResp = await fetch(fileUrl); // server-side only — token never reaches the client
  return fileResp;
}
function encodeStorageObjectId(chatId, messageId) {
  return btoa(`${chatId}:${messageId}`);
}
function decodeStorageObjectId(id) {
  try {
    const [chatId, messageId] = atob(id).split(':');
    return { chatId, messageId };
  } catch { return null; }
}

// ------------------------------------------------------------- route map

const routes = [];
function on(method, pattern, handler) { routes.push({ method, pattern, handler }); }
function matchRoute(pathname, pattern) {
  const pParts = pattern.split('/').filter(Boolean);
  const parts = pathname.split('/').filter(Boolean);
  if (pParts.length !== parts.length) return null;
  const params = {};
  for (let i = 0; i < pParts.length; i++) {
    if (pParts[i].startsWith(':')) params[pParts[i].slice(1)] = decodeURIComponent(parts[i]);
    else if (pParts[i] !== parts[i]) return null;
  }
  return params;
}

// ==================================================================
// AUTH
// ==================================================================

on('POST', '/api/auth/bootstrap', async (request, env) => {
  const body = await request.json();
  if (!env.BOOTSTRAP_SECRET || body.secret !== env.BOOTSTRAP_SECRET) return err(403, 'invalid_bootstrap_secret');
  const existing = await env.DB.prepare('SELECT COUNT(*) as c FROM users').first();
  if (existing.c > 0) return err(409, 'already_bootstrapped');

  const userId = uuid();
  await env.DB.prepare('INSERT INTO users (id, display_name, created_at) VALUES (?,?,?)')
    .bind(userId, body.display_name || 'Owner', nowISO()).run();

  const token = randomToken();
  const tokenHash = await sha256Hex(token);
  const sessionId = uuid();
  const expires = new Date(Date.now() + 1000 * 60 * 60 * 24 * 180).toISOString();
  await env.DB.prepare(
    `INSERT INTO sessions (id, user_id, token_hash, device_name, created_at, expires_at) VALUES (?,?,?,?,?,?)`
  ).bind(sessionId, userId, tokenHash, body.device_name || 'device', nowISO(), expires).run();

  return json({ token, user: { id: userId, display_name: body.display_name || 'Owner' } });
});

on('POST', '/api/auth/redeem-invite', async (request, env) => {
  const body = await request.json();
  if (!body.code) return err(400, 'code_required');
  const codeHash = await sha256Hex(body.code);
  const invite = await env.DB.prepare('SELECT * FROM invites WHERE code_hash=?').bind(codeHash).first();
  if (!invite) return err(404, 'invite_not_found');
  if (invite.used_by) return err(409, 'invite_already_used');
  if (invite.expires_at && new Date(invite.expires_at) < new Date()) return err(410, 'invite_expired');

  const existingAuth = await authenticate(request, env);
  let userId = existingAuth ? existingAuth.userId : uuid();
  if (!existingAuth) {
    await env.DB.prepare('INSERT INTO users (id, display_name, created_at) VALUES (?,?,?)')
      .bind(userId, body.display_name || 'Напарник', nowISO()).run();
  }

  const seq = await nextSeq(env);
  const already = await env.DB.prepare(
    'SELECT 1 FROM notebook_members WHERE notebook_id=? AND user_id=?'
  ).bind(invite.notebook_id, userId).first();
  if (!already) {
    await env.DB.prepare(
      `INSERT INTO notebook_members (notebook_id, user_id, role, added_at, updated_at, seq) VALUES (?,?,?,?,?,?)`
    ).bind(invite.notebook_id, userId, invite.role, nowISO(), nowISO(), seq).run();
  } else {
    await env.DB.prepare(
      `UPDATE notebook_members SET role=?, revoked_at=NULL, updated_at=?, seq=? WHERE notebook_id=? AND user_id=?`
    ).bind(invite.role, nowISO(), seq, invite.notebook_id, userId).run();
  }
  await env.DB.prepare('UPDATE invites SET used_by=?, used_at=? WHERE id=?').bind(userId, nowISO(), invite.id).run();
  await logHistory(env, { notebook_id: invite.notebook_id, entity: 'member', entity_id: userId, user_id: userId, action: 'member_added' });

  let token, user;
  if (existingAuth) {
    token = null;
    user = { id: userId };
  } else {
    token = randomToken();
    const tokenHash = await sha256Hex(token);
    const sessionId = uuid();
    const expires = new Date(Date.now() + 1000 * 60 * 60 * 24 * 180).toISOString();
    await env.DB.prepare(
      `INSERT INTO sessions (id, user_id, token_hash, device_name, created_at, expires_at) VALUES (?,?,?,?,?,?)`
    ).bind(sessionId, userId, tokenHash, body.device_name || 'device', nowISO(), expires).run();
    user = { id: userId, display_name: body.display_name || 'Напарник' };
  }
  return json({ token, user, notebook_id: invite.notebook_id });
});

on('POST', '/api/auth/logout', async (request, env) => {
  const u = await requireAuth(request, env);
  await env.DB.prepare('UPDATE sessions SET revoked_at=? WHERE id=?').bind(nowISO(), u.sessionId).run();
  return json({ ok: true });
});

on('GET', '/api/me', async (request, env) => {
  const u = await requireAuth(request, env);
  const devices = await env.DB.prepare(
    'SELECT id, device_name, created_at, last_used_at, expires_at FROM sessions WHERE user_id=? AND revoked_at IS NULL ORDER BY last_used_at DESC'
  ).bind(u.userId).all();
  return json({ user: { id: u.userId, display_name: u.displayName }, devices: devices.results });
});

on('DELETE', '/api/me/sessions/:id', async (request, env, p) => {
  const u = await requireAuth(request, env);
  await env.DB.prepare('UPDATE sessions SET revoked_at=? WHERE id=? AND user_id=?').bind(nowISO(), p.id, u.userId).run();
  return json({ ok: true });
});

// ==================================================================
// INVITES
// ==================================================================

on('POST', '/api/invites', async (request, env) => {
  const u = await requireAuth(request, env);
  const body = await request.json();
  await requireMembership(env, u.userId, body.notebook_id, true);
  const code = randomCode();
  const codeHash = await sha256Hex(code);
  const id = uuid();
  const expires = body.expires_in_days ? new Date(Date.now() + body.expires_in_days * 86400000).toISOString() : new Date(Date.now() + 7 * 86400000).toISOString();
  await env.DB.prepare(
    `INSERT INTO invites (id, notebook_id, code_hash, role, created_by, created_at, expires_at) VALUES (?,?,?,?,?,?,?)`
  ).bind(id, body.notebook_id, codeHash, body.role || 'MEMBER', u.userId, nowISO(), expires).run();
  return json({ id, code, expires_at: expires });
});

on('GET', '/api/invites', async (request, env) => {
  const u = await requireAuth(request, env);
  const notebookId = new URL(request.url).searchParams.get('notebook_id');
  await requireMembership(env, u.userId, notebookId, true);
  const rows = await env.DB.prepare(
    'SELECT id, role, created_at, expires_at, used_by, used_at FROM invites WHERE notebook_id=?'
  ).bind(notebookId).all();
  return json({ invites: rows.results });
});

on('DELETE', '/api/invites/:id', async (request, env, p) => {
  const u = await requireAuth(request, env);
  const invite = await env.DB.prepare('SELECT * FROM invites WHERE id=?').bind(p.id).first();
  if (!invite) return err(404, 'not_found');
  await requireMembership(env, u.userId, invite.notebook_id, true);
  await env.DB.prepare('DELETE FROM invites WHERE id=?').bind(p.id).run();
  return json({ ok: true });
});

// ==================================================================
// NOTEBOOKS
// ==================================================================

on('GET', '/api/notebooks', async (request, env) => {
  const u = await requireAuth(request, env);
  const rows = await env.DB.prepare(
    `SELECT n.* FROM notebooks n
     JOIN notebook_members m ON m.notebook_id = n.id
     WHERE m.user_id=? AND m.revoked_at IS NULL AND n.deleted_at IS NULL`
  ).bind(u.userId).all();
  return json({ notebooks: rows.results });
});

on('POST', '/api/notebooks', async (request, env) => {
  const u = await requireAuth(request, env);
  const body = await request.json();
  if (body.client_ref) {
    const existing = await env.DB.prepare('SELECT * FROM notebooks WHERE created_by=? AND client_ref=?').bind(u.userId, body.client_ref).first();
    if (existing) return json({ notebook: existing });
  }
  const id = uuid();
  const seq = await nextSeq(env);
  const now = nowISO();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO notebooks (id, owner_id, created_by, title, description, archived, sort_order, created_at, updated_at, revision, seq, client_ref)
       VALUES (?,?,?,?,?,0,?,?,?,1,?,?)`
    ).bind(id, u.userId, u.userId, body.title, body.description || null, body.sort_order || 0, now, now, seq, body.client_ref || null),
    env.DB.prepare(
      `INSERT INTO notebook_members (notebook_id, user_id, role, added_at, updated_at, seq) VALUES (?,?,?,?,?,?)`
    ).bind(id, u.userId, 'OWNER', now, now, seq),
  ]);
  await logHistory(env, { notebook_id: id, entity: 'notebook', entity_id: id, user_id: u.userId, action: 'notebook_created' });
  const notebook = await env.DB.prepare('SELECT * FROM notebooks WHERE id=?').bind(id).first();
  return json({ notebook });
});

on('GET', '/api/notebooks/:id', async (request, env, p) => {
  const u = await requireAuth(request, env);
  await requireMembership(env, u.userId, p.id);
  const notebook = await env.DB.prepare('SELECT * FROM notebooks WHERE id=?').bind(p.id).first();
  if (!notebook) return err(404, 'not_found');
  return json({ notebook });
});

on('PATCH', '/api/notebooks/:id', async (request, env, p) => {
  const u = await requireAuth(request, env);
  await requireMembership(env, u.userId, p.id);
  const body = await request.json();
  const current = await env.DB.prepare('SELECT * FROM notebooks WHERE id=?').bind(p.id).first();
  if (!current) return err(404, 'not_found');
  if (body.revision !== undefined && body.revision !== current.revision) {
    return json({ error: 'conflict', server_copy: current }, 409);
  }
  const seq = await nextSeq(env);
  const now = nowISO();
  const r = await env.DB.prepare(
    `UPDATE notebooks SET title=COALESCE(?,title), description=COALESCE(?,description), archived=COALESCE(?,archived),
     sort_order=COALESCE(?,sort_order), updated_at=?, revision=revision+1, seq=? WHERE id=? AND revision=?`
  ).bind(body.title ?? null, body.description ?? null, body.archived === undefined ? null : (body.archived ? 1 : 0),
    body.sort_order ?? null, now, seq, p.id, current.revision).run();
  if (r.meta.changes === 0) {
    const fresh = await env.DB.prepare('SELECT * FROM notebooks WHERE id=?').bind(p.id).first();
    return json({ error: 'conflict', server_copy: fresh }, 409);
  }
  const updated = await env.DB.prepare('SELECT * FROM notebooks WHERE id=?').bind(p.id).first();
  return json({ notebook: updated });
});

on('DELETE', '/api/notebooks/:id', async (request, env, p) => {
  const u = await requireAuth(request, env);
  await requireMembership(env, u.userId, p.id, true);
  const seq = await nextSeq(env);
  await env.DB.prepare('UPDATE notebooks SET deleted_at=?, deleted_by=?, seq=? WHERE id=?').bind(nowISO(), u.userId, seq, p.id).run();
  await logHistory(env, { notebook_id: p.id, entity: 'notebook', entity_id: p.id, user_id: u.userId, action: 'notebook_deleted' });
  return json({ ok: true });
});

on('GET', '/api/notebooks/:id/snapshot', async (request, env, p) => {
  const u = await requireAuth(request, env);
  await requireMembership(env, u.userId, p.id);
  const notebook = await env.DB.prepare('SELECT * FROM notebooks WHERE id=?').bind(p.id).first();
  const spreads = await env.DB.prepare('SELECT * FROM spreads WHERE notebook_id=?').bind(p.id).all();
  const spreadIds = spreads.results.map(s => s.id);
  let photos = { results: [] }, tags = { results: [] }, spreadTags = { results: [] }, favorites = { results: [] };
  if (spreadIds.length) {
    const placeholders = spreadIds.map(() => '?').join(',');
    photos = await env.DB.prepare(`SELECT * FROM photos WHERE spread_id IN (${placeholders})`).bind(...spreadIds).all();
    spreadTags = await env.DB.prepare(`SELECT * FROM spread_tags WHERE spread_id IN (${placeholders})`).bind(...spreadIds).all();
    favorites = await env.DB.prepare(`SELECT * FROM user_favorites WHERE user_id=? AND spread_id IN (${placeholders})`).bind(u.userId, ...spreadIds).all();
  }
  tags = await env.DB.prepare('SELECT * FROM tags WHERE notebook_id=?').bind(p.id).all();
  const members = await env.DB.prepare('SELECT * FROM notebook_members WHERE notebook_id=?').bind(p.id).all();
  const cursorRow = await env.DB.prepare('SELECT MAX(seq) as m FROM change_seq').first();
  return json({
    notebook, spreads: spreads.results, photos: photos.results, tags: tags.results,
    spread_tags: spreadTags.results, favorites: favorites.results, members: members.results,
    cursor: cursorRow.m || 0,
  });
});

// ==================================================================
// MEMBERS
// ==================================================================

on('GET', '/api/notebooks/:id/members', async (request, env, p) => {
  const u = await requireAuth(request, env);
  await requireMembership(env, u.userId, p.id);
  const rows = await env.DB.prepare(
    `SELECT m.*, us.display_name FROM notebook_members m JOIN users us ON us.id=m.user_id WHERE m.notebook_id=? AND m.revoked_at IS NULL`
  ).bind(p.id).all();
  return json({ members: rows.results });
});

on('POST', '/api/notebooks/:id/members', async (request, env, p) => {
  const u = await requireAuth(request, env);
  await requireMembership(env, u.userId, p.id, true);
  const body = await request.json();
  const seq = await nextSeq(env);
  const now = nowISO();
  await env.DB.prepare(
    `INSERT INTO notebook_members (notebook_id, user_id, role, added_at, updated_at, seq) VALUES (?,?,?,?,?,?)
     ON CONFLICT(notebook_id, user_id) DO UPDATE SET role=excluded.role, revoked_at=NULL, updated_at=excluded.updated_at, seq=excluded.seq`
  ).bind(p.id, body.user_id, body.role || 'MEMBER', now, now, seq).run();
  await logHistory(env, { notebook_id: p.id, entity: 'member', entity_id: body.user_id, user_id: u.userId, action: 'member_added' });
  return json({ ok: true });
});

on('DELETE', '/api/notebooks/:id/members/:userId', async (request, env, p) => {
  const u = await requireAuth(request, env);
  await requireMembership(env, u.userId, p.id, true);
  const seq = await nextSeq(env);
  await env.DB.prepare('UPDATE notebook_members SET revoked_at=?, updated_at=?, seq=? WHERE notebook_id=? AND user_id=?')
    .bind(nowISO(), nowISO(), seq, p.id, p.userId).run();
  await logHistory(env, { notebook_id: p.id, entity: 'member', entity_id: p.userId, user_id: u.userId, action: 'member_removed' });
  return json({ ok: true });
});

// ==================================================================
// SPREADS
// ==================================================================

on('GET', '/api/notebooks/:id/spreads', async (request, env, p) => {
  const u = await requireAuth(request, env);
  await requireMembership(env, u.userId, p.id);
  const rows = await env.DB.prepare('SELECT * FROM spreads WHERE notebook_id=? AND deleted_at IS NULL').bind(p.id).all();
  return json({ spreads: rows.results });
});

on('POST', '/api/notebooks/:id/spreads', async (request, env, p) => {
  const u = await requireAuth(request, env);
  await requireMembership(env, u.userId, p.id);
  const body = await request.json();
  if (body.client_ref) {
    const existing = await env.DB.prepare('SELECT * FROM spreads WHERE created_by=? AND client_ref=?').bind(u.userId, body.client_ref).first();
    if (existing) return json({ spread: existing });
  }
  const id = uuid();
  const seq = await nextSeq(env);
  const now = nowISO();
  const searchable = normalizeSearch([body.number, body.title, body.note_short, body.note_full].join(' '));
  try {
    await env.DB.prepare(
      `INSERT INTO spreads (id, notebook_id, number, title, note_short, note_full, status, searchableText,
        created_by, created_at, updated_by, updated_at, revision, seq, client_ref)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)`
    ).bind(id, p.id, body.number, body.title || null, body.note_short || null, body.note_full || null,
      body.status || 'Актуально', searchable, u.userId, now, u.userId, now, seq, body.client_ref || null).run();
  } catch (e) {
    return err(409, 'duplicate_number', String(e));
  }
  await logHistory(env, { notebook_id: p.id, entity: 'spread', entity_id: id, user_id: u.userId, action: 'spread_created' });
  const spread = await env.DB.prepare('SELECT * FROM spreads WHERE id=?').bind(id).first();
  return json({ spread });
});

on('GET', '/api/spreads/:id', async (request, env, p) => {
  const u = await requireAuth(request, env);
  const spread = await env.DB.prepare('SELECT * FROM spreads WHERE id=?').bind(p.id).first();
  if (!spread) return err(404, 'not_found');
  await requireMembership(env, u.userId, spread.notebook_id);
  return json({ spread });
});

on('PATCH', '/api/spreads/:id', async (request, env, p) => {
  const u = await requireAuth(request, env);
  const current = await env.DB.prepare('SELECT * FROM spreads WHERE id=?').bind(p.id).first();
  if (!current) return err(404, 'not_found');
  await requireMembership(env, u.userId, current.notebook_id);
  const body = await request.json();
  if (body.revision !== undefined && body.revision !== current.revision) {
    return json({ error: 'conflict', server_copy: current }, 409);
  }
  const seq = await nextSeq(env);
  const now = nowISO();
  const title = body.title ?? current.title, note_short = body.note_short ?? current.note_short,
    note_full = body.note_full ?? current.note_full, number = body.number ?? current.number,
    status = body.status ?? current.status;
  const searchable = normalizeSearch([number, title, note_short, note_full].join(' '));
  let r;
  try {
    r = await env.DB.prepare(
      `UPDATE spreads SET number=?, title=?, note_short=?, note_full=?, status=?, searchableText=?,
       updated_by=?, updated_at=?, revision=revision+1, seq=? WHERE id=? AND revision=?`
    ).bind(number, title, note_short, note_full, status, searchable, u.userId, now, seq, p.id, current.revision).run();
  } catch (e) {
    return err(409, 'duplicate_number', String(e));
  }
  if (r.meta.changes === 0) {
    const fresh = await env.DB.prepare('SELECT * FROM spreads WHERE id=?').bind(p.id).first();
    return json({ error: 'conflict', server_copy: fresh }, 409);
  }
  await logHistory(env, { notebook_id: current.notebook_id, entity: 'spread', entity_id: p.id, user_id: u.userId, action: 'spread_updated' });
  const updated = await env.DB.prepare('SELECT * FROM spreads WHERE id=?').bind(p.id).first();
  return json({ spread: updated });
});

on('DELETE', '/api/spreads/:id', async (request, env, p) => {
  const u = await requireAuth(request, env);
  const current = await env.DB.prepare('SELECT * FROM spreads WHERE id=?').bind(p.id).first();
  if (!current) return err(404, 'not_found');
  await requireMembership(env, u.userId, current.notebook_id);
  const seq = await nextSeq(env);
  await env.DB.prepare('UPDATE spreads SET deleted_at=?, deleted_by=?, seq=? WHERE id=?').bind(nowISO(), u.userId, seq, p.id).run();
  await logHistory(env, { notebook_id: current.notebook_id, entity: 'spread', entity_id: p.id, user_id: u.userId, action: 'spread_deleted' });
  return json({ ok: true });
});

// ==================================================================
// PHOTOS
// ==================================================================

on('POST', '/api/spreads/:id/photos', async (request, env, p) => {
  const u = await requireAuth(request, env);
  const spread = await env.DB.prepare('SELECT * FROM spreads WHERE id=?').bind(p.id).first();
  if (!spread) return err(404, 'not_found');
  await requireMembership(env, u.userId, spread.notebook_id);

  const form = await request.formData();
  const file = form.get('file');
  const preview = form.get('preview');
  const clientUploadId = form.get('client_upload_id');
  if (!file || !clientUploadId) return err(400, 'file_and_client_upload_id_required');

  const existingUpload = await env.DB.prepare('SELECT * FROM uploads WHERE client_upload_id=?').bind(clientUploadId).first();
  if (existingUpload) return json(JSON.parse(existingUpload.result_json));

  const maxVersionRow = await env.DB.prepare('SELECT MAX(version) as v FROM photos WHERE spread_id=?').bind(p.id).first();
  const version = (maxVersionRow.v || 0) + 1;

  const tgResult = await telegramSendDocument(env, file, `spread_${p.id}_v${version}`);
  const doc = tgResult.document;
  const storageObjectId = encodeStorageObjectId(env.CHAT_ID, tgResult.message_id);

  const photoId = uuid();
  const seq = await nextSeq(env);
  const now = nowISO();

  const statements = [
    env.DB.prepare('UPDATE photos SET is_current=0 WHERE spread_id=? AND is_current=1').bind(p.id),
    env.DB.prepare(
      `INSERT INTO photos (id, spread_id, version, is_current, provider, storage_object_id, telegram_message_id,
        telegram_file_id, telegram_file_unique_id, mime_type, file_size, created_by, created_at, seq, client_upload_id)
       VALUES (?,?,?,1,'telegram',?,?,?,?,?,?,?,?,?,?)`
    ).bind(photoId, p.id, version, storageObjectId, tgResult.message_id, doc.file_id, doc.file_unique_id,
      doc.mime_type || file.type, doc.file_size, u.userId, now, seq, clientUploadId),
    env.DB.prepare('UPDATE spreads SET current_photo_id=?, updated_at=?, updated_by=?, revision=revision+1, seq=? WHERE id=?')
      .bind(photoId, now, u.userId, seq, p.id),
  ];
  if (preview) {
    const previewBuf = await preview.arrayBuffer();
    const previewB64 = btoa(String.fromCharCode(...new Uint8Array(previewBuf)));
    statements.push(env.DB.prepare(
      `INSERT INTO photo_previews (photo_id, preview_base64, mime_type, created_at) VALUES (?,?,?,?)`
    ).bind(photoId, previewB64, preview.type || 'image/webp', now));
  }
  await env.DB.batch(statements);

  const spreadFresh = await env.DB.prepare('SELECT revision FROM spreads WHERE id=?').bind(p.id).first();
  const result = {
    photo_id: photoId, storage_object_id: storageObjectId, message_id: tgResult.message_id,
    file_id: doc.file_id, file_unique_id: doc.file_unique_id, mime_type: doc.mime_type || file.type,
    file_size: doc.file_size, telegram_link: telegramLink(env.CHAT_ID, tgResult.message_id),
    version, seq, spread_revision: spreadFresh.revision,
  };
  await env.DB.prepare('INSERT INTO uploads (client_upload_id, photo_id, result_json, created_at) VALUES (?,?,?,?)')
    .bind(clientUploadId, photoId, JSON.stringify(result), now).run();
  await logHistory(env, { notebook_id: spread.notebook_id, entity: 'spread', entity_id: p.id, user_id: u.userId, action: 'photo_added' });
  return json(result);
});

on('GET', '/api/photos/:id', async (request, env, p) => {
  const u = await requireAuth(request, env);
  const photo = await env.DB.prepare('SELECT * FROM photos WHERE id=?').bind(p.id).first();
  if (!photo) return err(404, 'not_found');
  const spread = await env.DB.prepare('SELECT notebook_id FROM spreads WHERE id=?').bind(photo.spread_id).first();
  await requireMembership(env, u.userId, spread.notebook_id);
  return json({ photo });
});

on('GET', '/api/photos/:id/preview', async (request, env, p) => {
  const u = await requireAuth(request, env);
  const photo = await env.DB.prepare('SELECT * FROM photos WHERE id=?').bind(p.id).first();
  if (!photo) return err(404, 'not_found');
  const spread = await env.DB.prepare('SELECT notebook_id FROM spreads WHERE id=?').bind(photo.spread_id).first();
  await requireMembership(env, u.userId, spread.notebook_id);
  const prev = await env.DB.prepare('SELECT * FROM photo_previews WHERE photo_id=?').bind(p.id).first();
  if (!prev) return err(404, 'no_preview');
  const bytes = Uint8Array.from(atob(prev.preview_base64), c => c.charCodeAt(0));
  return new Response(bytes, { headers: { 'Content-Type': prev.mime_type, 'Cache-Control': 'private, max-age=86400', ...cors() } });
});

on('GET', '/api/photos/:id/file', async (request, env, p) => {
  const u = await requireAuth(request, env);
  const photo = await env.DB.prepare('SELECT * FROM photos WHERE id=?').bind(p.id).first();
  if (!photo) return err(404, 'not_found');
  const spread = await env.DB.prepare('SELECT notebook_id FROM spreads WHERE id=?').bind(photo.spread_id).first();
  await requireMembership(env, u.userId, spread.notebook_id);
  if (!photo.telegram_file_id) return err(404, 'no_file');
  const fileResp = await telegramFetchFile(env, photo.telegram_file_id);
  return new Response(fileResp.body, {
    headers: { 'Content-Type': photo.mime_type || 'application/octet-stream', 'Cache-Control': 'private, max-age=86400', ...cors() },
  });
});

on('POST', '/api/spreads/:id/photos/:photoId/make-current', async (request, env, p) => {
  const u = await requireAuth(request, env);
  const spread = await env.DB.prepare('SELECT * FROM spreads WHERE id=?').bind(p.id).first();
  if (!spread) return err(404, 'not_found');
  await requireMembership(env, u.userId, spread.notebook_id);
  const photo = await env.DB.prepare('SELECT * FROM photos WHERE id=? AND spread_id=?').bind(p.photoId, p.id).first();
  if (!photo) return err(404, 'photo_not_found');
  const seq = await nextSeq(env);
  const now = nowISO();
  await env.DB.batch([
    env.DB.prepare('UPDATE photos SET is_current=0 WHERE spread_id=? AND is_current=1').bind(p.id),
    env.DB.prepare('UPDATE photos SET is_current=1, seq=? WHERE id=?').bind(seq, p.photoId),
    env.DB.prepare('UPDATE spreads SET current_photo_id=?, updated_at=?, updated_by=?, revision=revision+1, seq=? WHERE id=?')
      .bind(p.photoId, now, u.userId, seq, p.id),
  ]);
  return json({ ok: true });
});

// ==================================================================
// TAGS  (per-notebook — см. п.5 требований)
// ==================================================================

on('GET', '/api/notebooks/:id/tags', async (request, env, p) => {
  const u = await requireAuth(request, env);
  await requireMembership(env, u.userId, p.id);
  const rows = await env.DB.prepare('SELECT * FROM tags WHERE notebook_id=? AND deleted_at IS NULL').bind(p.id).all();
  return json({ tags: rows.results });
});

on('POST', '/api/notebooks/:id/tags', async (request, env, p) => {
  const u = await requireAuth(request, env);
  await requireMembership(env, u.userId, p.id);
  const body = await request.json();
  const norm = normalizeTag(body.name || '');
  if (!norm) return err(400, 'name_required');
  const existing = await env.DB.prepare('SELECT * FROM tags WHERE notebook_id=? AND normalized_name=?').bind(p.id, norm).first();
  if (existing) return json({ tag: existing });
  const id = uuid();
  const seq = await nextSeq(env);
  await env.DB.prepare('INSERT INTO tags (id, notebook_id, name, normalized_name, seq) VALUES (?,?,?,?,?)')
    .bind(id, p.id, body.name.trim(), norm, seq).run();
  const tag = await env.DB.prepare('SELECT * FROM tags WHERE id=?').bind(id).first();
  return json({ tag });
});

on('POST', '/api/spreads/:id/tags', async (request, env, p) => {
  const u = await requireAuth(request, env);
  const spread = await env.DB.prepare('SELECT * FROM spreads WHERE id=?').bind(p.id).first();
  if (!spread) return err(404, 'not_found');
  await requireMembership(env, u.userId, spread.notebook_id);
  const body = await request.json();
  const seq = await nextSeq(env);
  await env.DB.prepare(
    `INSERT INTO spread_tags (spread_id, tag_id, seq) VALUES (?,?,?)
     ON CONFLICT(spread_id, tag_id) DO UPDATE SET deleted_at=NULL, seq=excluded.seq`
  ).bind(p.id, body.tag_id, seq).run();
  return json({ ok: true });
});

on('DELETE', '/api/spreads/:id/tags/:tagId', async (request, env, p) => {
  const u = await requireAuth(request, env);
  const spread = await env.DB.prepare('SELECT * FROM spreads WHERE id=?').bind(p.id).first();
  if (!spread) return err(404, 'not_found');
  await requireMembership(env, u.userId, spread.notebook_id);
  const seq = await nextSeq(env);
  await env.DB.prepare('UPDATE spread_tags SET deleted_at=?, seq=? WHERE spread_id=? AND tag_id=?')
    .bind(nowISO(), seq, p.id, p.tagId).run();
  return json({ ok: true });
});

// ==================================================================
// FAVORITES (персональные)
// ==================================================================

on('GET', '/api/favorites', async (request, env) => {
  const u = await requireAuth(request, env);
  const rows = await env.DB.prepare('SELECT spread_id FROM user_favorites WHERE user_id=? AND deleted_at IS NULL').bind(u.userId).all();
  return json({ favorites: rows.results.map(r => r.spread_id) });
});

on('PUT', '/api/favorites/:spreadId', async (request, env, p) => {
  const u = await requireAuth(request, env);
  const seq = await nextSeq(env);
  await env.DB.prepare(
    `INSERT INTO user_favorites (user_id, spread_id, seq) VALUES (?,?,?)
     ON CONFLICT(user_id, spread_id) DO UPDATE SET deleted_at=NULL, seq=excluded.seq`
  ).bind(u.userId, p.spreadId, seq).run();
  return json({ ok: true });
});

on('DELETE', '/api/favorites/:spreadId', async (request, env, p) => {
  const u = await requireAuth(request, env);
  const seq = await nextSeq(env);
  await env.DB.prepare('UPDATE user_favorites SET deleted_at=?, seq=? WHERE user_id=? AND spread_id=?')
    .bind(nowISO(), seq, u.userId, p.spreadId).run();
  return json({ ok: true });
});

// ==================================================================
// SYNC (paginated, cursor-based)
// ==================================================================

on('GET', '/api/sync', async (request, env) => {
  const u = await requireAuth(request, env);
  const url = new URL(request.url);
  const since = parseInt(url.searchParams.get('since') || '0', 10);
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '500', 10), 1000);

  const nbRows = await env.DB.prepare(
    'SELECT notebook_id FROM notebook_members WHERE user_id=? AND revoked_at IS NULL'
  ).bind(u.userId).all();
  const notebookIds = nbRows.results.map(r => r.notebook_id);
  if (notebookIds.length === 0) return json({ changes: {}, next_cursor: since, has_more: false });
  const ph = notebookIds.map(() => '?').join(',');

  const tables = [
    { name: 'notebooks', sql: `SELECT * FROM notebooks WHERE id IN (${ph}) AND seq > ? ORDER BY seq LIMIT ?` },
    { name: 'notebook_members', sql: `SELECT * FROM notebook_members WHERE notebook_id IN (${ph}) AND seq > ? ORDER BY seq LIMIT ?` },
    { name: 'spreads', sql: `SELECT * FROM spreads WHERE notebook_id IN (${ph}) AND seq > ? ORDER BY seq LIMIT ?` },
    { name: 'tags', sql: `SELECT * FROM tags WHERE notebook_id IN (${ph}) AND seq > ? ORDER BY seq LIMIT ?` },
  ];
  const changes = {};
  let maxSeqSeen = since;
  for (const t of tables) {
    const rows = await env.DB.prepare(t.sql).bind(...notebookIds, since, limit).all();
    changes[t.name] = rows.results;
    for (const row of rows.results) if (row.seq > maxSeqSeen) maxSeqSeen = row.seq;
  }
  const spreadIdsRows = await env.DB.prepare(`SELECT id FROM spreads WHERE notebook_id IN (${ph})`).bind(...notebookIds).all();
  const spreadIds = spreadIdsRows.results.map(r => r.id);
  if (spreadIds.length) {
    const sph = spreadIds.map(() => '?').join(',');
    const photos = await env.DB.prepare(`SELECT * FROM photos WHERE spread_id IN (${sph}) AND seq > ? ORDER BY seq LIMIT ?`)
      .bind(...spreadIds, since, limit).all();
    changes.photos = photos.results;
    for (const row of photos.results) if (row.seq > maxSeqSeen) maxSeqSeen = row.seq;

    const spreadTags = await env.DB.prepare(`SELECT * FROM spread_tags WHERE spread_id IN (${sph}) AND seq > ? ORDER BY seq LIMIT ?`)
      .bind(...spreadIds, since, limit).all();
    changes.spread_tags = spreadTags.results;
    for (const row of spreadTags.results) if (row.seq > maxSeqSeen) maxSeqSeen = row.seq;

    const favorites = await env.DB.prepare(`SELECT * FROM user_favorites WHERE user_id=? AND spread_id IN (${sph}) AND seq > ? ORDER BY seq LIMIT ?`)
      .bind(u.userId, ...spreadIds, since, limit).all();
    changes.favorites = favorites.results;
    for (const row of favorites.results) if (row.seq > maxSeqSeen) maxSeqSeen = row.seq;
  } else {
    changes.photos = []; changes.spread_tags = []; changes.favorites = [];
  }

  const anyFull = Object.values(changes).some(arr => arr.length >= limit);
  let cursor = maxSeqSeen;
  if (anyFull) {
    const fullMaxes = Object.values(changes).filter(arr => arr.length > 0).map(arr => Math.max(...arr.map(r => r.seq)));
    cursor = fullMaxes.length ? Math.min(...fullMaxes) : since;
  }
  return json({ changes, next_cursor: cursor, has_more: anyFull });
});

// ==================================================================
// MIGRATION
// ==================================================================

on('POST', '/api/migration/import', async (request, env) => {
  const u = await requireAuth(request, env);
  const body = await request.json();
  const nbMap = {};
  for (const nb of body.notebooks || []) {
    let existing = await env.DB.prepare('SELECT * FROM notebooks WHERE created_by=? AND client_ref=?').bind(u.userId, nb.client_ref).first();
    if (!existing) {
      const id = uuid();
      const seq = await nextSeq(env);
      const now = nowISO();
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO notebooks (id, owner_id, created_by, title, description, archived, sort_order, created_at, updated_at, revision, seq, client_ref)
           VALUES (?,?,?,?,?,0,0,?,?,1,?,?)`
        ).bind(id, u.userId, u.userId, nb.title, nb.description || null, now, now, seq, nb.client_ref),
        env.DB.prepare('INSERT INTO notebook_members (notebook_id, user_id, role, added_at, updated_at, seq) VALUES (?,?,?,?,?,?)')
          .bind(id, u.userId, 'OWNER', now, now, seq),
      ]);
      existing = await env.DB.prepare('SELECT * FROM notebooks WHERE id=?').bind(id).first();
    }
    nbMap[nb.client_ref] = existing.id;
  }
  const spMap = {};
  for (const sp of body.spreads || []) {
    const notebookId = nbMap[sp.notebook_client_ref];
    if (!notebookId) continue;
    let existing = await env.DB.prepare('SELECT * FROM spreads WHERE created_by=? AND client_ref=?').bind(u.userId, sp.client_ref).first();
    if (!existing) {
      const id = uuid();
      const seq = await nextSeq(env);
      const now = nowISO();
      const searchable = normalizeSearch([sp.number, sp.title, sp.note_short, sp.note_full].join(' '));
      try {
        await env.DB.prepare(
          `INSERT INTO spreads (id, notebook_id, number, title, note_short, note_full, status, searchableText,
            created_by, created_at, updated_by, updated_at, revision, seq, client_ref)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)`
        ).bind(id, notebookId, sp.number, sp.title || null, sp.note_short || null, sp.note_full || null,
          sp.status || 'Актуально', searchable, u.userId, now, u.userId, now, seq, sp.client_ref).run();
        existing = await env.DB.prepare('SELECT * FROM spreads WHERE id=?').bind(id).first();
      } catch (e) { continue; }
    }
    spMap[sp.client_ref] = existing.id;
  }
  for (const t of body.tags || []) {
    const notebookId = nbMap[t.notebook_client_ref];
    if (!notebookId) continue;
    const norm = normalizeTag(t.name);
    const existingTag = await env.DB.prepare('SELECT * FROM tags WHERE notebook_id=? AND normalized_name=?').bind(notebookId, norm).first();
    let tagId = existingTag ? existingTag.id : null;
    if (!tagId) {
      tagId = uuid();
      const seq = await nextSeq(env);
      await env.DB.prepare('INSERT INTO tags (id, notebook_id, name, normalized_name, seq) VALUES (?,?,?,?,?)')
        .bind(tagId, notebookId, t.name, norm, seq).run();
    }
    if (t.spread_client_ref && spMap[t.spread_client_ref]) {
      const seq2 = await nextSeq(env);
      await env.DB.prepare(
        `INSERT INTO spread_tags (spread_id, tag_id, seq) VALUES (?,?,?) ON CONFLICT(spread_id, tag_id) DO NOTHING`
      ).bind(spMap[t.spread_client_ref], tagId, seq2).run();
    }
  }
  return json({ notebook_map: nbMap, spread_map: spMap });
});

on('POST', '/api/migration/register-existing-photo', async (request, env) => {
  const u = await requireAuth(request, env);
  const body = await request.json();
  const spread = await env.DB.prepare('SELECT * FROM spreads WHERE id=?').bind(body.spread_id).first();
  if (!spread) return err(404, 'spread_not_found');
  await requireMembership(env, u.userId, spread.notebook_id);

  const decoded = decodeStorageObjectId(body.storage_object_id);
  if (!decoded || String(decoded.chatId) !== String(env.CHAT_ID)) {
    return err(400, 'invalid_storage_object_id');
  }

  const maxVersionRow = await env.DB.prepare('SELECT MAX(version) as v FROM photos WHERE spread_id=?').bind(body.spread_id).first();
  const version = (maxVersionRow.v || 0) + 1;
  const photoId = uuid();
  const seq = await nextSeq(env);
  const now = nowISO();
  await env.DB.batch([
    env.DB.prepare('UPDATE photos SET is_current=0 WHERE spread_id=? AND is_current=1').bind(body.spread_id),
    env.DB.prepare(
      `INSERT INTO photos (id, spread_id, version, is_current, provider, storage_object_id, telegram_message_id,
        telegram_file_id, telegram_file_unique_id, mime_type, file_size, created_by, created_at, seq)
       VALUES (?,?,?,1,'telegram',?,?,?,?,?,?,?,?,?)`
    ).bind(photoId, body.spread_id, version, body.storage_object_id, decoded.messageId, body.telegram_file_id,
      body.telegram_file_unique_id, body.mime_type, body.file_size, u.userId, now, seq),
    env.DB.prepare('UPDATE spreads SET current_photo_id=?, seq=? WHERE id=?').bind(photoId, seq, body.spread_id),
  ]);
  return json({ photo_id: photoId, version });
});

// ------------------------------------------------------------------ main

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors() });
    const { pathname } = new URL(request.url);
    for (const r of routes) {
      if (r.method !== request.method) continue;
      const params = matchRoute(pathname, r.pattern);
      if (!params) continue;
      try {
        return await r.handler(request, env, params);
      } catch (e) {
        if (e instanceof HttpError) return err(e.status, e.code, e.detail);
        return err(500, 'internal_error', String(e && e.message || e));
      }
    }
    return err(404, 'no_such_route');
  },
};
