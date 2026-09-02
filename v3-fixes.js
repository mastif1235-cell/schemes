/* Blocknot Scan v3.2.1 UX fixes: regular photo view, recents navigation, search context, live photo status, global history. */
const V321_HISTORY_SEEN_KEY = 'blocknot_v321_history_seen_at';
const V321_HISTORY_HIDDEN_KEY = 'blocknot_v321_history_hidden_before';
const V321_HISTORY_BASELINE_KEY = 'blocknot_v321_history_baseline_done';
const V321_LAST_NOTEBOOK_KEY = 'blocknot_v321_last_notebook';

function v321EventTime(row) {
  const raw = row && (row.created_at || row.timestamp || row.updated_at || row.at);
  const n = raw ? new Date(raw).getTime() : 0;
  return Number.isFinite(n) ? n : 0;
}

async function v321PhotoStatusText(photo) {
  if (!photo) return '';
  const local = !!(await v3LocalPhotoBlob(photo));
  const cloud = !!(photo.server_id || photo.telegram_file_id || photo.storage_object_id);
  let suffix = '';
  try {
    const q = (await getAll('sync_queue')).find(x => String(JSON.stringify(x)).includes(String(photo.id)));
    if (q) {
      if (q.status === 'failed') suffix = ' · ⚠️ ошибка';
      else if (q.status === 'pending') suffix = ' · ⏳ ожидает загрузки';
      else suffix = ' · 🔄 синхронизация';
    }
  } catch (_) {}
  const base = (local ? '📱 локально' : '') + (cloud ? (local ? ' · ' : '') + '☁️ Telegram' : '');
  return (base || '📱 локально') + suffix;
}

async function v321DownloadPhoto(photo) {
  const blob = await v3FetchOriginalBlob(photo);
  if (!blob) { toast('Оригинал фото пока недоступен'); return; }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `spread_${photo.spread_id || 'photo'}_${v3ServerPhotoId(photo) || 'original'}.jpg`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
}

/* Keep the v3.2.0 fullscreen viewer, but enter it only from the normal photo screen. */
const v321FullscreenViewer = v3OpenViewer;

async function v321OpenFullscreen(photo) {
  await v321FullscreenViewer(photo);
  const download = document.getElementById('v3Download');
  if (download) download.textContent = '⬇ Скачать фото';
}

async function v321OpenRegularPhoto(photo) {
  if (!photo) return;
  const spread = photo.spread_id ? await get('spreads', photo.spread_id) : null;
  if (spread) v3RememberSpread(spread);
  const blob = await v3FetchOriginalBlob(photo);
  if (!blob) { toast('Фото пока недоступно'); return; }
  const url = URL.createObjectURL(blob);
  const title = spread ? `Разворот ${spread.number || '—'}` : 'Фото';
  const body = `
    <div class="sheet-handle"></div>
    <div id="v321RegularViewer">
      <h2 style="margin-bottom:8px">${esc(title)}</h2>
      <div id="v321RegularStatus" style="font-size:12px;color:var(--muted);margin-bottom:10px"></div>
      <div style="background:#111;border-radius:12px;overflow:hidden;text-align:center">
        <img id="v321RegularImg" src="${url}" alt="${esc(title)}" style="display:block;width:100%;max-height:62vh;object-fit:contain;background:#111">
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:12px">
        <button class="btn-primary" id="v321Fullscreen">⛶ На весь экран</button>
        <button class="btn-secondary" id="v321Download">⬇ Скачать фото</button>
      </div>
    </div>`;
  const {close} = openSheet(body);
  const status = document.getElementById('v321RegularStatus');
  if (status) status.textContent = await v321PhotoStatusText(photo);
  document.getElementById('v321Fullscreen').onclick = () => v321OpenFullscreen(photo);
  document.getElementById('v321Download').onclick = () => v321DownloadPhoto(photo);
  const originalClose = close;
  const cleanup = () => { try { URL.revokeObjectURL(url); } catch (_) {} };
  const backButtons = document.querySelectorAll('[data-close-sheet], .sheet-close');
  for (const b of backButtons) b.addEventListener('click', cleanup, {once:true});
  return {close: () => { cleanup(); originalClose(); }};
}

