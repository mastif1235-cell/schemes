/* Blocknot Scan v3.4.0: consolidated core, notebook actions, recents and local covers. */
(function () {
  const RECENTS_KEY = 'blocknot_v3_recent_spreads';
  const COVER_PREFIX = 'notebook_cover_';
  const COVER_REMOVED_PREFIX = 'blocknot_cover_removed_';
  const LEGACY_COVER_RE = /\s*\[\[BNSCOVER:([A-Za-z0-9+/=]+)\]\]\s*/g;
  const baseOpenDB = openDB;
  let vNextOpenPromise = null;
  // openNotebookEditorV2 only existed in the removed legacy layer; keep the lookup optional.
  const baseOpenNotebookEditor = typeof openNotebookEditorV2 === 'function' ? openNotebookEditorV2 : openNotebookEditor;

  // Cover deletion is stored in IndexedDB, not localStorage: the tombstone must survive a
  // storage wipe of unrelated keys and must not be a single point of truth outside the data model.
  async function isCoverRemoved(notebookId) {
    try { return !!(await get('blobs', COVER_REMOVED_PREFIX + notebookId)); }
    catch (error) { console.warn('Cannot read local cover state', notebookId, error); return false; }
  }

  async function setCoverRemoved(notebookId, removed) {
    try {
      if (removed) await put('blobs', {id:COVER_REMOVED_PREFIX + notebookId, removed_at:nowISO()});
      else await del('blobs', COVER_REMOVED_PREFIX + notebookId);
    } catch (error) { console.warn('Cannot update local cover state', notebookId, error); }
  }

  window.BlocknotV3 = window.BlocknotV3 || {
    listeners:new Map(),
    on(name, fn) {
      if (!this.listeners.has(name)) this.listeners.set(name, new Set());
      this.listeners.get(name).add(fn);
      return () => this.listeners.get(name).delete(fn);
    },
    emit(name, detail) {
      for (const fn of this.listeners.get(name) || []) {
        try { fn(detail); } catch (error) { console.warn('v3 event handler failed', name, error); }
      }
    }
  };

  const photoTargetState = {notebookId:null, spreadId:null, startedAt:0};

  // The photo operation target is frozen when the operation starts. It must survive the file
  // picker, the camera, crop, awaits and sheet open/close, and must never be re-read from the
  // route, the DOM or "last notebook" state after an await.
  function setPhotoTarget(target) {
    photoTargetState.notebookId = target && target.notebookId ? String(target.notebookId) : null;
    photoTargetState.spreadId = target && target.spreadId ? String(target.spreadId) : null;
    photoTargetState.startedAt = Date.now();
    return currentPhotoTarget();
  }

  function currentPhotoTarget() {
    return {notebookId:photoTargetState.notebookId, spreadId:photoTargetState.spreadId, startedAt:photoTargetState.startedAt};
  }

  function clearPhotoTarget() {
    photoTargetState.notebookId = null; photoTargetState.spreadId = null; photoTargetState.startedAt = 0;
  }

  // Pure guard, covered by tests: returns an error message, or null when the write is allowed.
  function validatePhotoTarget(spread, target) {
    if (!target || !target.notebookId) return 'Не определён целевой блокнот — добавьте фото заново';
    if (!spread || spread.deleted_at) return 'Разворот удалён или недоступен — фото не сохранено';
    if (target.spreadId && String(spread.id) !== String(target.spreadId)) return 'Разворот изменился — добавьте фото заново';
    if (String(spread.notebook_id) !== String(target.notebookId)) return 'Фото не сохранено: разворот принадлежит другому блокноту';
    return null;
  }

  window.v340ValidatePhotoTarget = validatePhotoTarget;
  BlocknotV3.photoTarget = {set:setPhotoTarget, current:currentPhotoTarget, clear:clearPhotoTarget};

  // ---- shared notebook cover --------------------------------------------------------------
  const coverSyncEnabled = () => !!(window.vNextSync && window.vNextSync.enabled('notebook_cover'));
  window.v340CoverBlobId = notebookId => COVER_PREFIX + notebookId;
  // Lightweight sync request with a throttle: opening a screen may ask for fresh data, but never
  // builds a polling loop.
  window.v340MaybeSync = function (minIntervalMs = 30000) {
    if (!isAuthed() || !isOnline()) return;
    const last = Number(window.__v340LastSyncRequest || 0);
    if (Date.now() - last < minIntervalMs) return;
    window.__v340LastSyncRequest = Date.now();
    void fullSync();
  };

  async function queueCoverChange(notebook, op) {
    if (!notebook || !notebook.id) return;
    if (!isAuthed() || !notebook.server_id || !coverSyncEnabled()) return;
    try {
      await window.vNextAtomic('notebooks', notebook.id, current => {
        const base = current || notebook;
        const row = op === 'delete'
          ? {...base, cover_state_known:true, cover_deleted_at:nowISO(), cover_revision:Number(base.cover_revision) || 0}
          : {...base, ...(base.cover_state_known === true ? {cover_deleted_at:null} : {})};
        return {row, item:{
          entity:'notebook_cover', local_id:notebook.id, scope:window.vNextSync.scope(),
          status:'pending', retry_count:0, payload:{op, client_ref:uid()},
        }};
      });
      void fullSync();
    } catch (error) {
      console.warn('Cover change could not be queued for sync', error);
      toast('Обложка сохранена локально; синхронизация повторится позже');
    }
  }

  // Applies authoritative server cover state. A null/absent cover means "unknown", so a legacy
  // local-only cover keeps working until the server sends a real state or a tombstone.
  window.v340ApplyServerCover = async function (notebook, cover) {
    if (!notebook || !notebook.id || !cover || typeof cover !== 'object') return false;
    const blobId = COVER_PREFIX + notebook.id;
    const now = nowISO();
    // Cover endpoints expose `revision`; /api/sync returns the raw row with `cover_revision`.
    const revision = Number(cover.cover_revision ?? cover.revision ?? 0);
    if (cover.deleted_at) {
      await del('blobs', blobId).catch(() => {});
      await setCoverRemoved(notebook.id, true);
      await put('notebooks', {...notebook, server_id:notebook.server_id || cover.notebook_id,
        cover_state_known:true, cover_deleted_at:cover.deleted_at, cover_revision:revision, cover_updated_at:now});
      BlocknotV3.emit('cover-change', notebook.id);
      return true;
    }
    const local = await get('blobs', blobId);
    if (!local || !local.blob || Number(local.cover_revision) !== revision) {
      const blob = await downloadCoverBlob(notebook.server_id || cover.notebook_id);
      if (!blob) {
        await put('notebooks', {...notebook, cover_state_known:true, cover_deleted_at:null,
          cover_revision:revision, cover_updated_at:now});
        BlocknotV3.emit('cover-change', notebook.id);
        return false;
      }
      await put('blobs', {id:blobId, blob, cover_revision:revision, mime_type:blob.type || cover.mime_type || ''});
    }
    await setCoverRemoved(notebook.id, false);
    await put('notebooks', {...notebook, cover_state_known:true, cover_deleted_at:null,
      cover_revision:revision, cover_updated_at:now});
    BlocknotV3.emit('cover-change', notebook.id);
    return true;
  };

  async function downloadCoverBlob(serverNotebookId) {
    if (!serverNotebookId || !isAuthed()) return null;
    try {
      const preview = await apiBlob(`/api/notebooks/${encodeURIComponent(serverNotebookId)}/cover/preview`);
      if (preview instanceof Blob) return preview;
    } catch (error) { console.warn('Cover preview unavailable, trying the original', error); }
    try {
      const full = await apiBlob(`/api/notebooks/${encodeURIComponent(serverNotebookId)}/cover/file`);
      if (full instanceof Blob) return full;
    } catch (error) { console.warn('Cover download failed', error); }
    return null;
  }

  function loadRecents() {
    try {
      const parsed = JSON.parse(localStorage.getItem(RECENTS_KEY) || '[]');
      return Array.isArray(parsed) ? parsed.filter(row => row && typeof row.id === 'string').slice(0, 12) : [];
    } catch (error) {
      console.warn('Recent spreads were reset after invalid local data', error);
      return [];
    }
  }

  function saveRecents(rows) {
    try { localStorage.setItem(RECENTS_KEY, JSON.stringify(rows.slice(0, 12))); }
    catch (error) { console.warn('Recent spreads could not be saved', error); }
  }

  v3LoadRecents = loadRecents;
  v3RememberSpread = function (spread) {
    if (!spread || !spread.id) return;
    const rows = loadRecents().filter(row => row.id !== spread.id);
    rows.unshift({id:spread.id, notebook_id:spread.notebook_id, number:spread.number,
      title:spread.title || '', at:Date.now()});
    saveRecents(rows);
  };

  async function pruneRecents() {
    const valid = [];
    for (const row of loadRecents()) {
      const spread = await get('spreads', row.id);
      if (spread && !spread.deleted_at) valid.push(row);
    }
    saveRecents(valid);
    return valid;
  }
  window.v340PruneRecents = pruneRecents;

  window.v340OpenSpread = async function (spread, options) {
    if (!spread || spread.deleted_at) { toast('Этот разворот больше недоступен'); return false; }
    window.__v340ReturnHistory = !!(options && options.returnToHistory);
    v3RememberSpread(spread);
    if (typeof window.v340MarkSpreadSeen === 'function') { void window.v340MarkSpreadSeen(spread); }
    const siblings = (await getAllByIndex('spreads', 'notebook_id', spread.notebook_id))
      .filter(row => !row.deleted_at)
      .sort((a, b) => Number(a.number) - Number(b.number) || String(a.number).localeCompare(String(b.number)));
    const index = siblings.findIndex(row => row.id === spread.id);
    await openViewer(siblings, index < 0 ? 0 : index);
    return true;
  };

  function inviteError(error) {
    const text = String(error && error.message ? error.message : error || '');
    if (/invite_not_found|404/i.test(text)) return 'Код приглашения не найден';
    if (/invite_already_used|409/i.test(text)) return 'Этот код уже использован';
    if (/invite_expired|410/i.test(text)) return 'Срок действия кода закончился';
    return 'Не удалось принять приглашение: ' + text;
  }

  window.v340OpenRedeemInvite = async function () {
    const {close, el} = openSheet(`<div class="sheet-handle"></div><h2>Присоединиться к блокноту</h2>
      <p class="v340-caption">Введите код, который прислал владелец блокнота.</p>
      <div class="field"><label>Код приглашения</label><input id="v340InviteCode" autocomplete="off" autocapitalize="off" spellcheck="false"></div>
      <button id="v340RedeemInvite" class="btn-primary">Добавить блокнот</button>`);
    const input = el.querySelector('#v340InviteCode');
    const button = el.querySelector('#v340RedeemInvite');
    const submit = async () => {
      const code = input.value.trim();
      if (!code) { toast('Введите код приглашения'); return; }
      button.disabled = true;
      try {
        await api('/api/auth/redeem-invite', {method:'POST', json:{code}});
        close(); toast('Блокнот добавлен');
        await syncMembership();
        await pullChanges();
        route = {screen:'notebooks'};
        render();
      } catch (error) {
        button.disabled = false;
        toast(inviteError(error));
      }
    };
    button.onclick = submit;
    input.addEventListener('keydown', event => { if (event.key === 'Enter') submit(); });
    input.focus();
  };

  function openNotebookActions(notebook) {
    const {close, el} = openSheet(`<div class="sheet-handle"></div><h2>${esc(notebook.title)}</h2>
      <div class="v340-action-list">
        <button class="btn-secondary" data-action="edit">Редактировать блокнот</button>
        <button class="btn-secondary" data-action="cover">📷 Обложка</button>
        <button class="btn-secondary" data-action="partner">Добавить напарника</button>
        <button class="btn-secondary" data-action="history">🕘 История</button>
      </div>`);
    el.querySelector('.v340-action-list').onclick = async event => {
      const button = event.target.closest('button[data-action]');
      if (!button || button.disabled) return;
      button.disabled = true;
      try {
        close();
        if (button.dataset.action === 'edit') baseOpenNotebookEditor(notebook);
        else if (button.dataset.action === 'cover') await openNotebookCover(notebook);
        else if (button.dataset.action === 'partner') {
          if (!isAuthed() || !notebook.server_id) toast('Сначала дождитесь синхронизации блокнота');
          else await openInviteFlow(notebook.server_id);
        } else if (button.dataset.action === 'history') await openNotebookHistory(notebook);
      } catch (error) {
        console.error('Notebook action failed', error);
        toast('Не удалось выполнить действие: ' + (error.message || error));
      } finally {
        button.disabled = false;
      }
    };
  }

  openNotebookActions = openNotebookActions;
  openNotebookEditor = notebook => notebook ? openNotebookActions(notebook) : baseOpenNotebookEditor(null);

  function pickImage(capture) {
    return new Promise(resolve => {
      const input = document.createElement('input');
      input.type = 'file'; input.accept = 'image/*'; input.hidden = true;
      input.dataset.v3InternalPicker = '1';
      if (capture) input.setAttribute('capture', 'environment');
      let settled = false;
      const finish = file => {
        if (settled) return;
        settled = true; input.remove(); resolve(file || null);
      };
      input.onchange = () => finish(input.files && input.files[0]);
      input.oncancel = () => finish(null);
      document.body.appendChild(input);
      input.click();
    });
  }

  async function cropCover(file) {
    const bitmap = await createImageBitmap(file);
    try {
      const width = 500, height = 700, ratio = width / height;
      let sx = 0, sy = 0, sw = bitmap.width, sh = bitmap.height;
      if (sw / sh > ratio) { sw = Math.round(sh * ratio); sx = Math.round((bitmap.width - sw) / 2); }
      else { sh = Math.round(sw / ratio); sy = Math.round((bitmap.height - sh) / 2); }
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      canvas.getContext('2d').drawImage(bitmap, sx, sy, sw, sh, 0, 0, width, height);
      return await new Promise((resolve, reject) => canvas.toBlob(blob =>
        blob ? resolve(blob) : reject(new Error('Не удалось подготовить обложку')), 'image/jpeg', .86));
    } finally {
      if (bitmap.close) bitmap.close();
    }
  }

  saveExternalCover = async function (notebook, file) {
    if (!notebook || !file) return;
    const blob = await cropCover(file);
    await put('blobs', {id:COVER_PREFIX + notebook.id, blob});
    await setCoverRemoved(notebook.id, false);
    await queueCoverChange(notebook, 'put');
    toast(coverSyncEnabled() && notebook.server_id ? 'Обложка сохранена и отправляется участникам' : 'Обложка сохранена на этом устройстве');
    BlocknotV3.emit('cover-change', notebook.id);
    render();
  };

  chooseCoverFromSpreads = async function (notebook, parentClose) {
    const spreads = (await getAllByIndex('spreads', 'notebook_id', notebook.id)).filter(row => !row.deleted_at);
    const choices = [];
    for (const spread of spreads) {
      if (!spread.current_photo_id) continue;
      const record = await get('blobs', spread.current_photo_id + '_thumb');
      if (record && record.blob) choices.push({spread, blob:record.blob});
    }
    if (!choices.length) { toast('В разворотах пока нет локальных фото'); return; }
    if (parentClose) parentClose();
    const {close, el} = openSheet(`<div class="sheet-handle"></div><h2>Фото из разворотов</h2><div class="v340-cover-grid"></div>`);
    for (const choice of choices) {
      const button = document.createElement('button');
      button.className = 'v340-cover-choice';
      button.setAttribute('aria-label', `Разворот ${choice.spread.number}`);
      const image = document.createElement('img');
      const url = URL.createObjectURL(choice.blob);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        try { URL.revokeObjectURL(url); }
        catch (error) { console.warn('Cover preview URL could not be released', error); }
      };
      image.addEventListener('load', release, {once:true});
      image.addEventListener('error', release, {once:true});
      image.src = url; image.alt = '';
      button.appendChild(image);
      setTimeout(release, 30000);
      button.onclick = async () => {
        await put('blobs', {id:COVER_PREFIX + notebook.id, blob:choice.blob});
        await setCoverRemoved(notebook.id, false);
        await queueCoverChange(notebook, 'put');
        release(); close(); render();
        toast(coverSyncEnabled() && notebook.server_id ? 'Обложка сохранена и отправляется участникам' : 'Обложка сохранена на этом устройстве');
      };
      el.querySelector('.v340-cover-grid').appendChild(button);
    }
  };

  openNotebookCover = async function (notebook) {
    const hasCover = !!(await get('blobs', COVER_PREFIX + notebook.id));
    const {close, el} = openSheet(`<div class="sheet-handle"></div><h2>📷 Обложка</h2>
      <p class="v340-caption">Обложка хранится только на этом устройстве и не входит в синхронизацию.</p>
      <div class="v340-action-list">
        <button class="btn-primary" data-action="camera">Сфотографировать</button>
        <button class="btn-secondary" data-action="gallery">Выбрать из галереи</button>
        <button class="btn-secondary" data-action="spreads">Выбрать из разворотов</button>
        ${hasCover ? '<button class="btn-danger" data-action="remove">Удалить обложку</button>' : ''}
      </div>`);
    el.querySelector('.v340-action-list').onclick = async event => {
      const button = event.target.closest('button[data-action]');
      if (!button) return;
      if (button.dataset.action === 'camera' || button.dataset.action === 'gallery') {
        const file = await pickImage(button.dataset.action === 'camera');
        if (file) { close(); await saveExternalCover(notebook, file); }
      } else if (button.dataset.action === 'spreads') {
        await chooseCoverFromSpreads(notebook, close);
      } else if (button.dataset.action === 'remove') {
        await del('blobs', COVER_PREFIX + notebook.id);
        await setCoverRemoved(notebook.id, true);
        const fresh = await get('notebooks', notebook.id) || notebook;
        await queueCoverChange(fresh, 'delete');
        close(); render();
        toast(coverSyncEnabled() && fresh.server_id ? 'Обложка удалена у всех участников' : 'Обложка удалена с этого устройства');
      }
    };
  };

  getNotebookCoverUrl = async function (notebook) {
    if (!notebook) return null;
    // Server state wins once it is known. Before that, a local-only (legacy) cover stays visible
    // unless this device removed it, so an offline delete never resurrects the old picture.
    const serverStateKnown = notebook.cover_state_known === true;
    if (serverStateKnown && notebook.cover_deleted_at) return null;
    if (!serverStateKnown && await isCoverRemoved(notebook.id)) return null;
    const local = await get('blobs', COVER_PREFIX + notebook.id);
    if (local && local.blob) return URL.createObjectURL(local.blob);
    // No legacy cover_photo_id fallback: a deleted cover must never come back from another field.
    return null;
  };

  async function migrateLegacyCoverMarkers() {
    const notebooks = await getAll('notebooks');
    for (const notebook of notebooks) {
      try {
        if (localStorage.getItem(COVER_REMOVED_PREFIX + notebook.id) === '1') {
          await setCoverRemoved(notebook.id, true);
          localStorage.removeItem(COVER_REMOVED_PREFIX + notebook.id);
        }
      } catch (error) { console.warn('Legacy cover tombstone could not be migrated', notebook.id, error); }
      const hasLocalCover = !!(await get('blobs', COVER_PREFIX + notebook.id));
      if (!hasLocalCover && !(await isCoverRemoved(notebook.id)) && notebook.cover_photo_id) {
        const thumbnail = await get('blobs', notebook.cover_photo_id + '_thumb');
        if (thumbnail && thumbnail.blob) {
          await put('blobs', {id:COVER_PREFIX + notebook.id, blob:thumbnail.blob, migrated_from:notebook.cover_photo_id});
        }
      }
      const before = String(notebook.description || '');
      const after = before.replace(LEGACY_COVER_RE, '').replace(/\n{3,}/g, '\n\n').trim();
      if (before === after) continue;
      notebook.description = after; notebook.updated_at = nowISO();
      await put('notebooks', notebook);
      if (isAuthed()) await queueEntityChange('notebook', notebook.id);
    }
  }

  // Legacy local-only covers: publish once, OWNER only, never over an existing server cover and
  // never after a server tombstone. Idempotent through cover_migrated_at.
  window.v340MigrateLegacyCovers = async function () {
    if (!coverSyncEnabled() || !isAuthed()) return;
    const notebooks = (await getAll('notebooks')).filter(row => row.server_id && !row.deleted_at && !row.hidden_no_access);
    for (const notebook of notebooks) {
      if (notebook.cover_state_known === true || notebook.cover_migrated_at) continue;
      const local = await get('blobs', COVER_PREFIX + notebook.id);
      if (!local || !local.blob) continue;
      if (await isCoverRemoved(notebook.id)) continue;
      let role = null, serverCover = null;
      try {
        const members = await api(`/api/notebooks/${encodeURIComponent(notebook.server_id)}/members`);
        role = (members.members || []).find(row => row.user_id === settings.user_id)?.role || null;
        if (role !== 'OWNER') {
          await put('notebooks', {...notebook, cover_migrated_at:nowISO(), cover_migration:'member-skip'});
          continue;
        }
        const state = await api(`/api/notebooks/${encodeURIComponent(notebook.server_id)}/cover`);
        serverCover = state.cover || null;
      } catch (error) {
        console.warn('Legacy cover migration check failed', error);
        continue;
      }
      const fresh = await get('notebooks', notebook.id) || notebook;
      await put('notebooks', {...fresh, cover_migrated_at:nowISO()});
      if (serverCover) { await window.v340ApplyServerCover(fresh, serverCover); continue; }
      await queueCoverChange(fresh, 'put');
    }
  };

  openDB = async function () {
    if (db && db.version >= 3) return db;
    if (vNextOpenPromise) return vNextOpenPromise;
    vNextOpenPromise = (async () => {
      // Keep every connection in a local variable. Concurrent callers previously
      // reassigned the shared `db`, then closed another caller's connection.
      let connection = await new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const closeForUpgrade = () => { connection.close(); };
      connection.onversionchange = closeForUpgrade;
      if (!connection.objectStoreNames.contains('spreads')) {
        connection.close();
        connection = await baseOpenDB();
        connection.onversionchange = () => connection.close();
      }
      if (connection.version < 3) {
        connection.close();
        connection = await new Promise((resolve, reject) => {
          const request = indexedDB.open(DB_NAME, 3);
          request.onupgradeneeded = () => {
            for (const name of ['spread_notes', 'activity_events']) {
              if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name, {keyPath:'cache_id'});
            }
          };
          request.onblocked = () => toast('Другая вкладка держит старую версию базы. Закройте её — данные будут сохранены, обновление продолжится автоматически.');
          request.onerror = () => reject(request.error);
          request.onsuccess = () => resolve(request.result);
        });
      }
      const ready = connection;
      ready.onversionchange = () => {
        ready.close();
        if (db === ready) db = null;
        vNextOpenPromise = null;
      };
      db = ready;
      try { await migrateLegacyCoverMarkers(); await pruneRecents(); }
      catch (error) { console.warn('One-time v3 local cleanup failed', error); }
      BlocknotV3.emit('db-ready');
      return ready;
    })();
    try { return await vNextOpenPromise; }
    catch (error) { vNextOpenPromise = null; throw error; }
  };

  // Local content and its outbox entry commit together, not on request.onsuccess.
  window.vNextAtomic = function (store, key, update) {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([store, 'sync_queue'], 'readwrite');
      let result;
      transaction.oncomplete = () => resolve(result);
      transaction.onabort = () => reject(transaction.error || new Error('Локальное сохранение отменено'));
      transaction.onerror = () => {};
      const request = transaction.objectStore(store).get(key);
      request.onsuccess = () => {
        try {
          result = update(request.result);
          if (result.row) transaction.objectStore(store).put(result.row);
          if (result.item) transaction.objectStore('sync_queue').put(result.item);
          for (const item of result.retired || []) transaction.objectStore('sync_queue').put(item);
        } catch (error) {
          console.warn('Atomic local save failed', store, error);
          transaction.abort();
          reject(error);
        }
      };
    });
  };
})();
