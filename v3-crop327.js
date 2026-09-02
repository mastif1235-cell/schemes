/* Blocknot Scan v3.2.7: post-capture page framing with dimmed outside area and adjustable crop. */

async function v327InteractiveCrop(file, orientation) {
  if (!file) return null;
  const ratio = orientation === 'landscape' ? 1.414 : 1 / 1.414;
  const bitmap = await createImageBitmap(file);
  const previewUrl = URL.createObjectURL(file);

  return new Promise(resolve => {
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      try { URL.revokeObjectURL(previewUrl); } catch (_) {}
      try { if (bitmap.close) bitmap.close(); } catch (_) {}
      resolve(value);
    };

    const {close, el} = openSheet(`
      <div class="sheet-handle"></div>
      <h2 style="margin-bottom:6px">✂️ Проверьте границы страницы</h2>
      <p style="color:var(--ink-soft);font-size:.8rem;margin:0 0 10px">Перетаскивайте фото внутри рамки. Кнопками −/+ можно изменить масштаб. Затем нажмите «Использовать».</p>
      <div id="v327CropStage" style="position:relative;height:min(58vh,520px);min-height:300px;background:#111;overflow:hidden;border-radius:12px;touch-action:none;user-select:none">
        <img id="v327CropImg" src="${previewUrl}" alt="Фото страницы" style="position:absolute;left:50%;top:50%;max-width:none;max-height:none;transform-origin:center;will-change:transform;pointer-events:none;-webkit-user-drag:none">
        <div id="v327CropFrame" style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);border:2px solid #fff;border-radius:6px;box-shadow:0 0 0 9999px rgba(0,0,0,.58);pointer-events:none"></div>
      </div>
      <div style="display:grid;grid-template-columns:1fr auto auto 1fr;gap:8px;margin-top:10px;align-items:center">
        <button id="v327Cancel" class="btn-secondary">Переснять</button>
        <button id="v327Minus" class="btn-secondary">−</button>
        <button id="v327Plus" class="btn-secondary">+</button>
        <button id="v327Use" class="btn-big">Использовать</button>
      </div>`);

    const stage = el.querySelector('#v327CropStage');
    const img = el.querySelector('#v327CropImg');
    const frame = el.querySelector('#v327CropFrame');
    let zoom = 1;
    let x = 0, y = 0;
    let baseScale = 1;
    let frameW = 1, frameH = 1;
    let dragging = false;
    let pointerId = null;
    let startPointerX = 0, startPointerY = 0, startX = 0, startY = 0;

    function layoutFrame() {
      const sw = stage.clientWidth || 320;
      const sh = stage.clientHeight || 420;
      const maxW = sw * 0.84;
      const maxH = sh * 0.84;
      if (maxW / maxH > ratio) {
        frameH = maxH;
        frameW = frameH * ratio;
      } else {
        frameW = maxW;
        frameH = frameW / ratio;
      }
      frame.style.width = `${frameW}px`;
      frame.style.height = `${frameH}px`;
      baseScale = Math.max(frameW / bitmap.width, frameH / bitmap.height);
      clampAndApply();
    }

    function clampAndApply() {
      const scale = baseScale * zoom;
      const displayW = bitmap.width * scale;
      const displayH = bitmap.height * scale;
      const maxX = Math.max(0, (displayW - frameW) / 2);
      const maxY = Math.max(0, (displayH - frameH) / 2);
      x = Math.max(-maxX, Math.min(maxX, x));
      y = Math.max(-maxY, Math.min(maxY, y));
      img.style.width = `${bitmap.width * baseScale}px`;
      img.style.height = `${bitmap.height * baseScale}px`;
      img.style.transform = `translate(calc(-50% + ${x}px), calc(-50% + ${y}px)) scale(${zoom})`;
    }

    function setZoom(next) {
      zoom = Math.max(1, Math.min(4, next));
      clampAndApply();
    }

    stage.addEventListener('pointerdown', e => {
      if (dragging) return;
      dragging = true;
      pointerId = e.pointerId;
      stage.setPointerCapture(pointerId);
      startPointerX = e.clientX;
      startPointerY = e.clientY;
      startX = x;
      startY = y;
    });
    stage.addEventListener('pointermove', e => {
      if (!dragging || e.pointerId !== pointerId) return;
      x = startX + (e.clientX - startPointerX);
      y = startY + (e.clientY - startPointerY);
      clampAndApply();
    });
    const endDrag = e => {
      if (e.pointerId !== pointerId) return;
      dragging = false;
      pointerId = null;
    };
    stage.addEventListener('pointerup', endDrag);
    stage.addEventListener('pointercancel', endDrag);

    el.querySelector('#v327Minus').onclick = () => setZoom(zoom - 0.2);
    el.querySelector('#v327Plus').onclick = () => setZoom(zoom + 0.2);
    el.querySelector('#v327Cancel').onclick = () => { close(); finish(null); };
    el.querySelector('#v327Use').onclick = async () => {
      const btn = el.querySelector('#v327Use');
      btn.disabled = true;
      btn.textContent = 'Обрезаю…';
      try {
        const scale = baseScale * zoom;
        const stageW = stage.clientWidth;
        const stageH = stage.clientHeight;
        const displayW = bitmap.width * scale;
        const displayH = bitmap.height * scale;
        const imageLeft = (stageW - displayW) / 2 + x;
        const imageTop = (stageH - displayH) / 2 + y;
        const frameLeft = (stageW - frameW) / 2;
        const frameTop = (stageH - frameH) / 2;
        let sx = (frameLeft - imageLeft) / scale;
        let sy = (frameTop - imageTop) / scale;
        let sw = frameW / scale;
        let sh = frameH / scale;
        sx = Math.max(0, Math.min(bitmap.width - sw, sx));
        sy = Math.max(0, Math.min(bitmap.height - sh, sy));
        sw = Math.min(sw, bitmap.width - sx);
        sh = Math.min(sh, bitmap.height - sy);

        const max = 2200;
        const outW = orientation === 'landscape' ? max : Math.round(max * ratio);
        const outH = orientation === 'landscape' ? Math.round(max / ratio) : max;
        const canvas = document.createElement('canvas');
        canvas.width = outW;
        canvas.height = outH;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, outW, outH);
        const blob = await new Promise((res, rej) => canvas.toBlob(b => b ? res(b) : rej(new Error('crop failed')), 'image/jpeg', .9));
        const out = new File([blob], String(file.name || 'page').replace(/\.[^.]+$/, '') + '_crop.jpg', {type:'image/jpeg', lastModified:Date.now()});
        close();
        finish(out);
      } catch (e) {
        btn.disabled = false;
        btn.textContent = 'Использовать';
        toast('Не удалось обрезать фото: ' + (e.message || e));
      }
    };

    requestAnimationFrame(layoutFrame);
    window.addEventListener('resize', layoutFrame, {once:true});
  });
}

