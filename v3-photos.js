/* Blocknot Scan v3.4.0: photo state, original resolution and leak-free viewer. */
(function () {
  async function renderNotes(host, spread) {
    if (!host?.isConnected) return;
    const team = window.vNextSync;
    if (!team.enabled('team_notes')) {
      host.innerHTML = '<h3>Примечания</h3><p>Общие примечания станут доступны после обновления сервера.</p>';
      return;
    }
    const rows = (await getAll('spread_notes')).filter(row => row.scope === team.scope() && row.spread_id === spread.id && (!row.deleted_at || row.pending))
      .sort((a,b) => String(a.created_at).localeCompare(String(b.created_at)));
    if (!host.isConnected) return;
    host.innerHTML = `<h3>Примечания</h3><p class="vnext-note-caption">Общие для участников блокнота · ${isOnline() ? 'загруженные записи' : 'офлайн-копия'}</p>
      <div data-note-list></div><button class="btn-secondary" data-note-add>+ Добавить примечание</button>`;
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
    host.querySelector('[data-note-add]').onclick = () => edit(null);
    for (const note of rows) {
      const conflict = note.pending && note.sync_error ? await team.noteConflict(note) : null;
      const item = document.createElement('article'); item.className = 'vnext-note';
      item.innerHTML = `<strong>${esc(note.author_display_name || (note.author_id === settings.user_id ? 'Вы' : 'Участник'))}</strong>
        <small> · ${esc(new Date(note.updated_at || note.created_at).toLocaleString('ru-RU'))}</small>
        <p>${esc(note.body)}</p>${note.pending ? `<small>${note.sync_error ? '⚠ ' + esc(note.sync_error) : note.deleted_at ? 'Удаление ожидает синхронизации' : '⏳ Ожидает синхронизации'}</small>` : ''}
        ${note.author_id === settings.user_id && !note.pending ? '<div class="btn-row"><button data-note-edit>Изменить</button><button data-note-delete>Удалить</button></div>' : ''}
        ${conflict && note.author_id === settings.user_id ? '<button data-note-conflict>Сравнить примечания</button>' : ''}`;
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
      item.querySelector('[data-note-delete]')?.addEventListener('click',() => confirmAction('Удалить ваше примечание?',async () => {
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

  attachPhoto = async function (spread, file) {
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
        if (!latest || latest.deleted_at) { transaction.abort(); return; }
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
    await logHistory(spread.id,'Фото добавлено/заменено');
    // The upload route itself advances current_photo_id. No stale metadata PATCH is needed.
    void fullSync();
  };

  openViewer = async function (spreads, initialIndex) {
    if (!Array.isArray(spreads) || !spreads.length) return;
    let index = Math.max(0, Math.min(spreads.length - 1, initialIndex || 0));
    let currentUrl = null;
    let closed = false;
    const stopSyncUpdates = window.BlocknotV3.on('sync-complete', () => {
      renderNotes(overlay.querySelector('[data-team-notes]'),spreads[index]).catch(error => console.warn('Notes refresh failed',error));
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
      overlay.innerHTML = `<div class="viewer-top">
        <button class="icon-btn" data-action="close" aria-label="Закрыть">✕</button>
        <span class="num">№${spread.number} · ${index + 1}/${spreads.length}</span><div class="spacer"></div>
        <button class="icon-btn" data-action="favorite" aria-label="Избранное">${spread.favorite ? '⭐' : '☆'}</button>
        <button class="icon-btn" data-action="edit" aria-label="Редактировать">✎</button></div>
        <div class="viewer-stage" data-stage>
          ${currentUrl ? `<img data-image src="${currentUrl}" alt="Разворот ${esc(spread.number)}">` : '<div style="color:#aaa">Фото недоступно</div>'}
          ${spreads.length > 1 ? '<button class="viewer-nav prev v341-nav-zone" data-nav="prev" aria-label="Предыдущее фото">←</button><button class="viewer-nav next v341-nav-zone" data-nav="next" aria-label="Следующее фото">→</button>' : ''}
        </div>
        <div class="v340-zoom-controls"><button data-action="minus">−</button><button data-action="reset">100%</button><button data-action="plus">+</button><button data-action="rotate-left" aria-label="Повернуть влево на 90 градусов">↺ 90°</button><button data-action="rotate-right" aria-label="Повернуть вправо на 90 градусов">↻ 90°</button><button data-action="download">⬇</button></div>
        ${spread.field_conflicts ? '<div class="warn-box v340-conflict">⚠ Одно поле изменено на двух устройствах <button data-action="edit">Сравнить поля</button></div>' : spread.conflict ? '<div class="warn-box v340-conflict">⚠ Конфликт версий<div class="btn-row"><button class="btn-secondary" data-action="server">Версия сервера</button><button class="btn-primary" data-action="mine">Сохранить мою</button></div></div>' : ''}
        <div class="viewer-bottom"><div class="t">${esc(spread.title || 'Без названия')}</div>
          ${photoState ? `<div class="v340-viewer-state">${photoState.label}${resolved.fallback ? ' · показана миниатюра' : ''}</div>` : ''}
          <div class="tags">${tags.map(tag => `<span>#${esc(tag.name)}</span>`).join('')}</div>
          ${spread.note_short ? `<div class="note" style="font-weight:600">${esc(spread.note_short)}</div>` : ''}
          ${spread.note_full ? `<div class="note">${esc(spread.note_full)}</div>` : ''}
          <section class="vnext-notes" data-team-notes></section>
          <div class="viewer-actions"><button data-action="replace">📷 Заменить</button>
          <button data-action="telegram" ${photo && photo.telegram_message_id ? '' : 'disabled'}>✈ Telegram</button>
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

        for (const nav of stage.querySelectorAll('[data-nav]')) {
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
            await attachPhoto(spread, file);
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
          if (file) { await attachPhoto(spread, file); draw(); }
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
        } else if (action === 'telegram' && photo && photo.telegram_link) window.open(photo.telegram_link, '_blank');
        else if (action === 'delete') {
          confirmAction('Удалить этот разворот?', async () => {
            spread.deleted_at = nowISO(); spread.favorite = false;
            await put('spreads', spread); await del('user_favorites', spread.id);
            if (isAuthed() && spread.server_id) api(`/api/spreads/${spread.server_id}`, {method:'DELETE'}).catch(error => console.warn('Remote delete failed', error));
            finish(); route = {screen:'spreads', notebookId:spread.notebook_id}; render();
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
  extraStyle.textContent = `.v340-zoom-controls{display:flex;justify-content:center;gap:8px;padding:8px;background:#171717;color:#fff}.v340-zoom-controls button{min-width:52px;background:#ffffff18;color:#fff;border:0}.v340-viewer-state{font-size:.78rem;color:#d6cdb8;margin-top:5px}.v340-conflict{margin:8px 12px}.v340-viewer img{will-change:transform;transform-origin:center}.v341-nav-zone{position:absolute;top:12%;bottom:12%;height:auto;width:min(24vw,128px);z-index:3;border:0;background:transparent;color:#ffffff99;font-size:2rem;touch-action:none}.v341-nav-zone.prev{left:0;text-align:left;padding-left:14px}.v341-nav-zone.next{right:0;text-align:right;padding-right:14px}.viewer-stage.v341-zoomed .v341-nav-zone{pointer-events:none;opacity:0}`;
  document.head.appendChild(extraStyle);
  const teamStyle = document.createElement('style');
  teamStyle.textContent = `.sheet-backdrop{z-index:120}.v340-viewer .viewer-top .icon-btn{color:#fff;background:rgba(255,255,255,.18);border:1px solid #ffffff38;width:44px;height:44px;min-width:44px;min-height:44px;border-radius:50%;padding:0}.v340-viewer .viewer-actions{display:flex;gap:8px}.v340-viewer .viewer-actions button{min-height:44px;flex:1;padding:8px 10px}.vnext-notes{margin-top:12px;border-top:1px solid #ffffff38;padding-top:10px}.vnext-note{padding:10px 0;border-bottom:1px solid #ffffff28}.vnext-note p{white-space:pre-wrap;overflow-wrap:anywhere}.vnext-note-caption,.vnext-note small{font-size:.8rem;opacity:.8}.vnext-notes button{color:inherit;background:#ffffff18;border:1px solid #ffffff38}`;
  document.head.appendChild(teamStyle);
})();
