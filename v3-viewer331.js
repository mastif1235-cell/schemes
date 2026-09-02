/* Blocknot Scan v3.3.1: photo actions + true fullscreen viewer polish. */

function v331StyleFullscreenViewer() {
  const root = document.getElementById('v3PhotoViewer');
  if (!root || root.dataset.v331Styled) return;
  root.dataset.v331Styled = '1';
  root.style.cssText = 'position:fixed;inset:0;width:100vw;height:100dvh;z-index:2147483647;background:#000;color:#fff;display:flex;flex-direction:column;touch-action:none;overflow:hidden;';

  const stage = root.querySelector('#v3Stage');
  if (stage) {
    stage.style.cssText = 'position:relative;flex:1 1 auto;min-height:0;overflow:hidden;display:flex;align-items:center;justify-content:center;background:#000;';
  }
  const img = root.querySelector('#v3Img');
  if (img) {
    img.style.maxWidth = '100vw';
    img.style.maxHeight = '100%';
    img.style.width = 'auto';
    img.style.height = 'auto';
    img.style.objectFit = 'contain';
  }

  const close = root.querySelector('#v3Close');
  if (close) {
    close.textContent = '← Назад';
    close.style.cssText = 'border:1px solid #d8cfb5;background:rgba(0,0,0,.62);color:#fff;border-radius:12px;padding:10px 14px;font:600 16px system-ui;';
  }
  const status = root.querySelector('#v3Status');
  if (status) status.style.cssText = 'font:500 14px system-ui;color:#fff;flex:1;line-height:1.25;';

  /* Download belongs to the normal photo screen, not the fullscreen toolbar. */
  const dl = root.querySelector('#v3Download');
  if (dl) dl.style.display = 'none';

  for (const id of ['v3Prev','v3Next']) {
    const b = root.querySelector('#' + id);
    if (b) {
      b.style.background = 'rgba(0,0,0,.55)';
      b.style.color = '#fff';
      b.style.border = '1px solid rgba(255,255,255,.45)';
    }
  }
  for (const id of ['v3Minus','v3Pct','v3Plus']) {
    const b = root.querySelector('#' + id);
    if (b) b.style.cssText = 'min-width:72px;border:1px solid #d8cfb5;background:rgba(0,0,0,.72);color:#fff;border-radius:12px;padding:10px 14px;font:600 17px system-ui;';
  }

  /* Existing top/bottom bars become compact overlays so the image uses almost all screen. */
  const top = close && close.parentElement;
  if (top) top.style.cssText = 'display:flex;align-items:center;gap:10px;padding:8px 10px;background:rgba(0,0,0,.72);z-index:3;flex:0 0 auto;';
  const pct = root.querySelector('#v3Pct');
  const bottom = pct && pct.parentElement;
  if (bottom) bottom.style.cssText = 'display:flex;justify-content:center;align-items:center;gap:10px;padding:8px 10px;background:rgba(0,0,0,.72);z-index:3;flex:0 0 auto;';
}

async function v331OpenFullscreen(photo) {
  if (!photo) return;
  if (typeof v321FullscreenViewer === 'function') await v321FullscreenViewer(photo);
  else if (typeof v3OpenViewer === 'function') await v3OpenViewer(photo);
  requestAnimationFrame(v331StyleFullscreenViewer);
  setTimeout(v331StyleFullscreenViewer, 60);
}

async function v331DecorateNativePhotoSheet() {
  if (typeof v323DecorateNativeSpreadSheet === 'function') {
    try { await v323DecorateNativeSpreadSheet(); } catch (_) {}
  }
  const anchor = [...document.querySelectorAll('button')].find(b => /Открыть.*Telegram|Відкрити.*Telegram|Заменить фото|Замінити фото|Удалить фото|Видалити фото/i.test(b.textContent || ''));
  if (!anchor || typeof v323ClosestNativeSpreadSheet !== 'function') return;
  const sheet = v323ClosestNativeSpreadSheet(anchor);
  if (!sheet) return;
  const img = sheet.querySelector('img');
  if (!img) return;
  const photo = typeof v323ResolvePhotoFromImage === 'function' ? await v323ResolvePhotoFromImage(img) : null;
  if (!photo) return;

  /* Remove the old large two-button block. */
  const oldRow = sheet.querySelector('#v323NativeActions');
  if (oldRow) oldRow.remove();

  /* Download sits beside Delete in the normal photo actions. */
  let download = sheet.querySelector('#v331DownloadPhoto');
  if (!download) {
    download = document.createElement('button');
    download.id = 'v331DownloadPhoto';
    download.className = 'btn-secondary';
    download.textContent = '⬇ Скачать';
    download.onclick = () => {
      if (typeof v321DownloadPhoto === 'function') v321DownloadPhoto(photo);
    };
    const delBtn = [...sheet.querySelectorAll('button')].find(b => /Удалить фото|Видалити фото|^Удалить$|^Видалити$/i.test((b.textContent || '').trim()));
    if (delBtn) {
      const host = delBtn.parentElement;
      if (host) {
        host.style.display = 'flex';
        host.style.flexWrap = 'wrap';
        host.style.gap = '10px';
        host.appendChild(download);
      } else delBtn.insertAdjacentElement('afterend', download);
    } else sheet.appendChild(download);
  }

  /* Small fullscreen-corners button lives directly on the image. */
  const imageHost = img.parentElement;
  if (imageHost) {
    if (getComputedStyle(imageHost).position === 'static') imageHost.style.position = 'relative';
    let full = imageHost.querySelector('#v331FullscreenCorner');
    if (!full) {
      full = document.createElement('button');
      full.id = 'v331FullscreenCorner';
      full.type = 'button';
      full.textContent = '⛶';
      full.title = 'На весь экран';
      full.setAttribute('aria-label','На весь экран');
      full.style.cssText = 'position:absolute;right:10px;bottom:10px;width:48px;height:48px;border-radius:12px;border:1px solid rgba(255,255,255,.75);background:rgba(0,0,0,.58);color:#fff;font:600 28px/1 system-ui;z-index:8;display:flex;align-items:center;justify-content:center;';
      full.onclick = e => { e.preventDefault(); e.stopPropagation(); v331OpenFullscreen(photo); };
      imageHost.appendChild(full);
    }
  }
}

let v331Queued = false;
function v331Schedule() {
  if (v331Queued) return;
  v331Queued = true;
  requestAnimationFrame(() => {
    v331Queued = false;
    v331DecorateNativePhotoSheet().catch(e => console.warn('v3.3.1 photo UI', e));
    v331StyleFullscreenViewer();
  });
}
const v331Observer = new MutationObserver(v331Schedule);
setTimeout(() => {
  if (document.body) v331Observer.observe(document.body,{childList:true,subtree:true});
  v331Schedule();
},120);
