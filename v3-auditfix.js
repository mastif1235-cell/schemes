/* Blocknot Scan v3.2.5 audit fixes.
   Targeted overrides only: originals/statuses/search. Backend/auth/schema untouched. */

const V325_SEARCH_NOTEBOOK_KEY = 'blocknot_v323_search_notebook';

/* ---------- Photo originals ---------- */
v3PhotoIdFromBlobKey = function(key) {
  return String(key || '').replace(/_(orig|thumb|full|preview|original)$/i, '');
};

v3LocalPhotoBlob = async function(photo) {
  if (!photo) return null;
  for (const key of [
    photo.id + '_orig',
    photo.id + '_full',
    photo.id + '_original',
    photo.id + '_thumb'
  ]) {
    const rec = await get('blobs', key);
    if (rec && rec.blob) return rec.blob;
  }
  return null;
};

async function v325PhotoQueueRows(photo) {
  if (!photo) return [];
  const id = String(photo.id || '');
  if (!id) return [];
  try {
    return (await getAll('sync_queue')).filter(row =>
      row && row.entity === 'photo' && String(row.photo_id || '') === id
    );
  } catch (_) {
    return [];
  }
}

async function v325PhotoStatusText(photo) {
  if (!photo) return '';
  const local = !!(await v3LocalPhotoBlob(photo));
  const cloud = !!(photo.server_id || photo.telegram_file_id || photo.storage_object_id);
  const upload = String(photo.upload_status || '');
  const queue = await v325PhotoQueueRows(photo);
  const failed = upload === 'upload_failed' || queue.some(x => x.status === 'failed');
  const uploading = upload === 'uploading';
  const pending = !cloud && (upload === 'local_pending' || queue.some(x => x.status === 'pending'));

  if (failed) return (local ? '📱 локально · ' : '') + '⚠️ ошибка загрузки';
  if (uploading) return (local ? '📱 локально · ' : '') + '🔄 синхронизация';
  if (pending) return (local ? '📱 локально · ' : '') + '⏳ ожидает загрузки';
  if (cloud && local) return '📱 локально · ☁️ Telegram';
  if (cloud) return '☁️ Telegram';
  return local ? '📱 локально' : 'Фото';
}

if (typeof v321PhotoStatusText === 'function') v321PhotoStatusText = v325PhotoStatusText;
if (typeof v323PhotoStatusText === 'function') v323PhotoStatusText = v325PhotoStatusText;

if (typeof v3ViewerUpdateStatus === 'function') {
  v3ViewerUpdateStatus = async function() {
    if (!v3Viewer || !v3Viewer.photo) return;
    v3Viewer.status.textContent = await v325PhotoStatusText(v3Viewer.photo);
  };
}

/* ---------- Search: real notebook scope + exact-number priority ---------- */
function v325GetSavedNotebookId() {
  try {
    const explicit = localStorage.getItem(V325_SEARCH_NOTEBOOK_KEY);
    if (explicit) return explicit;
    const last = JSON.parse(localStorage.getItem('blocknot_v321_last_notebook') || 'null');
    return last && last.id ? String(last.id) : '';
  } catch (_) {
    return '';
  }
}

function v325SearchScore(spread, q) {
  const number = normalize(String(spread.number == null ? '' : spread.number));
  const title = normalize(spread.title || '');
  if (number === q) return 0;
  if (number.startsWith(q)) return 1;
  if (title.startsWith(q)) return 2;
  return 3;
}