/* Existing capture click handler still calls v3OpenViewer; it now opens the regular screen. */
v3OpenViewer = async function(photo) {
  return v321OpenRegularPhoto(photo);
};

/* Recent spreads must actually open. */
v3RenderRecentsIfUseful = async function() {
  if (!screenEl || document.getElementById('v3RecentBlock')) return;
  const txt = (screenEl.textContent || '').toLowerCase();
  if (!txt.includes('избран') && !txt.includes('обран')) return;
  const rows = v3LoadRecents();
  if (!rows.length) return;
  const wrap = document.createElement('div');
  wrap.id = 'v3RecentBlock';
  wrap.style.cssText = 'margin:0 0 14px;';
  wrap.innerHTML = '<h3 style="margin:0 0 8px">🕘 Последние открытые</h3><div id="v3RecentItems" style="display:grid;gap:8px"></div>';
  const host = screenEl.firstElementChild || screenEl;
  host.insertBefore(wrap, host.firstChild);
  const box = wrap.querySelector('#v3RecentItems');
  for (const r of rows.slice(0, 6)) {
    const s = await get('spreads', r.id);
    if (!s || s.deleted_at) continue;
    const nb = s.notebook_id ? await get('notebooks', s.notebook_id) : null;
    const b = document.createElement('button');
    b.className = 'btn-secondary';
    b.style.textAlign = 'left';
    b.textContent = `${nb && nb.title ? nb.title + ' · ' : ''}Разворот ${s.number || '—'}`;
    b.onclick = async () => {
      v3RememberSpread(s);
      if (!s.current_photo_id) { toast('В этом развороте пока нет фото'); return; }
      const p = await get('photos', s.current_photo_id);
      if (!p) { toast('Фото разворота пока недоступно'); return; }
      await v321OpenRegularPhoto(p);
    };
    box.appendChild(b);
  }
};

/* Remember the last notebook selected so search scope is explicit. */
document.addEventListener('pointerdown', async e => {
  const card = e.target && e.target.closest ? e.target.closest('.notebook-card') : null;
  if (!card || !screenEl || !screenEl.contains(card)) return;
  try {
    const cards = [...screenEl.querySelectorAll('.notebook-card')];
    const idx = cards.indexOf(card);
    const notebooks = (await getAll('notebooks')).filter(n => !n.deleted_at && !n.hidden_no_access).sort((a,b)=>(a.sort_order-b.sort_order)||0);
    const nb = notebooks[idx];
    if (nb) localStorage.setItem(V321_LAST_NOTEBOOK_KEY, JSON.stringify({id:nb.id,title:nb.title||'Без названия'}));
  } catch (_) {}
}, true);

function v321LastNotebook() {
  try { return JSON.parse(localStorage.getItem(V321_LAST_NOTEBOOK_KEY) || 'null'); } catch (_) { return null; }
}

function v321DecorateSearchScope() {
  if (!screenEl) return;
  const nb = v321LastNotebook();
  const candidates = [...screenEl.querySelectorAll('button,.btn,.btn-secondary,.btn-primary')];
  for (const el of candidates) {
    const base = (el.dataset.v321BaseText || el.textContent || '').trim();
    if (/^этот блокнот(?:\s|$)/i.test(base) || /^цей блокнот(?:\s|$)/i.test(base)) {
      if (!el.dataset.v321BaseText) el.dataset.v321BaseText = base.replace(/\s*·.*$/, '').trim();
      const title = nb && nb.title ? nb.title : 'не выбран';
      el.textContent = `${el.dataset.v321BaseText} · ${title}`;
    }
  }
}

