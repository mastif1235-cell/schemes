/* Blocknot Scan v3.2.6 polish: bounded viewer pan, stable photo badges, URL cleanup. */

/* Photo decorators must continue past already decorated images instead of aborting the whole pass. */
v3DecoratePhotos = async function() {
  if (!screenEl) return;
  const imgs = [...screenEl.querySelectorAll('img')].filter(i =>
    !i.classList.contains('notebook-cover-mini') && !i.closest('#v3PhotoViewer')
  );
  for (const img of imgs) {
    if (img.dataset.v3Decorated) continue;
    const p = await v3PhotoFromImage(img);
    if (!p) continue;
    img.dataset.v3Decorated = '1';
    img.dataset.photoId = p.id;
    const host = img.parentElement;
    if (!host) continue;
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    let badge = host.querySelector('.v3-photo-status');
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'v3-photo-status';
      badge.style.cssText = 'position:absolute;right:5px;bottom:5px;background:#000b;color:#fff;border-radius:999px;padding:3px 6px;font-size:11px;z-index:3;pointer-events:none;';
      host.appendChild(badge);
    }
    const text = typeof v325PhotoStatusText === 'function' ? await v325PhotoStatusText(p) : await v321PhotoStatusText(p);
    badge.textContent = /ошибка/.test(text) ? '⚠️' : /синхронизация/.test(text) ? '🔄' : /ожидает/.test(text) ? '⏳' : /Telegram/.test(text) && /локально/.test(text) ? '📱☁️' : /Telegram/.test(text) ? '☁️' : '📱';
    badge.title = text;
  }
};

/* Keep pan inside the visible scaled image. */
v3ViewerApply = function() {
  if (!v3Viewer) return;
  const {img, label} = v3Viewer;
  let scale = Number(v3Viewer.scale || 1);
  scale = Math.max(1, Math.min(6, scale));
  v3Viewer.scale = scale;
  if (scale <= 1) {
    v3Viewer.x = 0;
    v3Viewer.y = 0;
  } else {
    const w = img.clientWidth || 0;
    const h = img.clientHeight || 0;
    const maxX = Math.max(0, w * (scale - 1) / 2);
    const maxY = Math.max(0, h * (scale - 1) / 2);
    v3Viewer.x = Math.max(-maxX, Math.min(maxX, Number(v3Viewer.x || 0)));
    v3Viewer.y = Math.max(-maxY, Math.min(maxY, Number(v3Viewer.y || 0)));
  }
  img.style.transform = `translate(${v3Viewer.x}px,${v3Viewer.y}px) scale(${scale})`;
  label.textContent = Math.round(scale * 100) + '%';
};

/* Re-apply bounds once the newly selected image gets its actual dimensions. */
const v326ViewerSetPhotoBase = v3ViewerSetPhoto;
v3ViewerSetPhoto = async function(photo) {
  const r = await v326ViewerSetPhotoBase(photo);
  if (v3Viewer && v3Viewer.img) {
    const img = v3Viewer.img;
    if (img.complete) v3ViewerApply();
    else img.addEventListener('load', () => { if (v3Viewer && v3Viewer.img === img) v3ViewerApply(); }, {once:true});
  }
  return r;
};

/* Revoke old notebook-cover object URLs when cards are rerendered. */
const v326CoverUrls = new Map();
const v326GetNotebookCoverUrlBase = getNotebookCoverUrl;
getNotebookCoverUrl = async function(nb) {
  const url = await v326GetNotebookCoverUrlBase(nb);
  if (!nb || !url) return url;
  const key = String(nb.id || '');
  const old = v326CoverUrls.get(key);
  if (old && old !== url) {
    try { URL.revokeObjectURL(old); } catch (_) {}
  }
  v326CoverUrls.set(key, url);
  return url;
};

/* The native camera cannot show our overlay. Be explicit: framing/crop happens after capture. */
const v326ChoosePageCaptureBase = v3ChoosePageCapture;
v3ChoosePageCapture = function(originalInput) {
  const {close} = openSheet(`<div class="sheet-handle"></div><h2>Добавить фото страницы</h2><p style="color:var(--ink-soft);margin-top:0">Выберите форму страницы. Камера телефона откроется отдельно, а после снимка приложение автоматически обрежет фото под выбранную форму.</p><div style="display:grid;gap:10px"><button id="v326Portrait" class="btn-big">▯ Вертикальная страница</button><button id="v326Landscape" class="btn-secondary">▭ Горизонтальная страница</button><button id="v326Gallery" class="btn-secondary">🖼 Выбрать готовое фото</button></div>`);
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
      let f = temp.files && temp.files[0];
      temp.remove();
      if (!f) return;
      try {
        if (orientation) f = await v3CropPageFile(f, orientation);
        const dt = new DataTransfer();
        dt.items.add(f);
        originalInput.files = dt.files;
        originalInput.dispatchEvent(new Event('change',{bubbles:true}));
      } catch (e) {
        toast('Не удалось обрезать фото: ' + (e.message || e));
      }
    };
    temp.oncancel = () => temp.remove();
    temp.click();
  };
  document.getElementById('v326Portrait').onclick = () => run('portrait', true);
  document.getElementById('v326Landscape').onclick = () => run('landscape', true);
  document.getElementById('v326Gallery').onclick = () => run(null, false);
};
