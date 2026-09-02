/* Blocknot Scan v3.1.2: notebook actions + compact cover thumbnails. */
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

function pickImageFile(capture) {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    if (capture) input.setAttribute('capture', 'environment');
    input.style.display = 'none';
    document.body.appendChild(input);
    input.onchange = () => {
      const file = input.files && input.files[0] ? input.files[0] : null;
      input.remove();
      resolve(file);
    };
    input.oncancel = () => { input.remove(); resolve(null); };
    input.click();
  });
}

async function cropCoverBlob(file) {
  const bitmap = await createImageBitmap(file);
  const targetW = 500, targetH = 700;
  const targetRatio = targetW / targetH;
  let sx = 0, sy = 0, sw = bitmap.width, sh = bitmap.height;
  const srcRatio = sw / sh;
  if (srcRatio > targetRatio) {
    sw = Math.round(sh * targetRatio);
    sx = Math.round((bitmap.width - sw) / 2);
  } else {
    sh = Math.round(sw / targetRatio);
    sy = Math.round((bitmap.height - sh) / 2);
  }
  const canvas = document.createElement('canvas');
  canvas.width = targetW; canvas.height = targetH;
  canvas.getContext('2d').drawImage(bitmap, sx, sy, sw, sh, 0, 0, targetW, targetH);
  if (bitmap.close) bitmap.close();
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Не удалось подготовить обложку')), 'image/jpeg', 0.86);
  });
}

async function saveExternalCover(nb, file) {
  if (!file) return;
  try {
    const blob = await cropCoverBlob(file);
    const blobId = `notebook_cover_${nb.id}`;
    await put('blobs', {id: blobId, blob});
    nb.cover_blob_id = blobId;
    delete nb.cover_photo_id;
    nb.updated_at = nowISO();
    await put('notebooks', nb);
    if (isAuthed()) queueEntityChange('notebook', nb.id);
    toast('Обложка сохранена');
    render();
  } catch (e) {
    toast('Не удалось сохранить обложку: ' + (e.message || e));
  }
}

async function chooseCoverFromSpreads(nb, parentClose) {
  const spreads = (await getAllByIndex('spreads', 'notebook_id', nb.id)).filter(s => !s.deleted_at);
  const photos = (await Promise.all(spreads.map(s => s.current_photo_id ? get('photos', s.current_photo_id) : null))).filter(Boolean);
  if (!photos.length) { toast('В разворотах пока нет фото'); return; }
  if (parentClose) parentClose();
  const body = `<div class="sheet-handle"></div><h2>Фото из разворотов</h2><div id="nbCoverGrid" class="photo-grid"></div>`;
  const {close} = openSheet(body);
  const grid = document.getElementById('nbCoverGrid');
  for (const photo of photos) {
    const rec = await get('blobs', photo.id + '_thumb');
    const button = document.createElement('button');
    button.className = 'btn-secondary';
    button.style.cssText = 'min-height:100px;background-size:cover;background-position:center;';
    button.textContent = rec ? '' : 'Фото';
    if (rec) button.style.backgroundImage = `url(${URL.createObjectURL(rec.blob)})`;
    button.onclick = async () => {
      nb.cover_photo_id = photo.id;
      delete nb.cover_blob_id;
      nb.updated_at = nowISO();
      await put('notebooks', nb);
      if (isAuthed()) queueEntityChange('notebook', nb.id);
      close();
      toast('Обложка сохранена');
      render();
    };
    grid.appendChild(button);
  }
}

async function openNotebookCover(nb) {
  const hasCover = !!(nb.cover_blob_id || nb.cover_photo_id);
  const body = `
    <div class="sheet-handle"></div>
    <h2>📷 Обложка блокнота</h2>
    <p style="margin-top:0;color:var(--muted)">Небольшая вертикальная миниатюра будет показана справа на карточке блокнота.</p>
    <div style="display:grid;gap:10px">
      <button class="btn-primary" id="coverCamera">📸 Сфотографировать блокнот</button>
      <button class="btn-secondary" id="coverGallery">🖼 Выбрать из галереи</button>
      <button class="btn-secondary" id="coverSpreads">📄 Выбрать из фото разворотов</button>
      ${hasCover ? '<button class="btn-secondary" id="coverRemove">🗑 Удалить обложку</button>' : ''}
    </div>`;
  const {close} = openSheet(body);

  document.getElementById('coverCamera').onclick = async () => {
    const file = await pickImageFile(true);
    if (!file) return;
    close();
    await saveExternalCover(nb, file);
  };
  document.getElementById('coverGallery').onclick = async () => {
    const file = await pickImageFile(false);
    if (!file) return;
    close();
    await saveExternalCover(nb, file);
  };
  document.getElementById('coverSpreads').onclick = () => chooseCoverFromSpreads(nb, close);

  const removeBtn = document.getElementById('coverRemove');
  if (removeBtn) removeBtn.onclick = async () => {
    if (nb.cover_blob_id) {
      try { await del('blobs', nb.cover_blob_id); } catch (_) {}
    }
    delete nb.cover_blob_id;
    delete nb.cover_photo_id;
    nb.updated_at = nowISO();
    await put('notebooks', nb);
    if (isAuthed()) queueEntityChange('notebook', nb.id);
    close();
    toast('Обложка удалена');
    render();
  };
}

async function openNotebookHistory(nb) {
  const spreadIds = new Set((await getAllByIndex('spreads', 'notebook_id', nb.id)).map(s => s.id));
  const rows = (await getAll('history')).filter(h => spreadIds.has(h.spread_id)).sort((a,b) => String(b.timestamp).localeCompare(String(a.timestamp)));
  const items = rows.length ? rows.slice(0, 100).map(h => `<div style="padding:10px 0;border-bottom:1px solid var(--line)"><b>${esc(h.action)}</b><br><small>${new Date(h.timestamp).toLocaleString('ru-RU')}</small></div>`).join('') : '<p>История пока пуста.</p>';
  openSheet(`<div class="sheet-handle"></div><h2>🕘 История</h2>${items}`);
}

async function getNotebookCoverUrl(nb) {
  let rec = null;
  if (nb.cover_blob_id) rec = await get('blobs', nb.cover_blob_id);
  if (!rec && nb.cover_photo_id) rec = await get('blobs', nb.cover_photo_id + '_thumb');
  return rec && rec.blob ? URL.createObjectURL(rec.blob) : null;
}

const renderNotebooksV2 = renderNotebooks;
renderNotebooks = async function() {
  await renderNotebooksV2();
  const notebooks = (await getAll('notebooks')).filter(n => !n.deleted_at && !n.hidden_no_access).sort((a,b) => (a.sort_order-b.sort_order)||0);
  const cards = screenEl.querySelectorAll('.notebook-card');
  for (let i=0; i<cards.length; i++) {
    const nb = notebooks[i];
    if (!nb) continue;
    const url = await getNotebookCoverUrl(nb);
    if (!url) continue;
    cards[i].style.position = 'relative';
    cards[i].style.paddingRight = '92px';
    cards[i].style.backgroundImage = '';
    const old = cards[i].querySelector('.notebook-cover-mini');
    if (old) old.remove();
    const img = document.createElement('img');
    img.className = 'notebook-cover-mini';
    img.src = url;
    img.alt = 'Обложка блокнота';
    img.style.cssText = 'position:absolute;right:16px;top:50%;transform:translateY(-50%);width:52px;height:72px;object-fit:cover;border-radius:7px;border:1px solid rgba(0,0,0,.18);box-shadow:0 2px 6px rgba(0,0,0,.15);background:#eee;';
    cards[i].appendChild(img);
  }
};
