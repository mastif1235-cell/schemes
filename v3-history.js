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

  window.openNotebookHistory = notebook => openHistory(notebook);
  window.v340OpenGlobalHistory = () => openHistory(null);
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
