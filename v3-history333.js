/* Blocknot Scan v3.3.3: open the affected spread directly from History. */

async function v333ResolveHistorySpread(h) {
  if (!h) return null;
  const ids = [h.spread_id, h.entity === 'spread' ? h.entity_id : null, h.spreadId].filter(Boolean);
  for (const id of ids) {
    try {
      const sp = await get('spreads', id);
      if (sp && !sp.deleted_at) return sp;
    } catch (_) {}
  }
  return null;
}

async function v333OpenHistorySpread(h, closeSheet) {
  const sp = await v333ResolveHistorySpread(h);
  if (!sp) { toast('Этот разворот больше недоступен'); return; }
  try { if (typeof v3RememberSpread === 'function') v3RememberSpread(sp); } catch (_) {}
  try { if (closeSheet) closeSheet(); } catch (_) {}

  if (typeof openSpread === 'function') {
    try { await openSpread(sp); return; } catch (_) {}
  }
  if (typeof openSpreadEditor === 'function') {
    try { await openSpreadEditor(sp); return; } catch (_) {}
  }
  if (sp.current_photo_id) {
    try {
      const p = await get('photos', sp.current_photo_id);
      if (p && typeof v321OpenRegularPhoto === 'function') { await v321OpenRegularPhoto(p); return; }
    } catch (_) {}
  }
  toast('Не удалось открыть разворот');
}

async function v333HistoryItemHtml(h, idx) {
  const at = v321EventTime(h);
  let notebookTitle = '';
  let spread = null;
  try {
    spread = await v333ResolveHistorySpread(h);
    let nb = h.notebook_id ? await get('notebooks', h.notebook_id) : null;
    if (!nb && spread) nb = await get('notebooks', spread.notebook_id);
    notebookTitle = nb && nb.title ? nb.title : '';
  } catch (_) {}
  const who = h.display_name || h.user_name || h.user_id || 'Пользователь';
  const action = v3ActionLabel(h.action);
  const spreadLabel = spread ? `Разворот №${esc(String(spread.number || '—'))}` : '';
  return `<div class="v333-history-row" data-history-index="${idx}" style="padding:10px 0;border-bottom:1px solid var(--line)"><b>${esc(action)}</b>${notebookTitle ? `<div>${esc(notebookTitle)}</div>` : ''}${spreadLabel ? `<div style="margin-top:2px">${spreadLabel}</div>` : ''}<small>${esc(String(who))}${at ? ' · ' + new Date(at).toLocaleString('ru-RU') : ''}</small>${spread ? `<button class="btn-secondary v333-open-spread" data-history-index="${idx}" style="width:100%;margin-top:8px">Открыть разворот →</button>` : ''}</div>`;
}

v321OpenGlobalHistory = async function() {
  const rows = (await v321HistoryRows()).slice(0, 100);
  const latest = rows.length ? Math.max(...rows.map(v321EventTime)) : Date.now();
  localStorage.setItem(V321_HISTORY_SEEN_KEY, String(Math.max(Date.now(), latest)));
  const items = [];
  for (let i = 0; i < rows.length; i++) items.push(await v333HistoryItemHtml(rows[i], i));
  const {close} = openSheet(`<div class="sheet-handle"></div><div style="display:flex;align-items:center;justify-content:space-between;gap:8px"><h2 style="margin:0">🕘 История</h2><button id="v321ClearHistory" class="btn-secondary">Очистить у меня</button></div><p style="color:var(--muted)">Последние изменения во всех блокнотах. Нажмите «Открыть разворот», чтобы перейти к месту изменения.</p>${items.length ? items.join('') : '<p>Новых записей нет.</p>'}`);

  const clear = document.getElementById('v321ClearHistory');
  if (clear) clear.onclick = () => {
    localStorage.setItem(V321_HISTORY_HIDDEN_KEY, String(Date.now()));
    localStorage.setItem(V321_HISTORY_SEEN_KEY, String(Date.now()));
    close(); toast('История очищена только на этом устройстве');
    if (typeof render === 'function') render();
  };

  document.querySelectorAll('.v333-open-spread').forEach(btn => {
    btn.onclick = () => {
      const idx = Number(btn.dataset.historyIndex);
      const h = rows[idx];
      if (h) v333OpenHistorySpread(h, close);
    };
  });

  if (typeof v321DecorateGlobalHistoryButton === 'function') v321DecorateGlobalHistoryButton();
};
