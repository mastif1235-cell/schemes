/* Blocknot Scan v3.4.0: photo state, original resolution and leak-free viewer. */
(function () {
  function photoQueueItem(photo, queue) {
    return (queue || []).find(item => item.entity === 'photo' && item.photo_id === photo.id);
  }

  window.v340GetPhotoSyncState = function (photo, queue) {
    const item = photoQueueItem(photo, queue);
    if ((item && item.status === 'failed') || photo.upload_status === 'upload_failed') return {state:'failed', label:'⚠ ошибка'};
    if ((item && item.status === 'syncing') || photo.upload_status === 'uploading') return {state:'uploading', label:'↻ загрузка'};
    if ((item && item.status === 'pending') || photo.upload_status === 'local_pending') return {state:'pending', label:'⏳ ожидает'};
    if (photo.telegram_file_id || photo.storage_object_id || photo.server_id) return {state:'telegram', label:'☁ Telegram'};
    return {state:'local', label:'📱 локально'};
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
    } catch (_) {
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

  openViewer = async function (spreads, initialIndex) {
    if (!Array.isArray(spreads) || !spreads.length) return;
    let index = Math.max(0, Math.min(spreads.length - 1, initialIndex || 0));
    let currentUrl = null;
    let closed = false;
    const historyToken = 'v340-viewer-' + Date.now();
    const overlay = document.createElement('div');
    overlay.className = 'viewer v340-viewer';
    document.body.appendChild(overlay);

    function revokeCurrentUrl() {
      if (!currentUrl) return;
      try { URL.revokeObjectURL(currentUrl); } catch (_) {}
      currentUrl = null;
    }

    function finish() {
      if (closed) return;
      closed = true;
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
    } catch (_) {}

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
        ${spread.conflict ? '<div class="warn-box v340-conflict">⚠ Конфликт версий<div class="btn-row"><button class="btn-secondary" data-action="server">Версия сервера</button><button class="btn-primary" data-action="mine">Сохранить мою</button></div></div>' : ''}
        <div class="viewer-bottom"><div class="t">${esc(spread.title || 'Без названия')}</div>
          ${photoState ? `<div class="v340-viewer-state">${photoState.label}${resolved.fallback ? ' · показана миниатюра' : ''}</div>` : ''}
          <div class="tags">${tags.map(tag => `<span>#${esc(tag.name)}</span>`).join('')}</div>
          ${spread.note_short ? `<div class="note" style="font-weight:600">${esc(spread.note_short)}</div>` : ''}
          ${spread.note_full ? `<div class="note">${esc(spread.note_full)}</div>` : ''}
          <div class="viewer-actions"><button data-action="replace">Заменить фото</button>
          <button data-action="telegram" ${photo && photo.telegram_message_id ? '' : 'disabled'}>Открыть в Telegram</button>
          <button data-action="delete">Удалить</button></div></div>`;

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
          anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
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
})();
