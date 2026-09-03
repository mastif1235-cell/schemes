/* Blocknot Scan v3.4.0: one render layer and one visual system. */
(function () {
  const baseRenderSettings = renderSettings;
  const baseSpreadForm = openSpreadForm;
  const style = document.createElement('style');
  style.id = 'v340DesignSystem';
  style.textContent = `
    :root{
      --bg:var(--paper);--surface:var(--card);--surface-2:var(--paper-2);
      --text:var(--ink);--text-muted:var(--ink-soft);--border:var(--line);
      --accent-hover:color-mix(in srgb,var(--accent) 88%,#000);--success:var(--teal);
      --radius-sm:8px;--radius-md:12px;--radius-lg:18px;
      --space-1:6px;--space-2:10px;--space-3:14px;--space-4:18px;
      --shadow-card:0 2px 8px var(--shadow);
    }
    button,.btn-big,.btn-primary,.btn-secondary,.btn-ghost,.btn-danger,.btn-small{
      min-height:44px;padding:10px 14px;border-radius:var(--radius-md);font:600 .92rem/1.2 var(--font-sans);
      transition:background .15s ease,transform .1s ease,opacity .15s ease;touch-action:manipulation;
    }
    .btn-big,.btn-primary{width:100%;background:var(--accent);color:var(--accent-ink);border:1px solid transparent;box-shadow:none;}
    .btn-secondary{width:100%;background:var(--surface);color:var(--text);border:1px solid var(--border);}
    .btn-ghost{background:transparent;color:var(--text);border:1px solid transparent;}
    .btn-danger{width:100%;background:var(--danger);color:#fff;border:1px solid transparent;}
    button:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible{outline:3px solid color-mix(in srgb,var(--accent) 35%,transparent);outline-offset:2px;}
    button:disabled{opacity:.5;cursor:default;}
    .icon-btn,#v340HistoryButton{width:44px;height:44px;min-height:44px;padding:0;border-radius:50%;font-size:1.2rem;display:grid;place-items:center;}
    .screen{padding:var(--space-3) var(--space-3) 90px;}
    .notebook-card,.spread-card,.result-card,.settings-row,.v340-history-row{
      background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-md);box-shadow:var(--shadow-card);
    }
    .notebook-card{padding:var(--space-3);margin-bottom:var(--space-2);border-left:5px solid var(--success);}
    .spread-grid{display:grid;grid-template-columns:1fr;gap:var(--space-2);}
    .spread-card{display:grid;grid-template-columns:92px minmax(0,1fr);overflow:hidden;min-height:120px;}
    .spread-card .thumb{width:92px;height:100%;min-height:120px;aspect-ratio:auto;}
    .spread-card .info{padding:var(--space-3);}
    .v340-stack{display:grid;gap:var(--space-2);}
    .v340-search{width:100%;margin:0 0 var(--space-2);}
    .v340-search input,.field input,.field textarea,.field select,select{
      width:100%;min-height:46px;padding:11px 12px;border:1px solid var(--border);border-radius:var(--radius-sm);
      background:var(--surface);color:var(--text);font:inherit;
    }
    .v340-search input{font-size:1rem;}
    .v340-search-scope{display:grid;gap:6px;}
    .v340-search-scope label{font-size:.82rem;color:var(--text-muted);}
    .v340-caption{color:var(--text-muted);font-size:.82rem;line-height:1.4;margin:0 0 var(--space-3);}
    .v340-action-list{display:grid;gap:var(--space-2);}
    .v340-cover-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:var(--space-2);}
    .v340-cover-choice{min-height:170px;padding:0;overflow:hidden;border:1px solid var(--border);border-radius:var(--radius-md);}
    .v340-cover-choice img{display:block;width:100%;height:170px;object-fit:cover;}
    .v340-notebook-cover{position:absolute;right:14px;top:50%;transform:translateY(-50%);width:52px;height:72px;object-fit:cover;border-radius:8px;border:1px solid var(--border);}
    .v340-photo-state{position:absolute;left:6px;bottom:6px;padding:3px 7px;border-radius:999px;background:#000b;color:#fff;font-size:.68rem;z-index:3;}
    .v340-settings-card{padding:var(--space-3);margin-bottom:var(--space-2);}
    .section-title{font-size:.82rem;margin:var(--space-4) 0 var(--space-2);color:var(--text-muted);}
    .bottomnav button{min-height:58px;padding:7px 2px;font-size:.7rem;border-radius:0;}
    .bottomnav button .glyph{font-size:1.2rem;}
    .topbar{gap:var(--space-1);padding:10px 12px;}
    .topbar h1{font-size:1.2rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
    @media (max-width:380px){.topbar{gap:2px}.icon-btn,#v340HistoryButton{width:40px;height:40px;min-height:40px}.topbar h1{font-size:1.05rem}}
  `;
  document.head.appendChild(style);

  function releaseImageUrl(img) {
    if (!img || !String(img.src || '').startsWith('blob:')) return;
    const url = img.src;
    const release = () => {
      try { URL.revokeObjectURL(url); }
      catch (error) { console.warn('Image object URL could not be released', error); }
    };
    if (img.complete) release();
    else { img.addEventListener('load', release, {once:true}); img.addEventListener('error', release, {once:true}); }
  }

  async function decorateSpreadCard(card, spread, queue) {
    card.dataset.spreadId = spread.id;
    const photo = spread.current_photo_id ? await get('photos', spread.current_photo_id) : null;
    const image = card.querySelector('img.thumb');
    if (image) { image.dataset.photoId = photo ? photo.id : ''; releaseImageUrl(image); }
    if (photo && typeof window.v340GetPhotoSyncState === 'function') {
      const state = window.v340GetPhotoSyncState(photo, queue);
      const badge = document.createElement('span');
      badge.className = 'v340-photo-state';
      badge.textContent = state.label;
      card.appendChild(badge);
    }
  }

  function addLongPress(card, notebook) {
    let timer = null, startX = 0, startY = 0;
    const cancel = () => { if (timer) clearTimeout(timer); timer = null; };
    card.addEventListener('pointerdown', event => {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      startX = event.clientX; startY = event.clientY;
      timer = setTimeout(() => { timer = null; card.dataset.suppressClick = '1'; openNotebookEditor(notebook); }, 550);
    });
    card.addEventListener('pointermove', event => {
      if (Math.hypot(event.clientX - startX, event.clientY - startY) > 10) cancel();
    });
    card.addEventListener('pointerup', cancel);
    card.addEventListener('pointercancel', cancel);
    card.addEventListener('contextmenu', event => { event.preventDefault(); cancel(); card.dataset.suppressClick = '1'; openNotebookEditor(notebook); });
  }

  renderNotebooks = async function () {
    const notebooks = (await getAll('notebooks')).filter(row => !row.deleted_at && !row.hidden_no_access)
      .sort((a, b) => (a.sort_order - b.sort_order) || 0);
    const wrap = document.createElement('div');
    wrap.className = 'v340-stack';
    const create = document.createElement('button');
    create.className = 'btn-primary'; create.textContent = '+ Новый блокнот';
    create.onclick = () => openNotebookEditor(null);
    wrap.appendChild(create);
    const links = document.createElement('div');
    links.className = 'btn-row';
    links.innerHTML = '<button class="btn-ghost" data-route="tags">🏷️ Теги</button><button class="btn-ghost" data-route="trash">🗑️ Корзина</button>';
    links.onclick = event => {
      const button = event.target.closest('button[data-route]');
      if (!button) return;
      route = {screen:button.dataset.route}; render();
    };
    wrap.appendChild(links);
    if (!notebooks.length) {
      const empty = document.createElement('div'); empty.className = 'empty-state';
      empty.innerHTML = '<div class="big">📔</div><div>Пока нет ни одного блокнота.<br>Создайте первый, чтобы начать.</div>';
      wrap.appendChild(empty);
    }
    for (const notebook of notebooks) {
      const spreads = (await getAllByIndex('spreads', 'notebook_id', notebook.id)).filter(row => !row.deleted_at);
      const card = document.createElement('div');
      card.className = 'notebook-card' + (notebook.archived ? ' archived' : '');
      card.dataset.notebookId = notebook.id;
      const dates = spreads.map(row => +new Date(row.updated_at)).filter(Number.isFinite);
      const last = dates.length ? Math.max(...dates) : +new Date(notebook.updated_at);
      card.innerHTML = `<div class="title">${esc(notebook.title)}</div>
        ${notebook.description ? `<div class="desc">${esc(notebook.description)}</div>` : ''}
        <div class="meta"><span>${spreads.length} разворотов</span><span>изм. ${new Date(last).toLocaleDateString('ru-RU')}</span></div>`;
      card.onclick = event => {
        if (card.dataset.suppressClick) { delete card.dataset.suppressClick; return; }
        if (event.defaultPrevented) return;
        route = {screen:'spreads', notebookId:notebook.id}; render();
      };
      addLongPress(card, notebook);
      const coverUrl = await getNotebookCoverUrl(notebook);
      if (coverUrl) {
        card.style.paddingRight = '84px';
        const image = document.createElement('img');
        image.className = 'v340-notebook-cover'; image.src = coverUrl; image.alt = '';
        releaseImageUrl(image); card.appendChild(image);
      }
      wrap.appendChild(card);
    }
    screenEl.appendChild(wrap);
    if (typeof window.v340RefreshHistoryBadge === 'function') window.v340RefreshHistoryBadge();
  };

  function rankSpread(spread, query) {
    const number = String(spread.number == null ? '' : spread.number).toLowerCase();
    if (number === query) return 0;
    if (number.startsWith(query)) return 1;
    const text = normalize([spread.title, spread.note_short, spread.note_full, spread.searchableText].join(' '));
    return text.includes(query) || number.includes(query) ? 2 : 99;
  }

  async function renderSpreadList(host, spreads, query, isCurrent) {
    const stillCurrent = typeof isCurrent === 'function' ? isCurrent : () => true;
    const q = normalize(query || '').trim();
    const ranked = spreads.map((spread, index) => ({spread, index, rank:q ? rankSpread(spread, q) : 0}))
      .filter(row => row.rank < 99)
      .sort((a, b) => a.rank - b.rank || Number(a.spread.number) - Number(b.spread.number) || a.index - b.index);
    if (!ranked.length) {
      if (stillCurrent()) host.innerHTML = '<div class="empty-state"><div class="big">🔎</div>Ничего не найдено</div>';
      return;
    }
    const queue = await getAll('sync_queue');
    if (!stillCurrent()) return;
    const grid = document.createElement('div'); grid.className = 'spread-grid';
    for (const row of ranked) {
      const card = await spreadCard(row.spread, () => window.v340OpenSpread(row.spread));
      await decorateSpreadCard(card, row.spread, queue);
      if (!stillCurrent()) return;
      grid.appendChild(card);
    }
    if (stillCurrent()) host.replaceChildren(grid);
  }

  renderSpreads = async function () {
    const notebook = await get('notebooks', route.notebookId);
    if (!notebook) { route = {screen:'notebooks'}; return render(); }
    topTitle.textContent = notebook.title;
    const spreads = (await getAllByIndex('spreads', 'notebook_id', notebook.id)).filter(row => !row.deleted_at)
      .sort((a, b) => Number(a.number) - Number(b.number));
    currentSpreadsCache = spreads;
    topSub.textContent = spreads.length + ' разворотов';
    const wrap = document.createElement('div'); wrap.className = 'v340-stack';
    wrap.innerHTML = '<div class="v340-search"><input type="search" id="v340NotebookSearch" placeholder="Поиск в этом блокноте" autocomplete="off"></div>';
    const add = document.createElement('button'); add.className = 'btn-primary'; add.textContent = '+ Добавить разворот';
    add.onclick = () => openAddSpreadFlow(notebook.id); wrap.appendChild(add);
    const order = document.createElement('button'); order.className = 'btn-secondary';
    order.textContent = '↕ Изменить порядок разворотов'; order.onclick = () => window.vNextOpenOrder(notebook);
    wrap.appendChild(order);
    const results = document.createElement('div'); wrap.appendChild(results); screenEl.appendChild(wrap);
    let searchRevision = 0;
    if (!spreads.length) results.innerHTML = '<div class="empty-state"><div class="big">📄</div>В этом блокноте пока нет разворотов.</div>';
    else {
      const revision = ++searchRevision;
      await renderSpreadList(results, spreads, '', () => revision === searchRevision);
    }
    wrap.querySelector('#v340NotebookSearch').addEventListener('input', event => {
      const revision = ++searchRevision;
      renderSpreadList(results, spreads, event.target.value, () => revision === searchRevision)
        .catch(error => console.warn('Notebook search could not be rendered', error));
    });
  };

  renderSearch = async function () {
    const notebooks = (await getAll('notebooks')).filter(row => !row.deleted_at && !row.hidden_no_access);
    const wrap = document.createElement('div'); wrap.className = 'v340-stack';
    wrap.innerHTML = `<div class="v340-search-scope"><label for="v340SearchNotebook">Блокнот</label><select id="v340SearchNotebook"><option value="">Все блокноты</option></select></div>
      <div class="v340-search"><input type="search" placeholder="Номер, название, примечание или тег" autocomplete="off"></div><div class="v340-results"></div>`;
    screenEl.appendChild(wrap);
    const selector = wrap.querySelector('#v340SearchNotebook');
    for (const notebook of notebooks) {
      const option = document.createElement('option'); option.value = notebook.id; option.textContent = notebook.title;
      selector.appendChild(option);
    }
    if (route.notebookId && notebooks.some(notebook => notebook.id === route.notebookId)) selector.value = route.notebookId;
    const input = wrap.querySelector('input');
    const results = wrap.querySelector('.v340-results');
    let searchRevision = 0;
    const run = async () => {
      const revision = ++searchRevision;
      const query = input.value.trim();
      if (!query) { if (revision === searchRevision) results.innerHTML = ''; return; }
      let spreads = (await getAll('spreads')).filter(row => !row.deleted_at);
      if (selector.value) spreads = spreads.filter(row => row.notebook_id === selector.value);
      await renderSpreadList(results, spreads, query, () => revision === searchRevision);
    };
    const safeRun = () => run().catch(error => console.warn('Search could not be rendered', error));
    selector.addEventListener('change', () => { route.notebookId = selector.value || null; safeRun(); });
    input.addEventListener('input', safeRun);
    safeRun();
  };

  const searchNavButton = document.querySelector('#bottomnav button[data-nav="search"]');
  if (searchNavButton) searchNavButton.addEventListener('click', event => {
    if (route.screen !== 'spreads' || !route.notebookId) return;
    const notebookId = route.notebookId;
    event.preventDefault(); event.stopImmediatePropagation();
    route = {screen:'search', notebookId}; render();
  }, true);

  renderFavorites = async function () {
    let allSpreads = [];
    try { allSpreads = await getAll('spreads'); }
    catch (error) { console.error('Favorites could not read local spreads', error); }
    const knownSpreads = new Map(allSpreads.filter(row => row && row.id).map(row => [row.id, row]));
    try {
      const favoriteRefs = await getAll('user_favorites');
      for (const ref of favoriteRefs) {
        const spreadId = ref && ref.spread_id;
        const spread = knownSpreads.get(spreadId);
        if (!spreadId || !spread || spread.deleted_at) {
          try { if (spreadId) await del('user_favorites', spreadId); }
          catch (error) { console.warn('Stale favorite reference could not be removed', spreadId, error); }
        }
      }
    } catch (error) { console.warn('Favorite references could not be checked', error); }
    const stale = allSpreads.filter(row => row.deleted_at && row.favorite);
    for (const spread of stale) {
      spread.favorite = false;
      try { await put('spreads', spread); await del('user_favorites', spread.id); }
      catch (error) { console.warn('Deleted spread favorite could not be cleared', spread.id, error); }
    }
    const favorites = allSpreads.filter(row => !row.deleted_at && row.favorite);
    const wrap = document.createElement('div'); wrap.className = 'v340-stack'; screenEl.appendChild(wrap);
    const recentRows = await (async () => {
      const rows = [];
      const recents = typeof window.v340PruneRecents === 'function' ? await window.v340PruneRecents() : v3LoadRecents();
      for (const recent of recents) {
        const spread = await get('spreads', recent.id);
        if (spread && !spread.deleted_at) rows.push(spread);
      }
      return rows.slice(0, 6);
    })();
    if (recentRows.length) {
      const title = document.createElement('h3'); title.textContent = 'Последние открытые'; wrap.appendChild(title);
      const recentHost = document.createElement('div'); recentHost.className = 'v340-stack';
      for (const spread of recentRows) {
        const button = document.createElement('button'); button.className = 'btn-secondary';
        button.textContent = `№${spread.number} ${spread.title || ''}`; button.onclick = () => window.v340OpenSpread(spread);
        recentHost.appendChild(button);
      }
      wrap.appendChild(recentHost);
    }
    const title = document.createElement('h3'); title.textContent = 'Избранное'; wrap.appendChild(title);
    const host = document.createElement('div'); wrap.appendChild(host);
    if (!favorites.length) host.innerHTML = '<div class="empty-state"><div class="big">⭐</div>Пока нет избранных разворотов.</div>';
    else await renderSpreadList(host, favorites, '');
  };

  window.vNextOpenOrder = async function (notebook) {
    const team = window.vNextSync;
    if (!notebook.server_id || !team.enabled('spread_order')) { toast('Порядок доступен после синхронизации блокнота и обновления сервера'); return; }
    const scope = team.scope();
    const rows = (await getAllByIndex('spreads','notebook_id',notebook.id)).filter(row => !row.deleted_at).sort((a,b) => a.number - b.number);
    if (rows.length < 2 || rows.length > 200 || rows.some(row => !row.server_id)) { toast('Нужно от 2 до 200 синхронизированных разворотов'); return; }
    const prior = (await getAll('sync_queue')).filter(item => item.entity === 'spread_order' && item.local_id === notebook.id && item.status !== 'done');
    if (prior.some(item => item.status !== 'conflict')) { toast('Предыдущая перестановка ещё ожидает синхронизации'); return; }
    const {el,close} = openSheet(`<div class="sheet-handle"></div><h2>Порядок разворотов</h2>
      <p>Перетащите строку или используйте ↑ ↓. Номера станут 1…${rows.length} только после нажатия «Сохранить» и подтверждения сервера.</p>
      ${prior.length ? '<p class="warn-box">Порядок изменился на другом устройстве. Сначала синхронизируйте, затем повторите перестановку.</p>' : ''}
      <div data-order-list></div><p data-order-error role="alert"></p><button class="btn-primary" data-order-save>Сохранить порядок</button>`);
    let draft = rows.slice(), dragged = null;
    function move(from,to) {
      if (from < 0 || to < 0 || to >= draft.length) return;
      const [item] = draft.splice(from,1); draft.splice(to,0,item); draw();
    }
    function draw() {
      const list = el.querySelector('[data-order-list]'); list.replaceChildren();
      draft.forEach((row,index) => {
        const item = document.createElement('div'); item.className = 'vnext-order-row'; item.draggable = true;
        item.innerHTML = `<span>☰ ${index+1}. ${esc(row.title || 'Без названия')} <small>(был №${esc(row.number)})</small></span>
          <button data-up aria-label="Выше" ${index ? '' : 'disabled'}>↑</button><button data-down aria-label="Ниже" ${index === draft.length-1 ? 'disabled' : ''}>↓</button>`;
        item.querySelector('[data-up]').onclick = () => move(index,index-1);
        item.querySelector('[data-down]').onclick = () => move(index,index+1);
        item.ondragstart = event => { dragged = row.id; event.dataTransfer.setData('text/plain',row.id); };
        item.ondragover = event => event.preventDefault();
        item.ondrop = event => { event.preventDefault(); move(draft.findIndex(row => row.id === dragged),index); dragged = null; };
        list.appendChild(item);
      });
    }
    draw();
    el.querySelector('[data-order-save]').onclick = async event => {
      event.target.disabled = true;
      try {
        if (team.scope() !== scope) throw new Error('Аккаунт изменился');
        await window.vNextAtomic('notebooks',notebook.id,current => {
          if (!current || current.hidden_no_access || current.deleted_at) throw new Error('Блокнот недоступен');
          return {retired:prior.map(item => ({...item,status:'done',last_error:'order replaced explicitly'})),
            item:{entity:'spread_order',local_id:notebook.id,scope,status:'pending',retry_count:0,
              payload:{client_ref:uid(),items:draft.map(row => ({spread_id:row.server_id,expected_revision:row.revision,expected_number:row.number}))}}};
        });
        close(); toast('Порядок ожидает подтверждения сервера'); void fullSync();
      } catch (error) { console.warn('Order save failed',error); el.querySelector('[data-order-error]').textContent = error.message; event.target.disabled = false; }
    };
  };

  openSpreadForm = async function (notebookId, existing, photoFile) {
    const team = window.vNextSync;
    if (!existing?.server_id || !team.enabled('field_merge')) return baseSpreadForm(notebookId,existing,photoFile);
    const spread = await get('spreads',existing.id);
    if (!spread || spread.deleted_at) { toast('Разворот недоступен'); return; }
    const scope = team.scope(), base = team.metadata(spread);
    const queued = (await getAll('sync_queue')).filter(item => item.entity === 'spread_fields' && item.local_id === spread.id && item.status !== 'done');
    if (queued.some(item => item.status !== 'conflict')) { toast('Сначала синхронизируйте предыдущее изменение полей'); return; }
    const retired = queued.filter(item => item.status === 'conflict');
    const labels = {number:'Номер разворота',title:'Название',status:'Статус',note_short:'Старое краткое примечание',note_full:'Старое полное примечание'};
    const conflicts = spread.field_conflicts || {};
    const allTags = await getAll('tags'), links = await getAllByIndex('spread_tags','spread_id',spread.id);
    const names = links.map(link => allTags.find(tag => tag.id === link.tag_id)?.name).filter(Boolean);
    const {el,close} = openSheet(`<div class="sheet-handle"></div><h2>Редактировать разворот</h2>
      <p>Фото не изменяется. Новые записи добавляйте в «Примечания» под фото.</p>
      ${Object.keys(base).map(key => `<div class="field"><label>${labels[key]}</label>
        ${key === 'status' ? `<select data-field="${key}">${[...new Set([base.status,'Актуально','Требует проверки','Устарело'])].map(value => `<option ${value === base.status ? 'selected' : ''}>${esc(value)}</option>`).join('')}</select>` : key === 'note_full' ? `<textarea data-field="${key}" maxlength="10000">${esc(base[key])}</textarea>` : `<input data-field="${key}" type="${key === 'number' ? 'number' : 'text'}" value="${esc(base[key])}" maxlength="10000">`}
        ${conflicts[key] ? `<div class="warn-box">Было: ${esc(conflicts[key].base ?? '—')}<br>На сервере: ${esc(conflicts[key].server ?? '—')}<br>Ваше: ${esc(conflicts[key].mine ?? '—')}<button data-use-server="${key}">Взять поле с сервера</button></div>` : ''}</div>`).join('')}
      <div class="field"><label>Теги через запятую</label><input data-tags value="${esc(names.join(', '))}"></div>
      <p data-fields-error role="alert"></p><button class="btn-primary" data-fields-save>Сохранить</button>`);
    el.querySelectorAll('[data-use-server]').forEach(button => button.onclick = () => {
      el.querySelector(`[data-field="${button.dataset.useServer}"]`).value = conflicts[button.dataset.useServer].server ?? '';
    });
    el.querySelector('[data-fields-save]').onclick = async event => {
      event.target.disabled = true;
      try {
        if (team.scope() !== scope) throw new Error('Аккаунт изменился');
        const changes = {}, bases = {};
        for (const key of Object.keys(base)) {
          const input = el.querySelector(`[data-field="${key}"]`);
          const value = key === 'number' ? Number(input.value) : input.value.trim();
          if (key === 'number' && (!Number.isSafeInteger(value) || value < 1)) throw new Error('Номер должен быть целым положительным числом');
          const previous = retired.find(item => Object.hasOwn(item.payload.changes,key));
          if (value !== base[key] || previous) {
            changes[key] = value;
            bases[key] = conflicts[key] ? conflicts[key].server : previous ? previous.payload.base_values[key] : base[key];
          }
        }
        const duplicate = (await getAllByIndex('spreads','notebook_id',notebookId)).some(row => !row.deleted_at && row.id !== spread.id && row.number === changes.number);
        if (duplicate) throw new Error('Этот номер уже занят; для обмена номерами используйте «Изменить порядок»');
        await team.saveFields(spread,changes,bases,retired);
        const chosen = [...new Set(el.querySelector('[data-tags]').value.split(',').map(name => name.trim()).filter(Boolean))];
        // Keep unrelated/newly pulled links; change only tags explicitly edited in this form.
        for (const name of chosen.filter(name => !names.includes(name))) {
          let tag = allTags.find(row => row.name === name);
          if (!tag) { tag = {id:uid(),name}; await put('tags',tag); allTags.push(tag); }
          await put('spread_tags',{spread_id:spread.id,tag_id:tag.id});
          await queueEntityChange('tag_link',spread.id,{tag_id:tag.id,op:'add'});
        }
        for (const name of names.filter(name => !chosen.includes(name))) {
          const tag = allTags.find(row => row.name === name);
          for (const link of links.filter(row => row.tag_id === tag.id)) await del('spread_tags',link.id);
          await queueEntityChange('tag_link',spread.id,{tag_id:tag.id,op:'remove'});
        }
        if (photoFile) await attachPhoto(await get('spreads',spread.id),photoFile);
        close(); toast('Сохранено на устройстве'); route = {screen:'spreads',notebookId}; render();
      } catch (error) { console.warn('Field edit failed',error); el.querySelector('[data-fields-error]').textContent = error.message; event.target.disabled = false; }
    };
  };

  const teamStyle = document.createElement('style');
  teamStyle.textContent = `.vnext-order-row{display:grid;grid-template-columns:minmax(0,1fr) 44px 44px;gap:8px;align-items:center;padding:8px;border-bottom:1px solid var(--border)}.vnext-order-row button{padding:0;min-width:44px}.v340-history-list pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:.82rem}.v340-history-list summary{cursor:pointer;padding:10px 0}`;
  document.head.appendChild(teamStyle);
  window.BlocknotV3.on('spread-order-saved',({notebookId}) => {
    toast('Порядок подтверждён сервером');
    if (route.screen === 'spreads' && route.notebookId === notebookId) render();
  });

  renderSettings = async function () {
    await baseRenderSettings();
    const syncButton = document.getElementById('btnSyncNow');
    if (syncButton && !document.getElementById('v340SettingsInvite')) {
      const invite = document.createElement('button'); invite.id = 'v340SettingsInvite';
      invite.className = 'btn-secondary'; invite.textContent = '🔗 Ввести код приглашения';
      invite.onclick = window.v340OpenRedeemInvite;
      syncButton.insertAdjacentElement('afterend', invite);
    }
    const footer = [...screenEl.querySelectorAll('div')].find(element => /Блокнот-скан\s*·/.test(element.textContent || '') && element.children.length === 0);
    if (footer) footer.textContent = 'Блокнот-скан · v3.4.2 · Stable';
    screenEl.querySelectorAll('.settings-row').forEach(row => row.classList.add('v340-settings-card'));
  };
})();
