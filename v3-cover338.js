/* Blocknot Scan v3.3.9: bind notebook covers to immutable notebook id only + reliable delete. */

function v338CoverBlobId(notebookId) {
  return `notebook_cover_${String(notebookId)}`;
}
function v338CoverRemovedKey(notebookId) {
  return `blocknot_cover_removed_${String(notebookId)}`;
}
function v338IsCoverRemoved(notebookId) {
  try { return localStorage.getItem(v338CoverRemovedKey(notebookId)) === '1'; } catch (_) { return false; }
}
function v338SetCoverRemoved(notebookId, removed) {
  try {
    if (removed) localStorage.setItem(v338CoverRemovedKey(notebookId), '1');
    else localStorage.removeItem(v338CoverRemovedKey(notebookId));
  } catch (_) {}
}

async function v338NotebookById(id) {
  return id ? await get('notebooks', id) : null;
}

async function v338SaveCoverBlobForId(notebookId, blob) {
  if (!notebookId || !blob) throw new Error('Нет блокнота или изображения');
  await put('blobs', {id: v338CoverBlobId(notebookId), blob});
  v338SetCoverRemoved(notebookId, false);
}

saveExternalCover = async function(nb, file) {
  const notebookId = nb && nb.id;
  if (!notebookId || !file) return;
  try {
    const blob = await cropCoverBlob(file);
    await v338SaveCoverBlobForId(notebookId, blob);
    toast('Обложка сохранена');
    render();
  } catch (e) {
    toast('Не удалось сохранить обложку: ' + (e.message || e));
  }
};

chooseCoverFromSpreads = async function(nb, parentClose) {
  const notebookId = nb && nb.id;
  if (!notebookId) return;
  const spreads = (await getAllByIndex('spreads','notebook_id',notebookId)).filter(s => !s.deleted_at);
  const photos = (await Promise.all(spreads.map(s => s.current_photo_id ? get('photos', s.current_photo_id) : null))).filter(Boolean);
  if (!photos.length) { toast('В разворотах пока нет фото'); return; }
  if (parentClose) parentClose();
  const {close} = openSheet('<div class="sheet-handle"></div><h2>Фото из разворотов</h2><div id="nbCoverGrid" class="photo-grid"></div>');
  const grid = document.getElementById('nbCoverGrid');
  for (const photo of photos) {
    const rec = await get('blobs', photo.id + '_thumb');
    const button = document.createElement('button');
    button.className = 'btn-secondary';
    button.style.cssText = 'min-height:100px;background-size:cover;background-position:center;';
    button.textContent = rec ? '' : 'Фото';
    if (rec && rec.blob) button.style.backgroundImage = `url(${URL.createObjectURL(rec.blob)})`;
    button.onclick = async () => {
      try {
        const thumb = await get('blobs', photo.id + '_thumb');
        if (!thumb || !thumb.blob) throw new Error('Миниатюра недоступна');
        await v338SaveCoverBlobForId(notebookId, thumb.blob);
        close();
        toast('Обложка сохранена');
        render();
      } catch (e) {
        toast('Не удалось сохранить обложку: ' + (e.message || e));
      }
    };
    grid.appendChild(button);
  }
};

