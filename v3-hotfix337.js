/* Blocknot Scan v3.3.7: scope photo UI to real sheets, prevent leaked actions, fix notebook-cover card mapping. */

/* Tag every new sheet so decorators cannot accidentally climb up to the whole app. */
try {
  if (typeof openSheet === 'function' && !openSheet.__v337Wrapped) {
    const v337OpenSheetBase = openSheet;
    const wrapped = function(html) {
      const result = v337OpenSheetBase(html);
      try {
        if (result && result.el) result.el.dataset.v337Sheet = '1';
      } catch (_) {}
      return result;
    };
    wrapped.__v337Wrapped = true;
    openSheet = wrapped;
  }
} catch (_) {}

/* Only recognize an actual tagged sheet as a native photo sheet. */
v323ClosestNativeSpreadSheet = function(el) {
  if (!el || !el.closest) return null;
  const sheet = el.closest('[data-v337-sheet="1"]');
  if (!sheet) return null;
  const text = (sheet.textContent || '').replace(/\s+/g, ' ');
  if (!/Открыть.*Telegram|Відкрити.*Telegram|Заменить фото|Замінити фото|Удалить фото|Видалити фото/i.test(text)) return null;
  if (!sheet.querySelector('img')) return null;
  return sheet;
};

function v337CleanupLeakedPhotoUi() {
  for (const id of ['v331DownloadPhoto','v323NativeStatus','v331FullscreenCorner','v323NativeActions']) {
    for (const el of [...document.querySelectorAll('#' + id)]) {
      if (!el.closest('[data-v337-sheet="1"],#v3PhotoViewer,#v321RegularViewer')) el.remove();
    }
  }
}

/* Match notebook cards by their visible title instead of assuming DOM order == IndexedDB order. */
function v337CardTitle(card) {
  if (!card) return '';
  const preferred = card.querySelector('h1,h2,h3,h4,.notebook-title,.title,strong,b');
  if (preferred) return (preferred.textContent || '').trim();
  const lines = (card.innerText || card.textContent || '').split(/\n+/).map(s => s.trim()).filter(Boolean);
  return lines[0] || '';
}

async function v337FixNotebookCoverPlacement() {
  if (!screenEl) return;
  const cards = [...screenEl.querySelectorAll('.notebook-card')];
  if (!cards.length) return;
  const notebooks = (await getAll('notebooks')).filter(n => !n.deleted_at && !n.hidden_no_access);
  const byTitle = new Map();
  for (const nb of notebooks) {
    const key = String(nb.title || '').trim();
    if (!key) continue;
    if (!byTitle.has(key)) byTitle.set(key, []);
    byTitle.get(key).push(nb);
  }

  for (const card of cards) {
    const title = v337CardTitle(card);
    const matches = byTitle.get(title) || [];
    if (matches.length !== 1) continue;
    const nb = matches[0];

    const old = card.querySelector('.notebook-cover-mini');
    if (old) {
      try { if (old.src && old.src.startsWith('blob:')) URL.revokeObjectURL(old.src); } catch (_) {}
      old.remove();
    }

    let url = null;
    try { url = await getNotebookCoverUrl(nb); } catch (_) {}
    if (!url) {
      card.style.paddingRight = '';
      continue;
    }
    card.style.position = 'relative';
    card.style.paddingRight = '92px';
    const img = document.createElement('img');
    img.className = 'notebook-cover-mini';
    img.src = url;
    img.alt = 'Обложка блокнота';
    img.style.cssText = 'position:absolute;right:16px;top:50%;transform:translateY(-50%);width:52px;height:72px;object-fit:cover;border-radius:7px;border:1px solid rgba(0,0,0,.18);box-shadow:0 2px 6px rgba(0,0,0,.15);background:#eee;';
    card.appendChild(img);
  }
}

/* Keep the currently opened notebook explicit. This prevents a stale previous-card guess from influencing add/search helpers. */
document.addEventListener('click', async e => {
  const card = e.target && e.target.closest ? e.target.closest('.notebook-card') : null;
  if (!card || !screenEl || !screenEl.contains(card)) return;
  try {
    const title = v337CardTitle(card);
    const notebooks = (await getAll('notebooks')).filter(n => !n.deleted_at && !n.hidden_no_access && String(n.title || '').trim() === title);
    if (notebooks.length === 1) {
      localStorage.setItem(V321_LAST_NOTEBOOK_KEY, JSON.stringify({id:notebooks[0].id,title:notebooks[0].title||'Без названия'}));
      localStorage.setItem(V323_SEARCH_NOTEBOOK_KEY, notebooks[0].id);
    }
  } catch (_) {}
}, true);

let v337Queued = false;
function v337Schedule() {
  if (v337Queued) return;
  v337Queued = true;
  requestAnimationFrame(async () => {
    v337Queued = false;
    try { v337CleanupLeakedPhotoUi(); } catch (_) {}
    try { await v337FixNotebookCoverPlacement(); } catch (_) {}
  });
}

const v337Observer = new MutationObserver(v337Schedule);
setTimeout(() => {
  if (document.body) v337Observer.observe(document.body,{childList:true,subtree:true});
  v337Schedule();
}, 160);
