/* Blocknot Scan v3.4.0: explicitly local history with direct spread navigation. */
(function () {
  const SEEN_KEY = 'blocknot_v340_history_seen_at';
  const HIDDEN_KEY = 'blocknot_v340_history_hidden_before';
  const baseLogHistory = logHistory;
  for (const id of ['v329HistoryIcon', 'v321GlobalHistoryBtn', 'v322RedeemInviteBtn']) {
    const legacy = document.getElementById(id);
    if (legacy) legacy.remove();
  }

  function eventTime(row) {
    const value = row && (row.created_at || row.timestamp || row.updated_at || row.at);
    const time = value ? new Date(value).getTime() : 0;
    return Number.isFinite(time) ? time : 0;
  }

  async function rowsForNotebook(notebook) {
    const spreads = await getAllByIndex('spreads', 'notebook_id', notebook.id);
    const ids = new Set(spreads.map(spread => spread.id));
    return (await getAll('history')).filter(row => row.notebook_id === notebook.id || ids.has(row.spread_id) || ids.has(row.entity_id));
  }

  async function visibleRows(notebook) {
    const hiddenBefore = Number(localStorage.getItem(HIDDEN_KEY) || 0);
    const rows = notebook ? await rowsForNotebook(notebook) : await getAll('history');
    return rows.filter(row => eventTime(row) > hiddenBefore).sort((a, b) => eventTime(b) - eventTime(a));
  }

  function actionLabel(action) {
    const labels = {
      'Создано':'Создан разворот', 'Изменено':'Изменён разворот',
      'Фото добавлено/заменено':'Добавлено или заменено фото',
      spread_created:'Создан разворот', spread_updated:'Изменён разворот', photo_added:'Добавлено фото'
      ,'note.created':'Добавлено примечание', 'note.updated':'Изменено примечание', 'note.deleted':'Удалено примечание',
      'spread.updated':'Изменены поля разворота', 'spread.reordered':'Изменён порядок разворотов',
      'photo.added':'Добавлена версия фото', 'photo.made_current':'Выбрана версия фото'
    };
    return labels[action] || action || 'Изменение';
  }

  async function resolveSpread(row) {
    const ids = [row && row.spread_id, row && row.entity === 'spread' ? row.entity_id : null, row && row.spreadId].filter(Boolean);
    for (const id of ids) {
      const spread = await get('spreads', id);
      if (spread) return spread;
    }
    return null;
  }

  async function resolveNotebook(row, spread, scopedNotebook) {
    if (scopedNotebook && !scopedNotebook.deleted_at) return scopedNotebook;
    const id = spread && spread.notebook_id || row && (row.notebook_id || row.notebookId);
    if (!id) return null;
    const notebook = await get('notebooks', id);
    return notebook && !notebook.deleted_at ? notebook : null;
  }

  async function openHistory(notebook) {
    const rows = (await visibleRows(notebook)).slice(0, 100);
    localStorage.setItem(SEEN_KEY, String(Date.now()));
    const {close, el} = openSheet(`<div class="sheet-handle"></div><div class="v340-history-head">
      <h2>🕘 История этого устройства</h2>${notebook ? '' : '<button class="btn-ghost" data-clear>Очистить у меня</button>'}</div>
      <p class="v340-caption">Локальная история на этом телефоне. Она не синхронизируется и не является общей историей команды.</p>
      <div class="v340-history-list"></div>`);
    const host = el.querySelector('.v340-history-list');
    if (!rows.length) host.innerHTML = '<div class="empty-state">История пока пуста.</div>';
    for (const row of rows) {
      const spread = await resolveSpread(row);
      const targetNotebook = await resolveNotebook(row, spread, notebook);
      const item = document.createElement('div'); item.className = 'v340-history-row';
      item.innerHTML = `<div><strong>${esc(actionLabel(row.action))}</strong>
        ${spread ? `<div>Разворот №${esc(spread.number)}</div>` : '<div class="v340-caption">Связанный разворот удалён или недоступен</div>'}
        <small>${eventTime(row) ? new Date(eventTime(row)).toLocaleString('ru-RU') : ''}</small></div>
        ${spread && !spread.deleted_at ? '<button class="btn-secondary" data-open="spread">Открыть</button>' : targetNotebook ? '<button class="btn-secondary" data-open="notebook">Открыть блокнот</button>' : ''}`;
      const button = item.querySelector('button');
      if (button) button.onclick = async () => {
        close();
        if (button.dataset.open === 'spread') await window.v340OpenSpread(spread);
        else { route = {screen:'spreads', notebookId:targetNotebook.id}; render(); }
      };
      host.appendChild(item);
    }
    const clear = el.querySelector('[data-clear]');
    if (clear) clear.onclick = () => {
      localStorage.setItem(HIDDEN_KEY, String(Date.now()));
      localStorage.setItem(SEEN_KEY, String(Date.now()));
      close(); toast('История скрыта только на этом устройстве'); refreshBadge();
    };
    refreshBadge();
  }

  window.v340RefreshHistoryBadge = refreshBadge;
  async function refreshBadge() {
    const button = document.getElementById('v340HistoryButton');
    if (!button) return;
    const seen = Number(localStorage.getItem(SEEN_KEY) || 0);
    const count = (await visibleRows(null)).filter(row => eventTime(row) > seen).length;
    button.innerHTML = `🕘${count ? `<span class="v340-history-badge">${count > 99 ? '99+' : count}</span>` : ''}`;
    button.setAttribute('aria-label', count ? `История, новых записей: ${count}` : 'История');
  }

  async function openTeamHistory(notebook) {
    if (!notebook.server_id || !window.vNextSync.enabled('activity')) return openHistory(notebook);
    const team = window.vNextSync, sessionScope = team.scope();
    const {el,close} = openSheet(`<div class="sheet-handle"></div><h2>🕘 История команды</h2>
      <p>${esc(notebook.title)}</p><p data-team-state role="status"></p>
      <button class="btn-secondary" data-local-history>История этого устройства</button>
      <div class="v340-history-list" data-team-history></div><button class="btn-secondary" data-more hidden>Ещё</button>`);
    el.querySelector('[data-local-history]').onclick = () => { close(); openHistory(notebook); };
    const host = el.querySelector('[data-team-history]'), more = el.querySelector('[data-more]');
    const state = el.querySelector('[data-team-state]');
    let before = null, accessDenied = false;
    const value = input => {
      if (typeof input === 'string') { try { return JSON.parse(input); } catch { return input; } }
      return input;
    };
    const describe = input => input === null || input === undefined ? '—' : typeof input === 'object' ? JSON.stringify(input,null,2) : String(input);
    async function draw() {
      const events = (await getAll('activity_events')).filter(row => row.scope === sessionScope && row.notebook_id === notebook.server_id)
        .sort((a,b) => eventTime(b) - eventTime(a) || (b.seq || 0) - (a.seq || 0));
      if (!el.isConnected || team.scope() !== sessionScope) return;
      host.replaceChildren();
      if (accessDenied) return;
      if (!events.length) host.textContent = 'Загруженных событий пока нет.';
      const spreads = await getAllByIndex('spreads','notebook_id',notebook.id);
      for (const row of events) {
        const spread = spreads.find(item => item.server_id === row.spread_id);
        const item = document.createElement('article'); item.className = 'v340-history-row';
        item.innerHTML = `<div><strong>${esc(row.actor?.display_name || row.actor_display_name || 'Участник')}</strong>
          <small> · ${esc(new Date(eventTime(row)).toLocaleString('ru-RU'))}</small>
          <div>${esc(notebook.title)}${row.spread_number || spread ? ' · №' + esc(row.spread_number ?? spread.number) : ''}</div>
          <details><summary>${esc(actionLabel(row.action))}</summary>
          ${row.legacy ? '<p>Старая запись: значения «было / стало» не сохранены.</p>' : `<div>Было<pre>${esc(describe(value(row.old_value)))}</pre></div><div>Стало<pre>${esc(describe(value(row.new_value)))}</pre></div>`}</details></div>
          ${spread && !spread.deleted_at ? '<button class="btn-secondary" data-open>Открыть</button>' : ''}`;
        item.querySelector('[data-open]')?.addEventListener('click',async () => {
          close(); await window.v340OpenSpread(await get('spreads',spread.id));
        });
        host.appendChild(item);
      }
    }
    async function load() {
      more.disabled = true;
      try {
        if (!isOnline()) { state.textContent = 'Офлайн: показана сохранённая история команды.'; return; }
        const data = await api(`/api/notebooks/${encodeURIComponent(notebook.server_id)}/activity?limit=100${before === null ? '' : '&before_seq=' + before}`);
        if (team.scope() !== sessionScope) return;
        for (const event of [...data.events,...(data.legacy_events || [])]) {
          const cache_id = sessionScope + '|' + (event.legacy ? 'legacy:' : '') + event.id;
          await window.vNextAtomic('activity_events',cache_id,() => ({row:{...event,scope:sessionScope,cache_id}}));
        }
        before = data.next_before_seq;
        more.hidden = !data.has_more || before === null;
        state.textContent = 'Общая история участников. Старые записи показаны без деталей; загружаются последние 100 старых записей.';
      } catch (error) {
        console.warn('Team history load failed',error);
        accessDenied = error.status === 403 || error.status === 401;
        state.textContent = 'Не удалось обновить общую историю: ' + error.message;
      } finally { more.disabled = false; await draw(); }
    }
    more.onclick = load;
    await draw(); await load();
  }

  window.openNotebookHistory = notebook => openTeamHistory(notebook);
  window.v340OpenGlobalHistory = async () => {
    const notebook = route.screen === 'spreads' && route.notebookId ? await get('notebooks',route.notebookId) : null;
    return notebook ? openTeamHistory(notebook) : openHistory(null);
  };
  logHistory = async function (spreadId, action) {
    await baseLogHistory(spreadId, action);
    BlocknotV3.emit('history-change');
    refreshBadge();
  };

  const historyButton = document.createElement('button');
  historyButton.id = 'v340HistoryButton'; historyButton.className = 'icon-btn';
  historyButton.onclick = window.v340OpenGlobalHistory;
  const theme = document.getElementById('themeBtn');
  if (theme && theme.parentElement) theme.parentElement.insertBefore(historyButton, theme);
  BlocknotV3.on('history-change', refreshBadge);
  BlocknotV3.on('db-ready', refreshBadge);

  const style = document.createElement('style');
  style.textContent = `#v340HistoryButton{position:relative;background:none;border:0;color:var(--text)}.v340-history-badge{position:absolute;right:0;top:0;min-width:18px;height:18px;padding:0 4px;border-radius:10px;background:var(--danger);color:#fff;font:700 10px/18px var(--font-sans)}.v340-history-head{display:flex;align-items:center;justify-content:space-between;gap:8px}.v340-history-head h2{margin:0}.v340-history-list{display:grid;gap:8px}.v340-history-row{padding:12px;display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:10px}.v340-history-row .btn-secondary{width:auto}`;
  document.head.appendChild(style);
})();