/* Clearer gallery wording. */
v3ChoosePageCapture = function(originalInput) {
  const {close} = openSheet(`<div class="sheet-handle"></div><h2>Добавить фото страницы</h2><p style="color:var(--muted);margin-top:0">Для камеры выберите форму страницы. Приложение обрежет лишнее вокруг неё. Если фото уже есть в телефоне — выберите галерею.</p><div style="display:grid;gap:10px"><button id="v3Portrait" class="btn-primary">▯ Сфотографировать вертикальную страницу</button><button id="v3Landscape" class="btn-secondary">▭ Сфотографировать горизонтальную страницу</button><button id="v3Gallery" class="btn-secondary">🖼 Выбрать готовое фото из галереи</button></div>`);
  const run = async (orientation, capture) => {
    close();
    const temp = document.createElement('input');
    temp.type = 'file'; temp.accept = 'image/*'; temp.dataset.v3InternalPicker = '1';
    if (capture) temp.setAttribute('capture','environment');
    temp.style.display = 'none'; document.body.appendChild(temp);
    temp.onchange = async () => {
      let f = temp.files && temp.files[0]; temp.remove(); if (!f) return;
      if (orientation) f = await v3CropPageFile(f, orientation);
      const dt = new DataTransfer(); dt.items.add(f); originalInput.files = dt.files;
      originalInput.dispatchEvent(new Event('change',{bubbles:true}));
    };
    temp.click();
  };
  document.getElementById('v3Portrait').onclick = () => run('portrait', true);
  document.getElementById('v3Landscape').onclick = () => run('landscape', true);
  document.getElementById('v3Gallery').onclick = () => run(null, false);
};

async function v321HistoryRows() {
  const hiddenBefore = Number(localStorage.getItem(V321_HISTORY_HIDDEN_KEY) || 0);
  const rows = (await getAll('history')).filter(h => v321EventTime(h) > hiddenBefore);
  rows.sort((a,b) => v321EventTime(b) - v321EventTime(a));
  return rows;
}

async function v321EnsureHistoryBaseline() {
  if (localStorage.getItem(V321_HISTORY_BASELINE_KEY)) return;
  const rows = await v321HistoryRows();
  const latest = rows.length ? v321EventTime(rows[0]) : Date.now();
  localStorage.setItem(V321_HISTORY_SEEN_KEY, String(latest));
  localStorage.setItem(V321_HISTORY_BASELINE_KEY, '1');
}

async function v321UnreadHistoryCount() {
  await v321EnsureHistoryBaseline();
  const seen = Number(localStorage.getItem(V321_HISTORY_SEEN_KEY) || 0);
  const rows = await v321HistoryRows();
  return rows.filter(h => v321EventTime(h) > seen).length;
}

async function v321HistoryItemHtml(h) {
  const at = v321EventTime(h);
  let notebookTitle = '';
  try {
    let nb = h.notebook_id ? await get('notebooks', h.notebook_id) : null;
    if (!nb && h.spread_id) {
      const sp = await get('spreads', h.spread_id);
      if (sp) nb = await get('notebooks', sp.notebook_id);
    }
    notebookTitle = nb && nb.title ? nb.title : '';
  } catch (_) {}
  const who = h.display_name || h.user_name || h.user_id || 'Пользователь';
  const action = v3ActionLabel(h.action);
  return `<div style="padding:10px 0;border-bottom:1px solid var(--line)"><b>${esc(action)}</b>${notebookTitle ? `<div>${esc(notebookTitle)}</div>` : ''}<small>${esc(String(who))}${at ? ' · ' + new Date(at).toLocaleString('ru-RU') : ''}</small></div>`;
}

