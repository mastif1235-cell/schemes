/* Blocknot Scan v3.2.3: native spread actions, explicit search context, stable status, visible history/invite panel. */
const V323_SEARCH_NOTEBOOK_KEY = 'blocknot_v323_search_notebook';

function v323ClosestNativeSpreadSheet(el) {
  let node = el;
  for (let i = 0; i < 8 && node; i++, node = node.parentElement) {
    const text = (node.textContent || '').replace(/\s+/g,' ');
    if (/Открыть.*Telegram|Відкрити.*Telegram|Заменить фото|Замінити фото|Удалить фото|Видалити фото/i.test(text) && node.querySelector && node.querySelector('img')) return node;
  }
  return null;
}

async function v323ResolvePhotoFromImage(img) {
  if (!img) return null;
  if (img.dataset && img.dataset.photoId) {
    const p = await get('photos', img.dataset.photoId);
    if (p) return p;
  }
  const key = img.src && v3BlobKeyByUrl.get(img.src);
  if (key) return get('photos', v3PhotoIdFromBlobKey(key));
  return null;
}

/* Do not open a second v3 regular viewer on top of the app's native spread viewer. */
const v323PhotoFromImageBase = v3PhotoFromImage;
v3PhotoFromImage = async function(img) {
  if (img && v323ClosestNativeSpreadSheet(img)) return null;
  return v323PhotoFromImageBase(img);
};

async function v323PhotoStatusText(photo) {
  if (!photo) return '';
  const local = !!(await v3LocalPhotoBlob(photo));
  const cloud = !!(photo.server_id || photo.telegram_file_id || photo.storage_object_id);
  let failed = false, pending = false;
  try {
    const rows = (await getAll('sync_queue')).filter(x => String(JSON.stringify(x)).includes(String(photo.id)));
    failed = rows.some(x => x.status === 'failed');
    pending = !cloud && rows.some(x => x.status === 'pending');
  } catch (_) {}
  if (failed) return (local ? '📱 локально · ' : '') + '⚠️ ошибка загрузки';
  if (pending) return (local ? '📱 локально · ' : '') + '⏳ ожидает загрузки';
  if (cloud && local) return '📱 локально · ☁️ Telegram';
  if (cloud) return '☁️ Telegram';
  return local ? '📱 локально' : 'Фото';
}
v321PhotoStatusText = v323PhotoStatusText;

async function v323DecorateNativeSpreadSheet() {
  const buttons = [...document.querySelectorAll('button')];
  const anchor = buttons.find(b => /Открыть.*Telegram|Відкрити.*Telegram|Заменить фото|Замінити фото|Удалить фото|Видалити фото/i.test(b.textContent || ''));
  if (!anchor) return;
  const sheet = v323ClosestNativeSpreadSheet(anchor);
  if (!sheet || sheet.dataset.v323Actions) return;
  const img = sheet.querySelector('img');
  if (!img) return;
  const photo = await v323ResolvePhotoFromImage(img);
  if (!photo) return;
  sheet.dataset.v323Actions = '1';
  if (img.dataset) img.dataset.photoId = photo.id;
  const row = document.createElement('div');
  row.id = 'v323NativeActions';
  row.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:12px;';
  row.innerHTML = '<button class="btn-primary" id="v323Fullscreen">⛶ На весь экран</button><button class="btn-secondary" id="v323Download">⬇ Скачать фото</button>';
  const actionButtons = buttons.filter(b => sheet.contains(b));
  const lastBtn = actionButtons[actionButtons.length - 1];
  if (lastBtn && lastBtn.parentElement) lastBtn.parentElement.insertAdjacentElement('afterend', row);
  else sheet.appendChild(row);
  let status = sheet.querySelector('#v323NativeStatus');
  if (!status) {
    status = document.createElement('div'); status.id='v323NativeStatus';
    status.style.cssText='font-size:12px;color:var(--muted);margin:8px 0 0;';
    row.insertAdjacentElement('beforebegin', status);
  }
  status.textContent = await v323PhotoStatusText(photo);
  document.getElementById('v323Fullscreen').onclick = async () => {
    await v321FullscreenViewer(photo);
    const dl = document.getElementById('v3Download');
    if (dl) dl.textContent = '⬇ Скачать фото';
  };
  document.getElementById('v323Download').onclick = () => v321DownloadPhoto(photo);
}