renderSearch = async function() {
  const notebooks = (await getAll('notebooks'))
    .filter(n => !n.deleted_at && !n.hidden_no_access)
    .sort((a,b) => (a.sort_order-b.sort_order) || String(a.title||'').localeCompare(String(b.title||'')));

  let selectedNotebookId = v325GetSavedNotebookId();
  if (selectedNotebookId && !notebooks.some(n => String(n.id) === selectedNotebookId)) selectedNotebookId = '';
  let scope = selectedNotebookId ? 'current' : (settings.default_search_scope || 'global');
  if (scope === 'current' && !selectedNotebookId) scope = 'global';

  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <div class="scope-toggle" id="scopeToggle">
      <button data-s="current">Этот блокнот</button>
      <button data-s="global">Все блокноты</button>
    </div>
    <label style="display:block;font-size:.75rem;color:var(--ink-soft);margin:10px 0 5px">Искать в блокноте</label>
    <select id="v325NotebookSelect" style="width:100%;box-sizing:border-box;padding:11px 12px;border:1px solid var(--line);border-radius:10px;background:var(--card);font:inherit;margin-bottom:10px"></select>
    <div class="searchbar"><input id="searchInput" placeholder="Например: Рабочая, муфта, 14..." autocomplete="off"></div>
    <div id="searchResults"></div>`;
  screenEl.appendChild(wrap);

  const toggle = wrap.querySelector('#scopeToggle');
  const select = wrap.querySelector('#v325NotebookSelect');
  const input = wrap.querySelector('#searchInput');
  const resultsEl = wrap.querySelector('#searchResults');
  let objectUrls = [];

  const allOption = document.createElement('option');
  allOption.value = '';
  allOption.textContent = '— выбрать блокнот —';
  select.appendChild(allOption);
  for (const nb of notebooks) {
    const opt = document.createElement('option');
    opt.value = String(nb.id);
    opt.textContent = nb.title || 'Без названия';
    if (String(nb.id) === selectedNotebookId) opt.selected = true;
    select.appendChild(opt);
  }

  function syncScopeUi() {
    toggle.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.s === scope));
    select.disabled = scope !== 'current';
    select.style.opacity = scope === 'current' ? '1' : '.6';
  }

  async function doSearch() {
    for (const url of objectUrls) { try { URL.revokeObjectURL(url); } catch (_) {} }
    objectUrls = [];
    resultsEl.innerHTML = '';
    const q = normalize(input.value);
    if (!q) return;

    let spreads = (await getAll('spreads')).filter(s => !s.deleted_at);
    if (scope === 'current') {
      if (!selectedNotebookId) {
        resultsEl.innerHTML = '<div class="empty-state"><div class="big">📔</div>Сначала выберите блокнот</div>';
        return;
      }
      spreads = spreads.filter(s => String(s.notebook_id) === selectedNotebookId);
    }

    const matched = spreads
      .filter(s => (s.searchableText || normalize([s.number,s.title,s.note_short,s.note_full].join(' '))).includes(q))
      .sort((a,b) => v325SearchScore(a,q) - v325SearchScore(b,q) || Number(a.number||0)-Number(b.number||0));

    if (!matched.length) {
      resultsEl.innerHTML = '<div class="empty-state"><div class="big">🔎</div>Ничего не найдено</div>';
      return;
    }

    for (const sp of matched) {
      const nb = await get('notebooks', sp.notebook_id);
      const photo = sp.current_photo_id ? await get('photos', sp.current_photo_id) : null;
      let thumbSrc = null;
      if (photo) {
        const b = await get('blobs', photo.id + '_thumb');
        if (b && b.blob) {
          thumbSrc = URL.createObjectURL(b.blob);
          objectUrls.push(thumbSrc);
        }
      }
      const card = document.createElement('div');
      card.className = 'result-card';
      card.dataset.spreadId = String(sp.id);
      card.dataset.notebookId = String(sp.notebook_id);
      card.innerHTML = `${thumbSrc ? `<img class="thumb" src="${thumbSrc}">` : '<div class="thumb" style="display:flex;align-items:center;justify-content:center;">📷</div>'}
        <div class="body"><div class="nb">${esc(nb ? nb.title : '')}</div><div class="t">№${esc(sp.number)} ${esc(sp.title||'')}</div>
        <div class="snip">${esc((sp.note_short||sp.note_full||'').slice(0,80))}</div></div>`;
      card.onclick = async () => {
        if (typeof v3RememberSpread === 'function') v3RememberSpread(sp);
        const sibs = (await getAllByIndex('spreads','notebook_id', sp.notebook_id)).filter(s=>!s.deleted_at).sort((a,b)=>a.number-b.number);
        const i = sibs.findIndex(s => s.id === sp.id);
        openViewer(sibs, i < 0 ? 0 : i);
      };
      resultsEl.appendChild(card);
    }
  }

  toggle.querySelectorAll('button').forEach(b => {
    b.onclick = () => {
      if (b.dataset.s === 'current' && !selectedNotebookId && notebooks.length) {
        selectedNotebookId = String(notebooks[0].id);
        select.value = selectedNotebookId;
        localStorage.setItem(V325_SEARCH_NOTEBOOK_KEY, selectedNotebookId);
      }
      scope = b.dataset.s;
      syncScopeUi();
      doSearch();
    };
  });

  select.onchange = () => {
    selectedNotebookId = select.value;
    if (selectedNotebookId) {
      localStorage.setItem(V325_SEARCH_NOTEBOOK_KEY, selectedNotebookId);
      const nb = notebooks.find(n => String(n.id) === selectedNotebookId);
      if (nb) localStorage.setItem('blocknot_v321_last_notebook', JSON.stringify({id:nb.id,title:nb.title||'Без названия'}));
      scope = 'current';
    } else {
      localStorage.removeItem(V325_SEARCH_NOTEBOOK_KEY);
      scope = 'global';
    }
    syncScopeUi();
    doSearch();
  };

  input.addEventListener('input', doSearch);
  syncScopeUi();
};

/* Disable the older fake-navigation search decorator: renderSearch now owns the scope. */
if (typeof v323DecorateGlobalSearch === 'function') v323DecorateGlobalSearch = async function() {};
if (typeof v323SwitchSearchContext === 'function') v323SwitchSearchContext = async function(nb) {
  if (!nb) return;
  localStorage.setItem(V325_SEARCH_NOTEBOOK_KEY, String(nb.id));
  localStorage.setItem('blocknot_v321_last_notebook', JSON.stringify({id:nb.id,title:nb.title||'Без названия'}));
};

/* Clarify the current history contract until backend history sync is added. */
if (typeof v321OpenGlobalHistory === 'function') {
  const v325OpenGlobalHistoryBase = v321OpenGlobalHistory;
  v321OpenGlobalHistory = async function() {
    const r = await v325OpenGlobalHistoryBase();
    const sheets = [...document.querySelectorAll('.sheet')];
    const sheet = sheets[sheets.length - 1];
    if (sheet && /История/.test(sheet.textContent || '') && !sheet.querySelector('.v325-history-note')) {
      const p = document.createElement('p');
      p.className = 'v325-history-note';
      p.style.cssText = 'color:var(--ink-soft);font-size:.78rem;margin-top:8px';
      p.textContent = 'История этого устройства. Общая история между телефонами появится после отдельного серверного обновления.';
      const h = sheet.querySelector('h2');
      if (h) h.insertAdjacentElement('afterend', p);
    }
    return r;
  };
}
