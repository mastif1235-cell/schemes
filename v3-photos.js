/* Blocknot Scan v3.4.0: photo state, original resolution and leak-free viewer. */
(function () {
  const UNSYNCED_QUEUE = new Set(['pending','syncing','failed','conflict','blocked']);


  // keep_old_photos_policy was a dead setting: old photo versions accumulated blobs forever.
  // Conservative enforcement: runs at most once per day after a successful sync, only when
  // signed in (so pruned originals are recoverable from the server), and only removes the
  // ORIGINAL blob of a fully-synced non-current version beyond the keep limit. Thumbnails,
  // metadata, current photos, pending/retrying uploads and photos of deleted spreads are
  // never touched.
  window.v340PruneOldPhotos = async function (options = {}) {
    const POLICY_KEEP = {none:0, last1:1, last3:3, all:Infinity};
    const keep = POLICY_KEEP[settings.keep_old_photos_policy];
    if (!Number.isFinite(keep)) return {pruned:0};
    if (!isAuthed()) return {pruned:0};
    if (!options.force) {
      const lastRun = Date.parse(settings.last_photo_retention_at || '');
      if (Number.isFinite(lastRun) && Date.now() - lastRun < 24 * 3600 * 1000) return {pruned:0, throttled:true};
    }
    let pruned = 0;
    const queue = await getAll('sync_queue');
    const spreads = await getAll('spreads');
    for (const spread of spreads) {
      if (!spread || spread.deleted_at) continue;
      const versions = (await getAllByIndex('photos', 'spread_id', spread.id))
        .filter(photo => photo && !photo.is_current)
        .sort((a, b) => (Number(b.version) || 0) - (Number(a.version) || 0));
      let kept = 0;
      for (const photo of versions) {
        const busy = queue.some(item => item.entity === 'photo' && item.photo_id === photo.id
          && UNSYNCED_QUEUE.has(item.status));
        if (busy) continue; // still needed for retry — never prune, and don't spend keep-slots on it
        if (!photo.server_id || photo.upload_status !== 'synced') continue;
        if (kept < keep) { kept++; continue; }
        try { await del('blobs', photo.id + '_orig'); pruned++; }
        catch (error) { console.warn('Old photo version blob could not be pruned', photo.id, error); }
      }
    }
    settings.last_photo_retention_at = nowISO();
    try { await saveSettings(); } catch (error) { console.warn('Retention timestamp could not be saved', error); }
    return {pruned};
  };

  function getTelegramPhotoLink(photo) {
    const link = typeof photo?.telegram_link === 'string' ? photo.telegram_link.trim() : '';
    if (!link) return null;
    try {
      const parsed = new URL(link, location.href);
      if (parsed.protocol === 'https:' && parsed.hostname === 't.me') return parsed.href;
    } catch (error) { console.warn('Invalid Telegram photo link', error); }
    return null;
  }
  window.v350GetTelegramPhotoLink = getTelegramPhotoLink;

  async function renderNotes(host, spread, refreshRemote = true) {
    if (!host?.isConnected) return;
    const team = window.vNextSync;
    // Always refresh the server copy when a spread is opened: a note added on another phone must
    // appear here even if this device's sync cursor already passed it.
    if (refreshRemote && spread?.server_id && isAuthed() && isOnline()) {
      try {
        const data = await api(`/api/spreads/${encodeURIComponent(spread.server_id)}/notes`);
        for (const note of (data.notes || [])) await team.cacheNote(note, spread);
        // Refresh the authoritative per-user cursor before marking this spread seen. Otherwise a
        // direct open can fetch a new note while an older local unread map has no entry to clear.
        const unread = await api('/api/activity/unread');
        if (unread?.unread && window.v340ApplyUnread) await window.v340ApplyUnread(unread.unread);
        if (window.v340MarkSpreadSeen) await window.v340MarkSpreadSeen(spread);
      } catch (error) {
        console.warn('Server notes could not be refreshed', error);
      }
      if (!host.isConnected) return;
    }
    if (!team.enabled('team_notes')) {
      host.innerHTML = '<h3>Примечания</h3><p>Общие примечания станут доступны после обновления сервера.</p>';
      return;
    }
    const rows = (await getAll('spread_notes')).filter(row => row.scope === team.scope() && row.spread_id === spread.id && (!row.deleted_at || row.pending))
      // Newest first; seq is authoritative, created_at/id are the fallback.
      .sort((a,b) => (Number(b.seq)||0)-(Number(a.seq)||0)
        || String(b.created_at||'').localeCompare(String(a.created_at||''))
        || String(b.id||'').localeCompare(String(a.id||'')));
    if (!host.isConnected) return;
    host.innerHTML = `<h3>Примечания</h3><p class="vnext-note-caption">Общие для участников блокнота · ${isOnline() ? 'загруженные записи' : 'офлайн-копия'}</p>
      <div class="vnext-note-composer"><button class="btn-secondary" data-note-compose>＋ Добавить примечание</button>
      <div data-note-editor hidden><textarea data-note-input maxlength="10000" placeholder="Новое примечание"></textarea>
      <div class="btn-row"><button class="btn-primary" data-note-add>Сохранить</button><button class="btn-secondary" data-note-cancel>Отмена</button></div></div></div>
      <div data-note-list></div>`;
    const edit = note => {
      const {el,close} = openSheet(`<div class="sheet-handle"></div><h2>${note ? 'Изменить' : 'Добавить'} примечание</h2>
        <div class="field"><label>Ваше примечание</label><textarea data-note-body maxlength="10000">${esc(note?.body || '')}</textarea></div>
        <p data-note-error role="alert"></p><button class="btn-primary" data-note-save>Сохранить</button>`);
      el.querySelector('[data-note-save]').onclick = async event => {
        event.target.disabled = true;
        try { await team.saveNote(spread,el.querySelector('[data-note-body]').value,note); close(); await renderNotes(host,spread); }
        catch (error) { console.warn('Note save failed',error); el.querySelector('[data-note-error]').textContent = error.message; event.target.disabled = false; }
      };
    };
    const composerButton = host.querySelector('[data-note-compose]');
    const editor = host.querySelector('[data-note-editor]');
    composerButton.onclick = () => {
      composerButton.hidden = true; editor.hidden = false;
      host.querySelector('[data-note-input]').focus();
    };
    host.querySelector('[data-note-cancel]').onclick = () => {
      host.querySelector('[data-note-input]').value = '';
      editor.hidden = true; composerButton.hidden = false;
    };
    host.querySelector('[data-note-add]').onclick = async event => {
      const input = host.querySelector('[data-note-input]');
      const body = String(input.value || '').trim();
      if (!body) { toast('Введите примечание'); return; }
      event.target.disabled = true;
      try {
        await team.saveNote(spread, body, null);
        input.value = '';
        await renderNotes(host, spread);
      } catch (error) { console.warn('Note save failed', error); toast(error.message); event.target.disabled = false; }
    };
    for (const note of rows) {
      const conflict = note.pending && note.sync_error ? await team.noteConflict(note) : null;
      const item = document.createElement('article'); item.className = 'vnext-note';
      item.innerHTML = `<strong>${esc(note.author_display_name || (note.author_id === settings.user_id ? 'Вы' : 'Участник'))}</strong>
        <small> · ${esc(new Date(note.updated_at || note.created_at).toLocaleString('ru-RU'))}</small>
        <p>${esc(note.body)}</p>${note.pending ? `<small>${note.sync_error ? '⚠ ' + esc(note.sync_error) : note.deleted_at ? 'Удаление ожидает синхронизации' : '⏳ Ожидает синхронизации'}</small>` : ''}
        ${!note.pending ? '<div class="v342-note-actions"><button data-note-edit>Изменить</button><button data-note-delete>Удалить</button></div>' : ''}
        ${conflict ? '<button data-note-conflict>Сравнить примечания</button>' : ''}`;
      item.querySelector('[data-note-conflict]')?.addEventListener('click',() => {
        const server = conflict.conflicts?.server_note;
        const {el,close} = openSheet(`<div class="sheet-handle"></div><h2>Примечание изменено на другом устройстве</h2>
          <p>На сервере: ${esc(server?.deleted_at ? 'Удалено' : server?.body || 'Версия недоступна')}</p>
          <div class="field"><label>Ваш текст (сохранён локально)</label><textarea data-note-mine maxlength="10000">${esc(note.body)}</textarea></div>
          <p data-note-error role="alert"></p><button data-resolve-server class="btn-secondary">Принять серверную версию</button>
          <button data-resolve-mine class="btn-primary" ${!server || server.deleted_at ? 'disabled' : ''}>${conflict.method === 'DELETE' ? 'Повторить удаление' : 'Сохранить мой текст'}</button>`);
        const resolve = async choice => {
          el.querySelectorAll('button').forEach(button => {button.disabled=true;});
          try {await team.resolveNote(note,choice,el.querySelector('[data-note-mine]').value);close();await renderNotes(host,spread);}
          catch(error){console.warn('Note conflict resolution failed',error);el.querySelector('[data-note-error]').textContent=error.message;
            el.querySelector('[data-resolve-server]').disabled=false;el.querySelector('[data-resolve-mine]').disabled=!server || !!server.deleted_at;}
        };
        el.querySelector('[data-resolve-server]').onclick=()=>resolve('server');
        el.querySelector('[data-resolve-mine]').onclick=()=>resolve('mine');
      });
      item.querySelector('[data-note-edit]')?.addEventListener('click',() => edit(note));
      item.querySelector('[data-note-delete]')?.addEventListener('click',() => confirmAction('Удалить это примечание?',async () => {
        try { await team.saveNote(spread,'',note,true); await renderNotes(host,spread); }
        catch (error) { console.warn('Note delete failed',error); toast(error.message); }
      }));
      host.querySelector('[data-note-list]').appendChild(item);
    }
  }

  function photoQueueItem(photo, queue) {
    return (queue || []).find(item => item.entity === 'photo' && item.photo_id === photo.id);
  }

  window.v340GetPhotoSyncState = function (photo, queue) {
    const item = photoQueueItem(photo, queue);
    const queueStatus = item && item.status;
    const uploadStatus = photo && photo.upload_status;
    const hasRemoteCopy = !!(photo && (photo.telegram_file_id || photo.storage_object_id || photo.server_id));
    if (queueStatus === 'failed' || queueStatus === 'conflict' || uploadStatus === 'upload_failed') {
      return {state:'error', label:'⚠ ошибка'};
    }
    if (queueStatus === 'syncing' || uploadStatus === 'uploading') return {state:'syncing', label:'↻ синхронизация'};
    if (queueStatus === 'pending' || queueStatus === 'deferred' || uploadStatus === 'local_pending') {
      return {state:'pending', label:'⏳ ожидает'};
    }
    if (queueStatus === 'done') {
      return (uploadStatus === 'synced' || hasRemoteCopy)
        ? {state:'synced', label:'☁ синхронизировано'}
        : {state:'error', label:'⚠ неизвестный статус'};
    }
    if (queueStatus) return {state:'error', label:'⚠ неизвестный статус'};
    if (uploadStatus === 'synced' || hasRemoteCopy) return {state:'synced', label:'☁ синхронизировано'};
    if (!uploadStatus || uploadStatus === 'local') return {state:'local', label:'📱 локально'};
    return {state:'error', label:'⚠ неизвестный статус'};
  };

  async function localOriginal(photo) {
    const record = await get('blobs', photo.id + '_orig');
    return record && record.blob ? record.blob : null;
  }

  async function localThumbnail(photo) {
    const record = await get('blobs', photo.id + '_thumb');
    return record && record.blob ? record.blob : null;
  }

  window.v340ResolvePhotoBlob = async function (photo, allowThumbnail) {
    if (!photo) return {blob:null, fallback:false};
    const original = await localOriginal(photo);
    if (original) return {blob:original, fallback:false, source:'local-original'};
    if (isAuthed() && (photo.server_id || photo.telegram_file_id || photo.storage_object_id)) {
      try {
        const id = photo.server_id || photo.remote_id || photo.photo_id || photo.id;
        const blob = await apiBlob(`/api/photos/${encodeURIComponent(id)}/file`);
        if (blob instanceof Blob) return {blob, fallback:false, source:'remote-original'};
      } catch (error) {
        console.warn('Original photo download failed', photo.id, error);
      }
    }
    const thumbnail = allowThumbnail ? await localThumbnail(photo) : null;
    return {blob:thumbnail, fallback:!!thumbnail, source:thumbnail ? 'thumbnail' : null};
  };

  async function photoDimensions(blob) {
    if (typeof ImageDecoder === 'undefined' || !blob.type || typeof blob.stream !== 'function') return null;
    let decoder = null;
    try {
      if (!await ImageDecoder.isTypeSupported(blob.type)) return null;
      decoder = new ImageDecoder({data:blob.stream(), type:blob.type});
      await decoder.tracks.ready;
      const track = decoder.tracks.selectedTrack;
      return track ? {width:track.displayWidth || track.codedWidth, height:track.displayHeight || track.codedHeight} : null;
    } catch (error) {
      console.warn('Image metadata could not be decoded; using bitmap dimensions', error);
      return null;
    } finally {
      if (decoder) decoder.close();
    }
  }

  window.v341RotatePhotoBlob = async function (blob, degrees) {
    const dimensions = await photoDimensions(blob);
    const maxSide = 3200;
    const options = {imageOrientation:'from-image'};
    if (dimensions && Math.max(dimensions.width, dimensions.height) > maxSide) {
      const factor = maxSide / Math.max(dimensions.width, dimensions.height);
      options.resizeWidth = Math.max(1, Math.round(dimensions.width * factor));
      options.resizeHeight = Math.max(1, Math.round(dimensions.height * factor));
      options.resizeQuality = 'high';
    }
    const bitmap = await createImageBitmap(blob, options);
    const canvas = document.createElement('canvas');
    try {
      const quarterTurn = Math.abs(degrees) % 180 === 90;
      canvas.width = quarterTurn ? bitmap.height : bitmap.width;
      canvas.height = quarterTurn ? bitmap.width : bitmap.height;
      const context = canvas.getContext('2d', {alpha:false});
      context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
      context.translate(canvas.width / 2, canvas.height / 2);
      context.rotate(degrees * Math.PI / 180);
      context.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2);
      const type = blob.type === 'image/png' ? 'image/png' : 'image/jpeg';
      return await new Promise((resolve, reject) => canvas.toBlob(
        value => value ? resolve(value) : reject(new Error('rotate failed')), type, type === 'image/jpeg' ? .92 : undefined
      ));
    } finally {
      canvas.width = canvas.height = 0;
      if (bitmap.close) bitmap.close();
    }
  };

  v3LocalPhotoBlob = async photo => (await v340ResolvePhotoBlob(photo, true)).blob;
  v3FetchOriginalBlob = async photo => (await v340ResolvePhotoBlob(photo, true)).blob;

  v3OpenViewer = async function (photo) {
    const spread = photo && photo.spread_id ? await get('spreads', photo.spread_id) : null;
    if (spread) return window.v340OpenSpread(spread);
  };

  async function openPhotoFullscreen(spreads, initialIndex) {
    let index = initialIndex, objectUrl = null, closed = false, tapTimer = null, hideTimer = null;
    const overlay = document.createElement('div');
    overlay.className = 'viewer v342-photo-fullscreen controls-visible';
    document.body.appendChild(overlay);
    const result = new Promise(resolve => { overlay.__resolveIndex = resolve; });
    const revoke = () => { if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; } };
    const showControlsBriefly = () => {
      overlay.classList.add('controls-visible');
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => overlay.classList.remove('controls-visible'), 1800);
    };
    const close = () => {
      if (closed) return;
      closed = true; clearTimeout(tapTimer); clearTimeout(hideTimer); revoke(); overlay.remove(); overlay.__resolveIndex(index);
    };
    async function draw() {
      revoke();
      const spread = spreads[index];
      const photo = spread.current_photo_id ? await get('photos', spread.current_photo_id) : null;
      const resolved = photo ? await window.v340ResolvePhotoBlob(photo, true) : {blob:null};
      if (closed) return;
      if (resolved.blob) objectUrl = URL.createObjectURL(resolved.blob);
      overlay.innerHTML = `<div class="viewer-top"><button class="icon-btn" data-full-close aria-label="Закрыть">✕</button>
        <span class="num">№${esc(spread.number)} · ${index + 1}/${spreads.length}</span></div>
        <div class="viewer-stage" data-full-stage>${objectUrl ? `<img data-full-image src="${objectUrl}" alt="Разворот ${esc(spread.number)}">` : '<div style="color:#aaa">Фото недоступно</div>'}</div>`;
      const stage = overlay.querySelector('[data-full-stage]');
      const image = overlay.querySelector('[data-full-image]');
      const gesture = {scale:1,x:0,y:0,pointers:new Map(),startScale:1,startDistance:0,startX:0,startY:0,lastTap:0};
      const apply = () => {
        if (!image) return;
        if (gesture.scale <= 1) { gesture.scale=1; gesture.x=0; gesture.y=0; }
        image.style.transform=`translate(${gesture.x}px,${gesture.y}px) scale(${gesture.scale})`;
      };
      const scale = value => { gesture.scale=Math.max(1,Math.min(6,value)); apply(); };
      stage?.addEventListener('pointerdown', event => {
        stage.setPointerCapture(event.pointerId); gesture.pointers.set(event.pointerId,{x:event.clientX,y:event.clientY});
        if (gesture.pointers.size === 1) { gesture.startX=event.clientX; gesture.startY=event.clientY; }
        if (gesture.pointers.size === 2) { const p=[...gesture.pointers.values()]; gesture.startDistance=Math.hypot(p[0].x-p[1].x,p[0].y-p[1].y); gesture.startScale=gesture.scale; }
      });
      stage?.addEventListener('pointermove', event => {
        const previous=gesture.pointers.get(event.pointerId); if (!previous) return;
        gesture.pointers.set(event.pointerId,{x:event.clientX,y:event.clientY});
        if (gesture.pointers.size === 2) { const p=[...gesture.pointers.values()]; const distance=Math.hypot(p[0].x-p[1].x,p[0].y-p[1].y); scale(gesture.startScale*distance/(gesture.startDistance||distance)); }
        else if (gesture.scale > 1) { gesture.x += event.clientX-previous.x; gesture.y += event.clientY-previous.y; apply(); }
      });
      stage?.addEventListener('pointerup', event => {
        const dx=event.clientX-gesture.startX, dy=event.clientY-gesture.startY;
        gesture.pointers.delete(event.pointerId);
        if (gesture.scale <= 1.001 && Math.abs(dx)>60 && Math.abs(dx)>Math.abs(dy)) { index=(index+(dx<0?1:-1)+spreads.length)%spreads.length; void draw(); return; }
        if (Math.hypot(dx,dy)<10) {
          const now=Date.now();
          if (now-gesture.lastTap<320) {
            clearTimeout(tapTimer); tapTimer=null; scale(gesture.scale===1?2.5:1);
          } else {
            clearTimeout(tapTimer);
            tapTimer=setTimeout(() => overlay.classList.toggle('controls-visible'),320);
          }
          gesture.lastTap=now;
        }
      });
      stage?.addEventListener('pointercancel', event => gesture.pointers.delete(event.pointerId));
      overlay.querySelector('[data-full-close]').onclick=event=>{event.stopPropagation();close();};
      showControlsBriefly();
    }
    await draw();
    return result;
  }

  attachPhoto = async function (spread, file, explicitTarget) {
    if (!spread || !file) return null;
    const frozen = window.BlocknotV3.photoTarget && window.BlocknotV3.photoTarget.current();
    const target = explicitTarget
      || (frozen && frozen.notebookId ? frozen : null)
      || {notebookId:spread.notebook_id, spreadId:spread.id};
    const guard = window.v340ValidatePhotoTarget(spread, target);
    if (guard) throw new Error(guard);
    const thumbBlob = await makeThumbnail(file), photoId = uid(), createdAt = nowISO();
    // Read the latest spread inside the write transaction, never a stale viewer/form copy.
    const saved = await new Promise((resolve,reject) => {
      const transaction = db.transaction(['spreads','photos','blobs','sync_queue'],'readwrite');
      let latest;
      transaction.oncomplete = () => resolve(latest);
      transaction.onabort = () => reject(transaction.error || new Error('Фото не сохранено'));
      const request = transaction.objectStore('spreads').get(spread.id);
      request.onsuccess = () => {
        latest = request.result;
        const invalid = window.v340ValidatePhotoTarget(latest, target);
        if (invalid) { transaction.abort(); reject(new Error(invalid)); return; }
        const photos = transaction.objectStore('photos');
        const previous = photos.index('spread_id').getAll(spread.id);
        previous.onsuccess = () => {
          const version = Math.max(0,...previous.result.map(row => Number(row.version) || 0)) + 1;
          for (const row of previous.result) if (row.is_current) photos.put({...row,is_current:false});
          photos.put({id:photoId,spread_id:spread.id,version,is_current:true,provider:'telegram',
            mime_type:file.type,file_size:file.size,upload_status:'local_pending',created_at:createdAt,
            storage_object_id:null,telegram_message_id:null,telegram_file_id:null,telegram_file_unique_id:null,
            ocr_text:null,ocr_status:'none',ocr_updated_at:null});
          transaction.objectStore('blobs').put({id:photoId+'_orig',blob:file});
          transaction.objectStore('blobs').put({id:photoId+'_thumb',blob:thumbBlob});
          latest.current_photo_id = photoId; latest.photo_updated_at = createdAt;
          transaction.objectStore('spreads').put(latest);
          transaction.objectStore('sync_queue').put({entity:'photo',photo_id:photoId,status:'pending',retry_count:0,last_attempt_at:null});
        };
      };
    });
    Object.assign(spread,saved);
    if (window.BlocknotV3.photoTarget) window.BlocknotV3.photoTarget.clear();
    await logHistory(spread.id,'Фото добавлено/заменено');
    // The upload route itself advances current_photo_id. No stale metadata PATCH is needed.
    void fullSync();
    return saved;
  };

  openViewer = async function (spreads, initialIndex) {
    if (!Array.isArray(spreads) || !spreads.length) return;
    let index = Math.max(0, Math.min(spreads.length - 1, initialIndex || 0));
    let currentUrl = null;
    let closed = false;
    const stopSyncUpdates = window.BlocknotV3.on('sync-complete', () => {
      renderNotes(overlay.querySelector('[data-team-notes]'),spreads[index],false).catch(error => console.warn('Notes refresh failed',error));
    });
    const historyToken = 'v340-viewer-' + Date.now();
    const overlay = document.createElement('div');
    overlay.className = 'viewer v340-viewer';
    document.body.appendChild(overlay);

    function revokeCurrentUrl() {
      if (!currentUrl) return;
      try { URL.revokeObjectURL(currentUrl); }
      catch (error) { console.warn('Viewer object URL could not be released', error); }
      currentUrl = null;
    }

    function finish() {
      if (closed) return;
      closed = true;
      stopSyncUpdates();
      revokeCurrentUrl();
      window.removeEventListener('popstate', onPopState);
      overlay.remove();
      if (window.__v340ReturnHistory) {
        window.__v340ReturnHistory = false;
        void window.v340OpenGlobalHistory?.();
      }
    }

    function onPopState(event) {
      if (event && event.state && event.state.blocknotViewer === historyToken) return;
      finish();
    }
    try {
      history.pushState({blocknotViewer:historyToken}, '');
      window.addEventListener('popstate', onPopState);
    } catch (error) { console.warn('Viewer history state could not be created', error); }

    function closeViewer() {
      if (history.state && history.state.blocknotViewer === historyToken) history.back();
      else finish();
    }

    async function draw() {
      if (closed) return;
      revokeCurrentUrl();
      const spread = spreads[index];
      v3RememberSpread(spread);
      const photo = spread.current_photo_id ? await get('photos', spread.current_photo_id) : null;
      const queue = await getAll('sync_queue');
      const resolved = photo ? await window.v340ResolvePhotoBlob(photo, true) : {blob:null, fallback:false};
      if (closed) return;
      if (resolved.blob) currentUrl = URL.createObjectURL(resolved.blob);
      const links = await getAllByIndex('spread_tags', 'spread_id', spread.id);
      const tags = (await Promise.all(links.map(link => get('tags', link.tag_id)))).filter(Boolean);
      const photoState = photo ? window.v340GetPhotoSyncState(photo, queue) : null;
      const telegramLink = getTelegramPhotoLink(photo);
      overlay.innerHTML = `<div class="viewer-top">
        <button class="icon-btn" data-action="close" aria-label="Закрыть">✕</button>
        <span class="num">№${esc(spread.number)} · ${index + 1}/${spreads.length}</span><div class="spacer"></div>
        <button class="icon-btn" data-action="favorite" aria-label="Избранное">${spread.favorite ? '⭐' : '☆'}</button>
        <button class="icon-btn" data-action="edit" aria-label="Редактировать">✎</button></div>
        <div class="viewer-stage" data-stage>
          ${currentUrl ? `<img data-image src="${currentUrl}" alt="Разворот ${esc(spread.number)}">` : '<div style="color:#aaa">Фото недоступно</div>'}
        </div>
        ${spreads.length > 1 ? '<div class="v342-photo-nav"><button data-nav="prev" aria-label="Предыдущее фото">← Предыдущее</button><button data-nav="next" aria-label="Следующее фото">Следующее →</button></div>' : ''}
        <div class="v340-zoom-controls"><button data-action="minus">−</button><button data-action="reset">100%</button><button data-action="plus">+</button><button data-action="rotate-left" aria-label="Повернуть влево на 90 градусов">↺ 90°</button><button data-action="rotate-right" aria-label="Повернуть вправо на 90 градусов">↻ 90°</button><button data-action="download">⬇</button></div>
        ${spread.field_conflicts ? '<div class="warn-box v340-conflict">⚠ Одно поле изменено на двух устройствах <button data-action="edit">Сравнить поля</button></div>' : spread.conflict ? '<div class="warn-box v340-conflict">⚠ Конфликт версий<div class="btn-row"><button class="btn-secondary" data-action="server">Версия сервера</button><button class="btn-primary" data-action="mine">Сохранить мою</button></div></div>' : ''}
        <div class="viewer-bottom"><div class="t">${esc(spread.title || 'Без названия')}</div>
          ${photoState ? `<div class="v340-viewer-state">${photoState.label}${resolved.fallback ? ' · показана миниатюра' : ''}</div>` : ''}
          <div class="tags">${tags.map(tag => `<span>#${esc(tag.name)}</span>`).join('')}</div>
          ${spread.note_short ? `<div class="note" style="font-weight:600">${esc(spread.note_short)}</div>` : ''}
          ${spread.note_full ? `<div class="note">${esc(spread.note_full)}</div>` : ''}
          <section class="vnext-notes" data-team-notes></section>
          <div class="viewer-actions"><button data-action="replace">📷 Заменить</button>
          <button data-action="telegram" ${telegramLink ? '' : 'disabled'}>✈ Telegram</button>
          <button data-action="delete" aria-label="Удалить разворот">🗑</button></div></div>`;
      renderNotes(overlay.querySelector('[data-team-notes]'),spread).catch(error => console.warn('Notes could not be displayed',error));

      const stage = overlay.querySelector('[data-stage]');
      const image = overlay.querySelector('[data-image]');
      const resetButton = overlay.querySelector('[data-action="reset"]');
      const gesture = {scale:1, x:0, y:0, pointers:new Map(), startScale:1, startDistance:0,
        panAnchorX:0, panAnchorY:0, tapStartX:0, tapStartY:0, moved:false, lastTap:0};

      function bounds() {
        if (!image || !stage) return {x:0, y:0};
        const stageBox = stage.getBoundingClientRect();
        const imageBox = image.getBoundingClientRect();
        const baseWidth = imageBox.width / gesture.scale;
        const baseHeight = imageBox.height / gesture.scale;
        return {x:Math.max(0, (baseWidth * gesture.scale - stageBox.width) / 2),
          y:Math.max(0, (baseHeight * gesture.scale - stageBox.height) / 2)};
      }

      function apply() {
        if (!image) return;
        if (gesture.scale <= 1) { gesture.scale = 1; gesture.x = 0; gesture.y = 0; }
        const limit = bounds();
        gesture.x = Math.max(-limit.x, Math.min(limit.x, gesture.x));
        gesture.y = Math.max(-limit.y, Math.min(limit.y, gesture.y));
        image.style.transform = `translate(${gesture.x}px,${gesture.y}px) scale(${gesture.scale})`;
        resetButton.textContent = Math.round(gesture.scale * 100) + '%';
        stage.classList.toggle('v341-zoomed', gesture.scale > 1.001);
      }

      function setScale(value) { gesture.scale = Math.max(1, Math.min(6, value)); apply(); }
      if (stage && image) {
        stage.addEventListener('pointerdown', event => {
          if (event.target.closest('[data-nav]')) return;
          stage.setPointerCapture(event.pointerId);
          gesture.pointers.set(event.pointerId, {x:event.clientX, y:event.clientY});
          gesture.moved = false;
          if (gesture.pointers.size === 1) {
            gesture.panAnchorX = event.clientX - gesture.x;
            gesture.panAnchorY = event.clientY - gesture.y;
            gesture.tapStartX = event.clientX; gesture.tapStartY = event.clientY;
          } else if (gesture.pointers.size === 2) {
            const points = [...gesture.pointers.values()];
            gesture.startDistance = Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
            gesture.startScale = gesture.scale;
          }
        });
        stage.addEventListener('pointermove', event => {
          if (!gesture.pointers.has(event.pointerId)) return;
          if (Math.hypot(event.clientX - gesture.tapStartX, event.clientY - gesture.tapStartY) > 8) gesture.moved = true;
          gesture.pointers.set(event.pointerId, {x:event.clientX, y:event.clientY});
          if (gesture.pointers.size === 2) {
            const points = [...gesture.pointers.values()];
            const distance = Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
            setScale(gesture.startScale * distance / (gesture.startDistance || distance));
          } else if (gesture.scale > 1) {
            gesture.x = event.clientX - gesture.panAnchorX;
            gesture.y = event.clientY - gesture.panAnchorY;
            apply();
          }
        });
        const endPointer = event => {
          const wasSingle = gesture.pointers.size === 1;
          gesture.pointers.delete(event.pointerId);
          if (gesture.pointers.size === 1) {
            const remaining = [...gesture.pointers.values()][0];
            gesture.panAnchorX = remaining.x - gesture.x;
            gesture.panAnchorY = remaining.y - gesture.y;
          }
          if (wasSingle && !gesture.moved) {
            const now = Date.now();
            if (now - gesture.lastTap < 320) setScale(gesture.scale === 1 ? 2.5 : 1);
            gesture.lastTap = now;
          }
        };
        stage.addEventListener('pointerup', endPointer);
        stage.addEventListener('pointercancel', event => gesture.pointers.delete(event.pointerId));

        for (const nav of overlay.querySelectorAll('[data-nav]')) {
          let press = null;
          nav.addEventListener('pointerdown', event => {
            event.stopPropagation();
            press = {id:event.pointerId, x:event.clientX, y:event.clientY, moved:false};
            nav.setPointerCapture(event.pointerId);
          });
          nav.addEventListener('pointermove', event => {
            event.stopPropagation();
            if (press && press.id === event.pointerId && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 10) press.moved = true;
          });
          nav.addEventListener('pointerup', event => {
            event.stopPropagation();
            if (!press || press.id !== event.pointerId) return;
            const activate = !press.moved && gesture.scale <= 1.001;
            press = null;
            if (activate) {
              index = nav.dataset.nav === 'prev' ? (index - 1 + spreads.length) % spreads.length : (index + 1) % spreads.length;
              draw();
            }
          });
          nav.addEventListener('pointercancel', event => { event.stopPropagation(); press = null; });
          nav.addEventListener('click', event => {
            event.preventDefault(); event.stopPropagation();
            if (event.detail === 0 && gesture.scale <= 1.001) {
              index = nav.dataset.nav === 'prev' ? (index - 1 + spreads.length) % spreads.length : (index + 1) % spreads.length;
              draw();
            }
          });
        }
      }

      image?.addEventListener('click', async event => {
        if (gesture.scale > 1.001 || gesture.moved || event.detail > 1) return;
        const scrollTop = overlay.scrollTop;
        const selected = await openPhotoFullscreen(spreads, index);
        if (selected !== index) { index = selected; await draw(); overlay.scrollTop = scrollTop; }
      });

      overlay.onclick = async event => {
        const button = event.target.closest('[data-action]');
        if (!button || button.disabled) return;
        const action = button.dataset.action;
        if (action === 'close') closeViewer();
        else if (action === 'minus') setScale(gesture.scale - .5);
        else if (action === 'plus') setScale(gesture.scale + .5);
        else if (action === 'reset') setScale(1);
        else if (action === 'rotate-left' || action === 'rotate-right') {
          if (!photo) return;
          const original = await window.v340ResolvePhotoBlob(photo, false);
          if (!original.blob) { toast('Оригинал недоступен — поворот не выполнен'); return; }
          const rotateButtons = overlay.querySelectorAll('[data-action="rotate-left"],[data-action="rotate-right"]');
          rotateButtons.forEach(item => { item.disabled = true; });
          try {
            const degrees = action === 'rotate-left' ? -90 : 90;
            const rotated = await window.v341RotatePhotoBlob(original.blob, degrees);
            const extension = rotated.type === 'image/png' ? 'png' : 'jpg';
            const file = new File([rotated], `spread_${spread.number}_rotated.${extension}`, {type:rotated.type, lastModified:Date.now()});
            // attachPhoto creates a new normal photo revision and leaves the previous original intact.
            await attachPhoto(spread, file, {notebookId:spread.notebook_id, spreadId:spread.id});
            toast('Поворот сохранён новой версией фото');
            draw();
          } catch (error) {
            console.error('Photo rotation failed', error);
            rotateButtons.forEach(item => { item.disabled = false; });
            toast('Не удалось повернуть фото');
          }
        }
        else if (action === 'favorite') {
          spread.favorite = !spread.favorite; await put('spreads', spread);
          if (spread.favorite) await put('user_favorites', {spread_id:spread.id}); else await del('user_favorites', spread.id);
          if (isAuthed()) await queueEntityChange('favorite', spread.id, {op:spread.favorite ? 'add' : 'remove'});
          draw();
        } else if (action === 'edit') { finish(); openSpreadForm(spread.notebook_id, spread, null); }
        else if (action === 'replace') {
          if (typeof window.v340CapturePhoto !== 'function') { toast('Камера недоступна'); return; }
          const file = await window.v340CapturePhoto();
          if (file) { await attachPhoto(spread, file, {notebookId:spread.notebook_id, spreadId:spread.id}); draw(); }
        } else if (action === 'download') {
          if (!photo) return;
          const download = await window.v340ResolvePhotoBlob(photo, true);
          if (!download.blob) { toast('Фото недоступно'); return; }
          if (download.fallback) toast('Оригинал недоступен — скачивается миниатюра');
          const url = URL.createObjectURL(download.blob);
          const anchor = document.createElement('a'); anchor.href = url;
          anchor.download = `spread_${spread.number}_${download.fallback ? 'preview' : 'original'}.jpg`;
          try { anchor.click(); }
          finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
        } else if (action === 'telegram') {
          const link = getTelegramPhotoLink(photo);
          if (link) window.open(link, '_blank');
        }
        else if (action === 'delete') {
          confirmAction('Удалить этот разворот? Запись переместится в корзину.', async () => {
            const button = event.target.closest('[data-action="delete"]');
            const label = button ? button.textContent : '';
            if (button) { button.disabled = true; button.textContent = 'Удаляю…'; }
            try {
              const queue = await getAll('sync_queue');
              const photoIds = new Set((await getAll('photos')).filter(row => row.spread_id === spread.id).map(row => row.id));
              // Photos of a deleted spread can no longer be uploaded, so their outbox entries are
              // retired instead of retrying forever. Local blobs are kept (no hard delete).
              const retired = queue.filter(item => UNSYNCED_QUEUE.has(item.status)
                  && ((item.entity === 'spread' && item.local_id === spread.id)
                    || (item.entity === 'photo' && photoIds.has(item.photo_id))))
                .map(item => ({...item, status:'done', last_error:'superseded by local spread delete'}));
              await window.vNextAtomic('spreads', spread.id, current => {
                if (!current) throw new Error('Разворот недоступен');
                const now = nowISO();
                return {row:{...current, deleted_at:current.deleted_at || now, favorite:false, updated_at:now},
                  item:{entity:'spread', local_id:spread.id, status:'pending', retry_count:0, payload:{op:'delete'}},
                  retired};
              });
              try { await del('user_favorites', spread.id); } catch (error) { console.warn('Favorite reference could not be removed', error); }
              finish(); route = {screen:'spreads', notebookId:spread.notebook_id}; render();
              toast('Разворот в корзине. Удаление синхронизируется.');
            } catch (error) {
              console.error('Spread delete failed', error);
              if (button) { button.disabled = false; button.textContent = label; }
              toast('Не удалось удалить: ' + (error.message || error));
            }
          });
        } else if (action === 'server' && spread.conflict) {
          Object.assign(spread, {...spread.conflict, conflict:null});
          await rebuildSearchText(spread); await put('spreads', spread);
          const item = queue.find(row => row.entity === 'spread' && row.local_id === spread.id && row.status === 'conflict');
          if (item) { item.status = 'done'; await put('sync_queue', item); }
          draw();
        } else if (action === 'mine' && spread.conflict) {
          spread.revision = spread.conflict.revision; spread.conflict = null; await put('spreads', spread);
          const item = queue.find(row => row.entity === 'spread' && row.local_id === spread.id && row.status === 'conflict');
          if (item) { item.status = 'pending'; await put('sync_queue', item); }
          fullSync(); draw();
        }
      };
    }

    await draw();
  };

  const extraStyle = document.createElement('style');
  extraStyle.textContent = `.v340-zoom-controls{display:flex;justify-content:center;gap:8px;padding:8px;background:#171717;color:#fff}.v340-zoom-controls button{min-width:52px;background:#ffffff18;color:#fff;border:0}.v340-viewer-state{font-size:.78rem;color:#d6cdb8;margin-top:5px}.v340-conflict{margin:8px 12px}.v340-viewer img,.v342-photo-fullscreen img{will-change:transform;transform-origin:center}.v342-photo-nav{display:grid;grid-template-columns:1fr 1fr;gap:8px;padding:8px;background:#171717}.v342-photo-nav button{min-height:44px;color:#fff;background:#ffffff18;border:1px solid #ffffff38}.v342-photo-fullscreen{position:fixed;inset:0;z-index:130;background:#000;overflow:hidden;padding:0}.v342-photo-fullscreen .viewer-stage{position:absolute;inset:0;display:grid;place-items:center;min-height:0;touch-action:none}.v342-photo-fullscreen .viewer-stage img{display:block;max-width:100%;max-height:100%;width:auto;height:auto;object-fit:contain}.v342-photo-fullscreen .viewer-top{position:absolute;z-index:2;left:0;right:0;top:0;display:flex;align-items:center;gap:12px;padding:calc(10px + env(safe-area-inset-top)) 12px 10px;background:linear-gradient(#000b,transparent);opacity:0;pointer-events:none;transition:opacity .18s ease}.v342-photo-fullscreen.controls-visible .viewer-top{opacity:1;pointer-events:auto}`;
  document.head.appendChild(extraStyle);
  const teamStyle = document.createElement('style');
  teamStyle.textContent = `.sheet-backdrop{z-index:120}.v340-viewer .viewer-top .icon-btn,.v342-photo-fullscreen .viewer-top .icon-btn{color:#fff;background:rgba(255,255,255,.18);border:1px solid #ffffff38;width:44px;height:44px;min-width:44px;min-height:44px;border-radius:50%;padding:0}.v340-viewer .viewer-actions{display:flex;gap:8px}.v340-viewer .viewer-actions button{min-height:44px;flex:1;padding:8px 10px}.vnext-notes{margin-top:12px;border-top:1px solid #ffffff38;padding-top:10px}.vnext-note{padding:10px 0;border-bottom:1px solid #ffffff28}.vnext-note p{white-space:pre-wrap;overflow-wrap:anywhere}.vnext-note-caption,.vnext-note small{font-size:.8rem;opacity:.8}.vnext-notes button{color:inherit;background:#ffffff18;border:1px solid #ffffff38}.vnext-note-composer{display:grid;grid-template-columns:1fr;gap:8px;width:100%}.vnext-note-composer>[data-note-compose]{display:block;width:100%;min-height:44px}.vnext-note-composer [data-note-editor]{display:grid;gap:8px;width:100%}.vnext-note-composer [data-note-editor][hidden]{display:none}.vnext-note-composer textarea{display:block;width:100%;min-height:112px;box-sizing:border-box;resize:vertical}.vnext-note-composer .btn-row{display:grid;grid-template-columns:1fr 1fr;gap:8px}.vnext-note-composer [data-note-add],.vnext-note-composer [data-note-cancel]{display:block;width:100%;min-height:44px}.v342-note-actions{display:flex;gap:6px;justify-content:flex-end}.v342-note-actions button{min-height:36px;padding:6px 10px;font-size:.86rem}`;
  document.head.appendChild(teamStyle);
})();