async function v323NotebookList() {
  return (await getAll('notebooks')).filter(n => !n.deleted_at && !n.hidden_no_access).sort((a,b)=>(a.sort_order-b.sort_order)||String(a.title||'').localeCompare(String(b.title||'')));
}

function v323CurrentNotebookGuess() {
  try { return JSON.parse(localStorage.getItem(V321_LAST_NOTEBOOK_KEY) || 'null'); } catch (_) { return null; }
}

async function v323DecorateNotebookLocalSearch() {
  if (!screenEl || document.getElementById('v323NotebookSearch')) return;
  const cards = [...screenEl.querySelectorAll('.spread-card')];
  if (!cards.length) return;
  const current = v323CurrentNotebookGuess();
  const box = document.createElement('div');
  box.id = 'v323NotebookSearch';
  box.style.cssText = 'margin:0 0 12px;';
  box.innerHTML = `<input id="v323NotebookSearchInput" type="search" placeholder="Поиск в ${esc(current && current.title ? current.title : 'этом блокноте')}" style="width:100%;box-sizing:border-box;padding:11px 12px;border:1px solid var(--line);border-radius:10px;font:inherit">`;
  const first = cards[0];
  first.parentElement.insertBefore(box, first);
  box.querySelector('input').addEventListener('input', e => {
    const q = String(e.target.value || '').trim().toLowerCase();
    for (const card of cards) {
      const text = (card.textContent || '').toLowerCase();
      card.style.display = !q || text.includes(q) ? '' : 'none';
    }
  });
}

async function v323SwitchSearchContext(nb) {
  if (!nb) return;
  localStorage.setItem(V321_LAST_NOTEBOOK_KEY, JSON.stringify({id:nb.id,title:nb.title||'Без названия'}));
  localStorage.setItem(V323_SEARCH_NOTEBOOK_KEY, nb.id);
  /* Reuse the app's own notebook context: briefly open the selected notebook, then return to Search. */
  const navNotebook = [...document.querySelectorAll('button,a')].find(x => /^Блокноты$|^Блокноти$/i.test((x.textContent||'').trim()));
  if (!navNotebook) { v321DecorateSearchScope(); return; }
  navNotebook.click();
  setTimeout(() => {
    const cards = [...screenEl.querySelectorAll('.notebook-card')];
    const target = cards.find(c => (c.textContent||'').includes(nb.title||''));
    if (target) target.click();
    setTimeout(() => {
      const navSearch = [...document.querySelectorAll('button,a')].find(x => /^Поиск$|^Пошук$/i.test((x.textContent||'').trim()));
      if (navSearch) navSearch.click();
    }, 220);
  }, 220);
}

async function v323DecorateGlobalSearch() {
  if (!screenEl || document.getElementById('v323SearchNotebookSelect')) return;
  const text = (screenEl.textContent || '').toLowerCase();
  const searchInput = screenEl.querySelector('input[type="search"], input[placeholder*="Поиск"], input[placeholder*="Пошук"]');
  if (!searchInput || (!text.includes('все блокноты') && !text.includes('усі блокноти') && !text.includes('этот блокнот') && !text.includes('цей блокнот'))) return;
  const notebooks = await v323NotebookList();
  if (!notebooks.length) return;
  const current = v323CurrentNotebookGuess();
  const wrap = document.createElement('div'); wrap.style.cssText='margin:10px 0 12px;';
  wrap.innerHTML = '<label style="display:block;font-size:12px;color:var(--muted);margin-bottom:5px">Искать в блокноте</label><select id="v323SearchNotebookSelect" style="width:100%;box-sizing:border-box;padding:11px 12px;border:1px solid var(--line);border-radius:10px;background:var(--card);font:inherit"></select>';
  const sel = wrap.querySelector('select');
  for (const nb of notebooks) { const o=document.createElement('option');o.value=nb.id;o.textContent=nb.title||'Без названия';if(current&&current.id===nb.id)o.selected=true;sel.appendChild(o); }
  searchInput.insertAdjacentElement('beforebegin', wrap);
  sel.onchange = () => v323SwitchSearchContext(notebooks.find(n=>String(n.id)===sel.value));
}

