/* Blocknot Scan v3.3.4: landscape page layout + rotate controls after capture. */

async function v334RotatedFile(file, quarterTurns) {
  const turns = ((quarterTurns % 4) + 4) % 4;
  if (!turns) return file;
  const bitmap = await createImageBitmap(file);
  const swap = turns % 2 === 1;
  const canvas = document.createElement('canvas');
  canvas.width = swap ? bitmap.height : bitmap.width;
  canvas.height = swap ? bitmap.width : bitmap.height;
  const ctx = canvas.getContext('2d');
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate(turns * Math.PI / 2);
  ctx.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2);
  if (bitmap.close) bitmap.close();
  const blob = await new Promise((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(new Error('rotate failed')), 'image/jpeg', .92));
  return new File([blob], String(file.name || 'page').replace(/\.[^.]+$/, '') + '_rotated.jpg', {type:'image/jpeg', lastModified:Date.now()});
}

v327InteractiveCrop = async function(file, orientation) {
  if (!file) return null;
  const ratio = orientation === 'landscape' ? 1.414 : 1 / 1.414;
  let workingFile = file;
  let bitmap = await createImageBitmap(workingFile);
  let previewUrl = URL.createObjectURL(workingFile);

  return new Promise(resolve => {
    let settled = false;
    let turns = 0;
    const finish = value => {
      if (settled) return;
      settled = true;
      try { URL.revokeObjectURL(previewUrl); } catch (_) {}
      try { if (bitmap.close) bitmap.close(); } catch (_) {}
      resolve(value);
    };

    const {close, el} = openSheet(`
      <div class="sheet-handle"></div>
      <h2 style="margin-bottom:6px">✂️ Проверьте страницу</h2>
      <p style="color:var(--ink-soft);font-size:.8rem;margin:0 0 10px">Можно повернуть фото, подвигать его внутри рамки и увеличить.</p>
      <div id="v334CropStage" style="position:relative;height:min(58vh,520px);min-height:300px;background:#111;overflow:hidden;border-radius:12px;touch-action:none;user-select:none">
        <img id="v334CropImg" src="${previewUrl}" alt="Фото страницы" style="position:absolute;left:50%;top:50%;max-width:none;max-height:none;transform-origin:center;will-change:transform;pointer-events:none;-webkit-user-drag:none">
        <div id="v334CropFrame" style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);border:2px solid #fff;border-radius:6px;box-shadow:0 0 0 9999px rgba(0,0,0,.58);pointer-events:none"></div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px">
        <button id="v334RotateLeft" class="btn-secondary">↶ Повернуть влево</button>
        <button id="v334RotateRight" class="btn-secondary">↷ Повернуть вправо</button>
      </div>
      <div style="display:grid;grid-template-columns:1fr auto auto 1fr;gap:8px;margin-top:8px;align-items:center">
        <button id="v334Cancel" class="btn-secondary">Переснять</button>
        <button id="v334Minus" class="btn-secondary">−</button>
        <button id="v334Plus" class="btn-secondary">+</button>
        <button id="v334Use" class="btn-big">Использовать</button>
      </div>`);

    const stage = el.querySelector('#v334CropStage');
    const img = el.querySelector('#v334CropImg');
    const frame = el.querySelector('#v334CropFrame');
    let zoom = 1, x = 0, y = 0, baseScale = 1, frameW = 1, frameH = 1;
    let dragging = false, pointerId = null, startPointerX = 0, startPointerY = 0, startX = 0, startY = 0;

    function layoutFrame() {
      const sw = stage.clientWidth || 320;
      const sh = stage.clientHeight || 420;
      const maxW = sw * 0.88;
      const maxH = sh * 0.82;
      if (maxW / maxH > ratio) { frameH = maxH; frameW = frameH * ratio; }
      else { frameW = maxW; frameH = frameW / ratio; }
      frame.style.width = `${frameW}px`;
      frame.style.height = `${frameH}px`;
      baseScale = Math.max(frameW / bitmap.width, frameH / bitmap.height);
      x = 0; y = 0; zoom = Math.max(1, zoom);
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

    function setZoom(next) { zoom = Math.max(1, Math.min(4, next)); clampAndApply(); }

    async function rotate(delta) {
      turns = (turns + delta + 4) % 4;
      try { URL.revokeObjectURL(previewUrl); } catch (_) {}
      try { if (bitmap.close) bitmap.close(); } catch (_) {}
      workingFile = await v334RotatedFile(file, turns);
      bitmap = await createImageBitmap(workingFile);
      previewUrl = URL.createObjectURL(workingFile);
      img.src = previewUrl;
      zoom = 1; x = 0; y = 0;
      layoutFrame();
    }

    stage.addEventListener('pointerdown', e => {
      if (dragging) return;
      dragging = true; pointerId = e.pointerId; stage.setPointerCapture(pointerId);
      startPointerX = e.clientX; startPointerY = e.clientY; startX = x; startY = y;
    });
    stage.addEventListener('pointermove', e => {
      if (!dragging || e.pointerId !== pointerId) return;
      x = startX + (e.clientX - startPointerX); y = startY + (e.clientY - startPointerY); clampAndApply();
    });
    const endDrag = e => { if (e.pointerId !== pointerId) return; dragging = false; pointerId = null; };
    stage.addEventListener('pointerup', endDrag); stage.addEventListener('pointercancel', endDrag);

    el.querySelector('#v334RotateLeft').onclick = () => rotate(3);
    el.querySelector('#v334RotateRight').onclick = () => rotate(1);
    el.querySelector('#v334Minus').onclick = () => setZoom(zoom - .2);
    el.querySelector('#v334Plus').onclick = () => setZoom(zoom + .2);
    el.querySelector('#v334Cancel').onclick = () => { close(); finish(null); };
    el.querySelector('#v334Use').onclick = async () => {
      const btn = el.querySelector('#v334Use'); btn.disabled = true; btn.textContent = 'Обрезаю…';
      try {
        const scale = baseScale * zoom;
        const stageW = stage.clientWidth, stageH = stage.clientHeight;
        const displayW = bitmap.width * scale, displayH = bitmap.height * scale;
        const imageLeft = (stageW - displayW) / 2 + x, imageTop = (stageH - displayH) / 2 + y;
        const frameLeft = (stageW - frameW) / 2, frameTop = (stageH - frameH) / 2;
        let sx = (frameLeft - imageLeft) / scale, sy = (frameTop - imageTop) / scale;
        let sw = frameW / scale, sh = frameH / scale;
        sx = Math.max(0, Math.min(bitmap.width - sw, sx)); sy = Math.max(0, Math.min(bitmap.height - sh, sy));
        sw = Math.min(sw, bitmap.width - sx); sh = Math.min(sh, bitmap.height - sy);
        const max = 2200;
        const outW = orientation === 'landscape' ? max : Math.round(max * ratio);
        const outH = orientation === 'landscape' ? Math.round(max / ratio) : max;
        const canvas = document.createElement('canvas'); canvas.width = outW; canvas.height = outH;
        canvas.getContext('2d').drawImage(bitmap, sx, sy, sw, sh, 0, 0, outW, outH);
        const blob = await new Promise((res, rej) => canvas.toBlob(b => b ? res(b) : rej(new Error('crop failed')), 'image/jpeg', .9));
        const out = new File([blob], String(file.name || 'page').replace(/\.[^.]+$/, '') + '_crop.jpg', {type:'image/jpeg', lastModified:Date.now()});
        close(); finish(out);
      } catch (e) {
        btn.disabled = false; btn.textContent = 'Использовать'; toast('Не удалось обрезать фото: ' + (e.message || e));
      }
    };

    requestAnimationFrame(layoutFrame);
  });
};

function v334LandscapeCards() {
  if (!screenEl) return;
  const imgs = [...screenEl.querySelectorAll('img[data-photo-id], .photo-grid img, .spread-photo img')];
  for (const img of imgs) {
    if (img.closest('#v3PhotoViewer,#v321RegularViewer')) continue;
    const apply = () => {
      if (!img.naturalWidth || !img.naturalHeight) return;
      const host = img.closest('.photo-card,.photo-item,.spread-photo') || img.parentElement;
      if (!host) return;
      const landscape = img.naturalWidth > img.naturalHeight * 1.15;
      host.style.gridColumn = landscape ? '1 / -1' : '';
      if (landscape) {
        img.style.width = '100%';
        img.style.height = 'auto';
        img.style.maxHeight = 'none';
        img.style.objectFit = 'contain';
      }
    };
    if (img.complete) apply(); else img.addEventListener('load', apply, {once:true});
  }
}

let v334Queued = false;
function v334ScheduleLayout() {
  if (v334Queued) return;
  v334Queued = true;
  requestAnimationFrame(() => { v334Queued = false; try { v334LandscapeCards(); } catch (_) {} });
}
const v334Observer = new MutationObserver(v334ScheduleLayout);
setTimeout(() => { if (document.body) v334Observer.observe(document.body,{childList:true,subtree:true}); v334ScheduleLayout(); },150);
