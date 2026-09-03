/* Blocknot Scan v3.4.0: bounded camera preview and deterministic cleanup. */
(function () {
  function chooseSource() {
    return new Promise(resolve => {
      const {close, el} = openSheet(`<div class="sheet-handle"></div><h2>Добавить фото страницы</h2>
        <p class="v340-caption">Сделайте новый снимок или выберите готовое фото.</p><div class="v340-action-list">
        <button class="btn-primary" data-choice="camera">📷 Сфотографировать</button>
        <button class="btn-secondary" data-choice="gallery">🖼️ Выбрать из галереи</button>
        <button class="btn-ghost" data-choice="cancel">Отмена</button></div>`);
      el.closest('.sheet-backdrop').classList.add('v340-camera-sheet');
      let settled = false;
      const finish = value => { if (settled) return; settled = true; close(); resolve(value); };
      el.onclick = event => {
        const button = event.target.closest('[data-choice]');
        if (button) finish(button.dataset.choice === 'cancel' ? null : button.dataset.choice);
      };
      el.closest('.sheet-backdrop').addEventListener('click', event => {
        if (event.target === el.closest('.sheet-backdrop')) finish(null);
      });
    });
  }

  function pickRawImage(capture) {
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

  async function workingBitmap(file) {
    const original = await createImageBitmap(file, {imageOrientation:'from-image'});
    try {
      const maxSide = 2400;
      const factor = Math.min(1, maxSide / Math.max(original.width, original.height));
      const width = Math.max(1, Math.round(original.width * factor));
      const height = Math.max(1, Math.round(original.height * factor));
      const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
      canvas.getContext('2d', {alpha:false}).drawImage(original, 0, 0, width, height);
      const bitmap = await createImageBitmap(canvas);
      canvas.width = canvas.height = 0;
      return bitmap;
    } finally {
      if (original.close) original.close();
    }
  }

  function interactiveCrop(file, orientation) {
    return new Promise(async resolve => {
      let bitmap;
      try { bitmap = await workingBitmap(file); }
      catch (error) { console.error('Camera image decode failed', error); resolve({action:'cancel'}); return; }
      const pageOrientation = orientation === 'auto'
        ? (bitmap.width >= bitmap.height ? 'landscape' : 'portrait')
        : orientation;
      const ratio = pageOrientation === 'landscape' ? 1.414 : 1 / 1.414;
      const backdrop = document.createElement('div'); backdrop.className = 'sheet-backdrop v340-crop-backdrop';
      const sheet = document.createElement('div'); sheet.className = 'sheet v340-crop-sheet';
      sheet.innerHTML = `<div class="sheet-handle"></div><h2>Подготовить страницу</h2>
        <p class="v340-caption">Двигайте фото одним пальцем, масштабируйте двумя или кнопками.</p>
        <canvas class="v340-crop-canvas"></canvas>
        <div class="v340-crop-tools"><button data-action="minus">−</button><button data-action="reset">100%</button><button data-action="plus">+</button><button data-action="rotate-left" aria-label="Повернуть влево на 90 градусов">↺ 90°</button><button data-action="rotate-right" aria-label="Повернуть вправо на 90 градусов">↻ 90°</button></div>
        <div class="btn-row"><button class="btn-secondary" data-action="retake">Повторить</button><button class="btn-primary" data-action="use">Использовать</button></div>
        <button class="btn-ghost" data-action="cancel" style="width:100%;margin-top:8px">Отмена</button>`;
      backdrop.appendChild(sheet); document.getElementById('modalRoot').appendChild(backdrop);
      const canvas = sheet.querySelector('canvas');
      const context = canvas.getContext('2d');
      const state = {zoom:1, panX:0, panY:0, rotation:0, pointers:new Map(), pinchDistance:0,
        pinchZoom:1, anchorX:0, anchorY:0};
      const frame = {x:0, y:0, width:1, height:1};
      let settled = false;
      const token = 'v340-crop-' + Date.now();

      function sizeCanvas() {
        const maxWidth = Math.min(620, innerWidth - 32);
        const maxHeight = Math.min(innerHeight * .55, 620);
        canvas.width = Math.max(1, Math.round(maxWidth));
        canvas.height = Math.max(240, Math.round(maxHeight));
        frame.height = canvas.height - 28;
        frame.width = frame.height * ratio;
        if (frame.width > canvas.width - 28) {
          frame.width = canvas.width - 28;
          frame.height = frame.width / ratio;
        }
        frame.x = (canvas.width - frame.width) / 2;
        frame.y = (canvas.height - frame.height) / 2;
        canvas.style.width = canvas.width + 'px'; canvas.style.height = canvas.height + 'px';
      }

      function rotatedSize() {
        return state.rotation % 180 ? {width:bitmap.height, height:bitmap.width} : {width:bitmap.width, height:bitmap.height};
      }

      function fitScale() {
        const dimensions = rotatedSize();
        return Math.max(frame.width / dimensions.width, frame.height / dimensions.height);
      }

      function clampPan(scale) {
        const dimensions = rotatedSize();
        const width = dimensions.width * scale, height = dimensions.height * scale;
        const maxX = Math.max(0, (width - frame.width) / 2);
        const maxY = Math.max(0, (height - frame.height) / 2);
        state.panX = Math.max(-maxX, Math.min(maxX, state.panX));
        state.panY = Math.max(-maxY, Math.min(maxY, state.panY));
      }

      function drawImage(target, targetWidth, targetHeight, multiplier, centerX, centerY) {
        const scale = fitScale() * state.zoom * multiplier;
        target.save();
        target.translate((centerX ?? targetWidth / 2) + state.panX * multiplier, (centerY ?? targetHeight / 2) + state.panY * multiplier);
        target.rotate(state.rotation * Math.PI / 180);
        target.scale(scale, scale);
        target.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2);
        target.restore();
      }

      function renderPreview() {
        const scale = fitScale() * state.zoom;
        clampPan(scale);
        context.fillStyle = '#111'; context.fillRect(0, 0, canvas.width, canvas.height);
        const centerX = frame.x + frame.width / 2, centerY = frame.y + frame.height / 2;
        drawImage(context, canvas.width, canvas.height, 1, centerX, centerY);
        context.fillStyle = 'rgba(0,0,0,.58)'; context.fillRect(0, 0, canvas.width, canvas.height);
        context.save(); context.beginPath(); context.rect(frame.x, frame.y, frame.width, frame.height); context.clip();
        drawImage(context, canvas.width, canvas.height, 1, centerX, centerY); context.restore();
        context.strokeStyle = '#fff'; context.lineWidth = 3;
        context.strokeRect(frame.x + 1.5, frame.y + 1.5, frame.width - 3, frame.height - 3);
        sheet.querySelector('[data-action="reset"]').textContent = Math.round(state.zoom * 100) + '%';
      }

      async function outputFile() {
        const outputWidth = pageOrientation === 'landscape' ? 2200 : 1600;
        const outputHeight = Math.round(outputWidth / ratio);
        const output = document.createElement('canvas'); output.width = outputWidth; output.height = outputHeight;
        const outputContext = output.getContext('2d', {alpha:false}); outputContext.fillStyle = '#fff'; outputContext.fillRect(0, 0, outputWidth, outputHeight);
        drawImage(outputContext, outputWidth, outputHeight, outputWidth / frame.width);
        const blob = await new Promise((res, rej) => output.toBlob(value => value ? res(value) : rej(new Error('crop failed')), 'image/jpeg', .9));
        output.width = output.height = 0;
        return new File([blob], file.name.replace(/\.[^.]+$/, '') + '_page.jpg', {type:'image/jpeg', lastModified:Date.now()});
      }

      function cleanup() {
        window.removeEventListener('resize', onResize);
        window.removeEventListener('popstate', onPopState);
        backdrop.remove();
        canvas.width = canvas.height = 0;
        if (bitmap && bitmap.close) bitmap.close();
        bitmap = null;
      }

      function finish(result, fromPop) {
        if (settled) return;
        settled = true;
        cleanup();
        if (!fromPop && history.state && history.state.blocknotCrop === token) history.back();
        resolve(result);
      }

      function onPopState() { finish({action:'cancel'}, true); }
      function onResize() { sizeCanvas(); renderPreview(); }
      window.addEventListener('resize', onResize);
      try { history.pushState({blocknotCrop:token}, ''); window.addEventListener('popstate', onPopState); }
      catch (error) { console.warn('Crop history state could not be created', error); }
      backdrop.addEventListener('click', event => { if (event.target === backdrop) finish({action:'cancel'}); });

      canvas.addEventListener('pointerdown', event => {
        canvas.setPointerCapture(event.pointerId);
        state.pointers.set(event.pointerId, {x:event.clientX, y:event.clientY});
        if (state.pointers.size === 1) { state.anchorX = event.clientX - state.panX; state.anchorY = event.clientY - state.panY; }
        if (state.pointers.size === 2) {
          const points = [...state.pointers.values()];
          state.pinchDistance = Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
          state.pinchZoom = state.zoom;
        }
      });
      canvas.addEventListener('pointermove', event => {
        if (!state.pointers.has(event.pointerId)) return;
        state.pointers.set(event.pointerId, {x:event.clientX, y:event.clientY});
        if (state.pointers.size === 2) {
          const points = [...state.pointers.values()];
          const distance = Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
          state.zoom = Math.max(1, Math.min(5, state.pinchZoom * distance / (state.pinchDistance || distance)));
        } else {
          state.panX = event.clientX - state.anchorX; state.panY = event.clientY - state.anchorY;
        }
        renderPreview();
      });
      const endPointer = event => {
        state.pointers.delete(event.pointerId);
        if (state.pointers.size === 1) {
          const remaining = [...state.pointers.values()][0];
          state.anchorX = remaining.x - state.panX; state.anchorY = remaining.y - state.panY;
        }
      };
      canvas.addEventListener('pointerup', endPointer);
      canvas.addEventListener('pointercancel', endPointer);

      sheet.onclick = async event => {
        const button = event.target.closest('[data-action]');
        if (!button || button.disabled) return;
        if (button.dataset.action === 'minus') state.zoom = Math.max(1, state.zoom - .2);
        else if (button.dataset.action === 'plus') state.zoom = Math.min(5, state.zoom + .2);
        else if (button.dataset.action === 'reset') { state.zoom = 1; state.panX = state.panY = 0; }
        else if (button.dataset.action === 'rotate-left') { state.rotation = (state.rotation + 270) % 360; state.zoom = 1; state.panX = state.panY = 0; }
        else if (button.dataset.action === 'rotate-right') { state.rotation = (state.rotation + 90) % 360; state.zoom = 1; state.panX = state.panY = 0; }
        else if (button.dataset.action === 'retake') { finish({action:'retake'}); return; }
        else if (button.dataset.action === 'cancel') { finish({action:'cancel'}); return; }
        else if (button.dataset.action === 'use') {
          button.disabled = true;
          try { finish({action:'use', file:await outputFile()}); }
          catch (error) { console.error('Crop output failed', error); button.disabled = false; toast('Не удалось обработать фото'); }
          return;
        }
        renderPreview();
      };

      sizeCanvas(); renderPreview();
    });
  }

  window.v340CapturePhoto = async function () {
    const choice = await chooseSource();
    if (!choice) return null;
    while (true) {
      const file = await pickRawImage(choice === 'camera');
      if (!file) return null;
      const result = await interactiveCrop(file, 'auto');
      if (result.action === 'retake') continue;
      return result.action === 'use' ? result.file : null;
    }
  };

  startCapture = async function (notebookId) {
    const file = await window.v340CapturePhoto();
    if (file) await openSpreadForm(notebookId, null, file);
  };

  v3ChoosePageCapture = async function (originalInput) {
    const file = await window.v340CapturePhoto();
    if (!file) return;
    try {
      const transfer = new DataTransfer(); transfer.items.add(file); originalInput.files = transfer.files;
      originalInput.dispatchEvent(new Event('change', {bubbles:true}));
    } catch (error) {
      console.warn('This browser cannot assign a captured file to the original input', error);
      toast('Фото готово, но браузер не разрешил передать его форме');
    }
  };

  const style = document.createElement('style');
  style.textContent = `.v340-camera-sheet,.v340-crop-backdrop{z-index:70}.v340-crop-sheet{display:grid;gap:10px}.v340-crop-canvas{display:block;max-width:100%;margin:auto;background:#111;touch-action:none;border-radius:10px}.v340-crop-tools{display:flex;justify-content:center;gap:8px}.v340-crop-tools button{min-width:52px;background:var(--surface);border:1px solid var(--border);color:var(--text)}`;
  document.head.appendChild(style);
})();