async function v323DecorateNotebookHub() {
  if (!screenEl || !isAuthed()) return;
  const cards = [...screenEl.querySelectorAll('.notebook-card')];
  if (!cards.length) return;
  let bar = document.getElementById('v323NotebookHub');
  if (!bar) {
    bar = document.createElement('div'); bar.id='v323NotebookHub';
    bar.style.cssText='display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:0 0 14px;';
    bar.innerHTML='<button class="btn-secondary" id="v323HistoryBtn">🕘 История</button><button class="btn-secondary" id="v323InviteBtn">🔗 Ввести код</button>';
    const first = cards[0]; first.parentElement.insertBefore(bar, first);
    bar.querySelector('#v323HistoryBtn').onclick = v321OpenGlobalHistory;
    bar.querySelector('#v323InviteBtn').onclick = v322OpenRedeemInvite;
  }
  const count = await v321UnreadHistoryCount();
  const h = document.getElementById('v323HistoryBtn');
  if (h) h.innerHTML = `🕘 История${count ? ` <span style="display:inline-flex;min-width:20px;height:20px;padding:0 5px;align-items:center;justify-content:center;border-radius:999px;background:#b42318;color:#fff;font-size:12px">${count>99?'99+':count}</span>` : ''}`;
  /* Remove older duplicate decorators when this robust bar is present. */
  const oldHist = document.getElementById('v321GlobalHistoryBtn'); if (oldHist) oldHist.style.display='none';
  const oldInvite = document.getElementById('v322RedeemInviteBtn'); if (oldInvite) oldInvite.style.display='none';
}

async function v323RefreshVisibleStatuses() {
  await v323DecorateNativeSpreadSheet();
  const nativeStatus = document.getElementById('v323NativeStatus');
  if (nativeStatus) {
    const sheet = nativeStatus.closest('[data-v323-actions="1"]');
    const img = sheet && sheet.querySelector('img');
    const p = await v323ResolvePhotoFromImage(img);
    if (p) nativeStatus.textContent = await v323PhotoStatusText(p);
  }
  const badges = [...document.querySelectorAll('.v3-photo-status')];
  for (const badge of badges) {
    const img = badge.parentElement && badge.parentElement.querySelector('img[data-photo-id]');
    const p = img && img.dataset.photoId ? await get('photos', img.dataset.photoId) : null;
    if (!p) continue;
    const t = await v323PhotoStatusText(p);
    badge.textContent = /ошибка/.test(t)?'⚠️':/ожидает/.test(t)?'⏳':/Telegram/.test(t)?'☁️':'📱';
  }
}

let v323Decorating = false;
async function v323DecorateAll() {
  if (v323Decorating) return; v323Decorating = true;
  try {
    await v323DecorateNotebookHub();
    await v323DecorateNotebookLocalSearch();
    await v323DecorateGlobalSearch();
    await v323RefreshVisibleStatuses();
  } catch (e) { console.warn('v3.2.3 decoration', e); }
  finally { v323Decorating = false; }
}

const v323Observer = new MutationObserver(() => setTimeout(v323DecorateAll, 20));
setTimeout(() => { if (window.__BLOCKNOT_LEGACY_DISABLED__) return; if (document.body) v323Observer.observe(document.body,{childList:true,subtree:true}); v323DecorateAll(); }, 100);
const v323DecorateInterval = setInterval(v323DecorateAll, 2500);
