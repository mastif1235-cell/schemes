/* Blocknot Scan v3.1.1: notebook actions only. */
const openNotebookEditorV2 = openNotebookEditor;

function openNotebookActions(nb) {
  const body = `
    <div class="sheet-handle"></div>
    <h2>${esc(nb.title)}</h2>
    <div class="btn-row" style="display:grid;gap:10px;">
      <button class="btn-secondary" id="nbActionEdit">Редактировать блокнот</button>
      <button class="btn-secondary" id="nbActionPartner">Добавить напарника</button>
      <button class="btn-secondary" id="nbActionCover">📷 Обложка</button>
      <button class="btn-secondary" id="nbActionHistory">🕘 История</button>
    </div>`;
  const {close} = openSheet(body);
  document.getElementById('nbActionEdit').onclick = () => { close(); openNotebookEditorV2(nb); };
  document.getElementById('nbActionPartner').onclick = () => { close(); openNotebookPartner(nb); };
  document.getElementById('nbActionCover').onclick = () => { close(); openNotebookCover(nb); };
  document.getElementById('nbActionHistory').onclick = () => { close(); openNotebookHistory(nb); };
}

openNotebookEditor = function(nb) {
  if (!nb) return openNotebookEditorV2(nb);
  return openNotebookActions(nb);
};

async function openNotebookPartner(nb) {
  if (!isAuthed() || !nb.server_id) {
    toast('Сначала дождитесь синхронизации блокнота');
    return;
  }
  try {
    const invite = await api('/api/invites', {
      method: 'POST', body: JSON.stringify({notebook_id: nb.server_id, role: 'MEMBER', expires_in_days: 7})
    });
    const text = `Код приглашения: ${invite.code}`;
    if (navigator.share) await navigator.share({title: nb.title, text});
    else if (navigator.clipboard) { await navigator.clipboard.writeText(invite.code); toast('Код приглашения скопирован'); }
    else prompt('Код приглашения', invite.code);
  } catch (e) { toast('Не удалось создать приглашение: ' + (e.message || e)); }
}

async function openNotebookCover(nb) {
  const spreads = (await getAllByIndex('spreads', 'notebook_id', nb.id)).filter(s => !s.deleted_at);
  const photos = (await Promise.all(spreads.map(s => s.current_photo_id ? get('photos', s.current_photo_id) : null))).filter(Boolean);
  if (!photos.length) { toast('Сначала добавьте фото в разворот'); return; }
  const body = `<div class="sheet-handle"></div><h2>📷 Обложка</h2><div id="nbCoverGrid" class="photo-grid"></div>`;
  const {close} = openSheet(body);
  const grid = document.getElementById('nbCoverGrid');
  for (const photo of photos) {
    const rec = await get('blobs', photo.id + '_thumb');
    const button = document.createElement('button');
    button.className = 'btn-secondary';
    button.style.cssText = 'min-height:90px;background-size:cover;background-position:center;';
    button.textContent = rec ? '' : 'Фото';
    if (rec) button.style.backgroundImage = `url(${URL.createObjectURL(rec.blob)})`;
    button.onclick = async () => {
      nb.cover_photo_id = photo.id; nb.updated_at = nowISO(); await put('notebooks', nb);
      if (isAuthed()) queueEntityChange('notebook', nb.id);
      close(); toast('Обложка сохранена'); render();
    };
    grid.appendChild(button);
  }
}

async function openNotebookHistory(nb) {
  const spreadIds = new Set((await getAllByIndex('spreads', 'notebook_id', nb.id)).map(s => s.id));
  const rows = (await getAll('history')).filter(h => spreadIds.has(h.spread_id)).sort((a,b) => String(b.timestamp).localeCompare(String(a.timestamp)));
  const items = rows.length ? rows.slice(0, 100).map(h => `<div style="padding:10px 0;border-bottom:1px solid var(--line)"><b>${esc(h.action)}</b><br><small>${new Date(h.timestamp).toLocaleString('ru-RU')}</small></div>`).join('') : '<p>История пока пуста.</p>';
  openSheet(`<div class="sheet-handle"></div><h2>🕘 История</h2>${items}`);
}

const renderNotebooksV2 = renderNotebooks;
renderNotebooks = async function() {
  await renderNotebooksV2();
  const notebooks = (await getAll('notebooks')).filter(n => !n.deleted_at && !n.hidden_no_access).sort((a,b) => (a.sort_order-b.sort_order)||0);
  const cards = screenEl.querySelectorAll('.notebook-card');
  for (let i=0; i<cards.length; i++) {
    const photoId = notebooks[i] && notebooks[i].cover_photo_id;
    if (!photoId) continue;
    const rec = await get('blobs', photoId + '_thumb');
    if (rec) {
      cards[i].style.backgroundImage = `linear-gradient(90deg,rgba(246,241,228,.92),rgba(246,241,228,.72)),url(${URL.createObjectURL(rec.blob)})`;
      cards[i].style.backgroundSize = 'cover'; cards[i].style.backgroundPosition = 'center';
    }
  }
};