openNotebookCover = async function(nb) {
  const notebookId = nb && nb.id;
  if (!notebookId) { toast('Не удалось определить блокнот'); return; }
  const fresh = await v338NotebookById(notebookId) || nb;
  const localCover = await get('blobs', v338CoverBlobId(notebookId));
  const legacyCover = !v338IsCoverRemoved(notebookId) && !!(fresh.cover_photo_id || fresh.cover_blob_id);
  const hasCover = !!localCover || legacyCover;
  const {close} = openSheet(`<div class="sheet-handle"></div><h2>📷 Обложка блокнота</h2><p style="margin-top:0;color:var(--muted)">Обложка будет сохранена именно для этого блокнота.</p><div style="display:grid;gap:10px"><button class="btn-primary" id="coverCamera">📸 Сфотографировать блокнот</button><button class="btn-secondary" id="coverGallery">🖼 Выбрать из галереи</button><button class="btn-secondary" id="coverSpreads">📄 Выбрать из фото разворотов</button>${hasCover ? '<button class="btn-secondary" id="coverRemove">🗑 Удалить обложку</button>' : ''}</div>`);
  document.getElementById('coverCamera').onclick = async () => {
    const f = await pickImageFile(true);
    if (f) { close(); await saveExternalCover({id:notebookId}, f); }
  };
  document.getElementById('coverGallery').onclick = async () => {
    const f = await pickImageFile(false);
    if (f) { close(); await saveExternalCover({id:notebookId}, f); }
  };
  document.getElementById('coverSpreads').onclick = async () => {
    const current = await v338NotebookById(notebookId);
    if (!current) { toast('Блокнот не найден'); return; }
    chooseCoverFromSpreads(current, close);
  };
  const rm = document.getElementById('coverRemove');
  if (rm) rm.onclick = async () => {
    rm.disabled = true;
    rm.textContent = 'Удаляю…';
    try {
      try { await del('blobs', v338CoverBlobId(notebookId)); } catch (_) {}
      /* Suppress old cover_photo_id/cover_blob_id fallback without touching server/auth sync. */
      v338SetCoverRemoved(notebookId, true);
      close();
      toast('Обложка удалена');
      render();
    } catch (e) {
      rm.disabled = false;
      rm.textContent = '🗑 Удалить обложку';
      toast('Не удалось удалить обложку: ' + (e.message || e));
    }
  };
};

getNotebookCoverUrl = async function(nb) {
  if (!nb || !nb.id) return null;
  let rec = await get('blobs', v338CoverBlobId(nb.id));
  if (!rec && !v338IsCoverRemoved(nb.id) && nb.cover_photo_id) rec = await get('blobs', nb.cover_photo_id + '_thumb');
  if (!rec && !v338IsCoverRemoved(nb.id) && nb.cover_blob_id) rec = await get('blobs', nb.cover_blob_id);
  return rec && rec.blob ? URL.createObjectURL(rec.blob) : null;
};

function v338CardTitle(card) {
  if (!card) return '';
  const preferred = card.querySelector('h1,h2,h3,h4,.notebook-title,.title,strong,b');
  return preferred ? String(preferred.textContent || '').trim() : String((card.innerText || '').split(/\n+/)[0] || '').trim();
}

async function v338PlaceCoversByIdentity() {
  if (!screenEl) return;
  const cards = [...screenEl.querySelectorAll('.notebook-card')];
  if (!cards.length) return;
  const notebooks = (await getAll('notebooks')).filter(n => !n.deleted_at && !n.hidden_no_access);

  for (const card of cards) {
    const old = card.querySelector('.notebook-cover-mini');
    if (old) {
      try { if (old.src && old.src.startsWith('blob:')) URL.revokeObjectURL(old.src); } catch (_) {}
      old.remove();
    }
    card.style.paddingRight = '';
    delete card.dataset.notebookId;

    const title = v338CardTitle(card);
    const candidates = notebooks.filter(n => String(n.title || '').trim() === title);
    if (candidates.length !== 1) continue;
    const current = candidates[0];
    card.dataset.notebookId = String(current.id);
    const url = await getNotebookCoverUrl(current);
    if (!url) continue;

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

document.addEventListener('pointerdown', async e => {
  const card = e.target && e.target.closest ? e.target.closest('.notebook-card') : null;
  if (!card || !card.dataset.notebookId) return;
  try {
    const current = await get('notebooks', card.dataset.notebookId);
    if (current) {
      localStorage.setItem(V321_LAST_NOTEBOOK_KEY, JSON.stringify({id:current.id,title:current.title || 'Без названия'}));
      localStorage.setItem(V323_SEARCH_NOTEBOOK_KEY, current.id);
    }
  } catch (_) {}
}, true);

const v338RenderNotebooksBase = renderNotebooks;
renderNotebooks = async function() {
  await v338RenderNotebooksBase();
  await v338PlaceCoversByIdentity();
};

let v338CoverScheduled = false;
const v338CoverObserver = new MutationObserver(() => {
  if (v338CoverScheduled) return;
  v338CoverScheduled = true;
  requestAnimationFrame(async () => {
    v338CoverScheduled = false;
    try { await v338PlaceCoversByIdentity(); } catch (_) {}
  });
});
setTimeout(() => {
  if (window.__BLOCKNOT_LEGACY_DISABLED__) return;
  if (document.body) v338CoverObserver.observe(document.body, {childList:true, subtree:true});
  v338PlaceCoversByIdentity().catch(() => {});
}, 180);