async function v321OpenGlobalHistory() {
  const rows = (await v321HistoryRows()).slice(0, 100);
  const latest = rows.length ? Math.max(...rows.map(v321EventTime)) : Date.now();
  localStorage.setItem(V321_HISTORY_SEEN_KEY, String(Math.max(Date.now(), latest)));
  const items = [];
  for (const h of rows) items.push(await v321HistoryItemHtml(h));
  const {close} = openSheet(`<div class="sheet-handle"></div><div style="display:flex;align-items:center;justify-content:space-between;gap:8px"><h2 style="margin:0">🕘 История</h2><button id="v321ClearHistory" class="btn-secondary">Очистить у меня</button></div><p style="color:var(--muted)">Последние изменения во всех блокнотах. Показывается до 100 записей.</p>${items.length ? items.join('') : '<p>Новых записей нет.</p>'}`);
  const clear = document.getElementById('v321ClearHistory');
  if (clear) clear.onclick = () => {
    localStorage.setItem(V321_HISTORY_HIDDEN_KEY, String(Date.now()));
    localStorage.setItem(V321_HISTORY_SEEN_KEY, String(Date.now()));
    close(); toast('История очищена только на этом устройстве');
    if (typeof render === 'function') render();
  };
  v321DecorateGlobalHistoryButton();
}

async function v321DecorateGlobalHistoryButton() {
  if (!screenEl) return;
  const heading = [...screenEl.querySelectorAll('h1,h2,h3')].find(h => /мои блокноты|мої блокноти/i.test(h.textContent || ''));
  if (!heading) return;
  let btn = document.getElementById('v321GlobalHistoryBtn');
  if (!btn) {
    btn = document.createElement('button');
    btn.id = 'v321GlobalHistoryBtn';
    btn.className = 'btn-secondary';
    btn.style.cssText = 'margin-left:8px;white-space:nowrap;';
    btn.onclick = v321OpenGlobalHistory;
    heading.insertAdjacentElement('afterend', btn);
  }
  const count = await v321UnreadHistoryCount();
  btn.innerHTML = `🕘 История${count ? ` <span style="display:inline-flex;min-width:20px;height:20px;padding:0 5px;align-items:center;justify-content:center;border-radius:999px;background:#b42318;color:#fff;font-size:12px">${count > 99 ? '99+' : count}</span>` : ''}`;
}

/* Keep compact covers and add the global history button after notebooks render. */
const v321RenderNotebooks = renderNotebooks;
renderNotebooks = async function() {
  await v321RenderNotebooks();
  await v321DecorateGlobalHistoryButton();
};

async function v321RefreshPhotoBadges() {
  if (!screenEl) return;
  const badges = [...screenEl.querySelectorAll('.v3-photo-status')];
  for (const badge of badges) {
    const host = badge.parentElement;
    const img = host && host.querySelector ? host.querySelector('img[data-photo-id]') : null;
    const id = img && img.dataset ? img.dataset.photoId : null;
    if (!id) continue;
    const p = await get('photos', id);
    if (!p) continue;
    const text = await v321PhotoStatusText(p);
    if (/ошибка/.test(text)) badge.textContent = '⚠️';
    else if (/ожидает/.test(text)) badge.textContent = '⏳';
    else if (/синхронизация/.test(text)) badge.textContent = '🔄';
    else if (/Telegram/.test(text)) badge.textContent = '📱☁️';
    else badge.textContent = '📱';
  }
  const regular = document.getElementById('v321RegularStatus');
  if (regular) {
    const img = document.getElementById('v321RegularImg');
    const source = img && img.dataset && img.dataset.photoId;
    if (source) {
      const p = await get('photos', source);
      if (p) regular.textContent = await v321PhotoStatusText(p);
    }
  }
}

let v321LastPendingCount = null;
async function v321Tick() {
  try {
    v321DecorateSearchScope();
    await v321DecorateGlobalHistoryButton();
    await v321RefreshPhotoBadges();
    const queue = await getAll('sync_queue');
    const pending = queue.filter(q => q.entity === 'photo' && (q.status === 'pending' || q.status === 'syncing')).length;
    if (v321LastPendingCount !== null && pending < v321LastPendingCount && !document.getElementById('v3PhotoViewer') && !document.getElementById('v321RegularViewer')) {
      if (typeof render === 'function') await render();
      if (typeof v3DecoratePhotos === 'function') await v3DecoratePhotos();
    }
    v321LastPendingCount = pending;
  } catch (_) {}
}

setInterval(v321Tick, 1500);
setTimeout(v321Tick, 300);