v3ChoosePageCapture = function(originalInput) {
  const {close} = openSheet(`
    <div class="sheet-handle"></div>
    <h2>Добавить фото страницы</h2>
    <p style="color:var(--ink-soft);margin-top:0">Выберите форму страницы. После снимка появится рамка: область снаружи затемнится, фото можно будет подвигать и обрезать.</p>
    <div style="display:grid;gap:10px">
      <button id="v327Portrait" class="btn-big">▯ Вертикальная страница</button>
      <button id="v327Landscape" class="btn-secondary">▭ Горизонтальная страница</button>
      <button id="v327Gallery" class="btn-secondary">🖼 Выбрать готовое фото без обрезки</button>
    </div>`);

  const run = async (orientation, capture) => {
    close();
    const temp = document.createElement('input');
    temp.type = 'file';
    temp.accept = 'image/*';
    temp.dataset.v3InternalPicker = '1';
    if (capture) temp.setAttribute('capture','environment');
    temp.style.display = 'none';
    document.body.appendChild(temp);
    temp.onchange = async () => {
      let file = temp.files && temp.files[0];
      temp.remove();
      if (!file) return;
      if (orientation) {
        file = await v327InteractiveCrop(file, orientation);
        if (!file) {
          v3ChoosePageCapture(originalInput);
          return;
        }
      }
      const dt = new DataTransfer();
      dt.items.add(file);
      originalInput.files = dt.files;
      originalInput.dispatchEvent(new Event('change',{bubbles:true}));
    };
    temp.oncancel = () => temp.remove();
    temp.click();
  };

  document.getElementById('v327Portrait').onclick = () => run('portrait', true);
  document.getElementById('v327Landscape').onclick = () => run('landscape', true);
  document.getElementById('v327Gallery').onclick = () => run(null, false);
};
