/* Blocknot Scan v3.2.9: compact history icon in header. */
function v329NotebookListVisible() {
  return !![...document.querySelectorAll('h1,h2,h3')].find(h => /мои блокноты|мої блокноти/i.test(h.textContent || ''));
}

async function v329PlaceHistoryIcon() {
  const oldHub = document.getElementById('v323NotebookHub');
  if (oldHub) oldHub.remove();
  const oldHist = document.getElementById('v321GlobalHistoryBtn');
  if (oldHist) oldHist.style.display = 'none';

  const existing = document.getElementById('v329HistoryIcon');
  if (!v329NotebookListVisible()) {
    if (existing) existing.remove();
    return;
  }
  if (existing) return;

  const themeBtn = [...document.querySelectorAll('button,a')].find(el => /^(◐|◑|☾|☀|🌙|🌞)$/u.test((el.textContent || '').trim()));
  if (!themeBtn || !themeBtn.parentElement) return;

  const btn = document.createElement('button');
  btn.id = 'v329HistoryIcon';
  btn.type = 'button';
  btn.textContent = '🕘';
  btn.setAttribute('aria-label','История');
  btn.title = 'История';
  btn.style.cssText = 'appearance:none;border:0;background:transparent;padding:6px 8px;margin:0;font:inherit;font-size:22px;line-height:1;cursor:pointer;color:inherit;';
  btn.onclick = () => {
    if (typeof v321OpenGlobalHistory === 'function') v321OpenGlobalHistory();
    else toast('История временно недоступна');
  };

  themeBtn.parentElement.insertBefore(btn, themeBtn);

  try {
    if (typeof v321UnreadHistoryCount === 'function') {
      const count = await v321UnreadHistoryCount();
      if (count) {
        btn.textContent = '🕘';
        const badge = document.createElement('span');
        badge.textContent = count > 99 ? '99+' : String(count);
        badge.style.cssText = 'position:absolute;transform:translate(-4px,-8px);min-width:15px;height:15px;padding:0 3px;border-radius:999px;background:#b42318;color:white;font:600 9px/15px system-ui;text-align:center;';
        btn.style.position = 'relative';
        btn.appendChild(badge);
      }
    }
  } catch (_) {}
}

let v329Queued = false;
function v329Schedule() {
  if (v329Queued) return;
  v329Queued = true;
  requestAnimationFrame(() => {
    v329Queued = false;
    v329PlaceHistoryIcon().catch(e => console.warn('v3.2.9 history icon', e));
  });
}

const v329Observer = new MutationObserver(v329Schedule);
setTimeout(() => {
  if (document.body) v329Observer.observe(document.body, {childList:true,subtree:true});
  v329Schedule();
}, 120);
