/* Blocknot Scan v3.3.5: mobile layout cleanup for notebook search, history and invite settings. */
/* Search above Add spread, History promoted, invite strictly inside Settings, version always visible in Settings. */

function v328FindButton(re) {
  return [...document.querySelectorAll('button,a')].find(el => re.test((el.textContent || '').replace(/\s+/g,' ').trim()));
}

function v328IsNotebookListScreen() {
  return !![...document.querySelectorAll('h1,h2,h3')].find(h => /мои блокноты|мої блокноти/i.test(h.textContent || ''));
}

function v328IsSettingsScreen() {
  return !![...document.querySelectorAll('h1,h2,h3')].find(h => /^настройки$|^налаштування$/i.test((h.textContent || '').trim()));
}

function v328PlaceNotebookSearch() {
  const box = document.getElementById('v323NotebookSearch');
  if (!box) return;
  const add = v328FindButton(/^\+?\s*добавить разворот$|^\+?\s*додати розворот$/i);
  if (!add) {
    box.style.width = '100%';
    box.style.gridColumn = '1 / -1';
    return;
  }

  const addHost = add.parentElement || add;
  const parent = addHost.parentElement;
  if (!parent) return;

  if (box.parentElement !== parent || box.nextElementSibling !== addHost) {
    parent.insertBefore(box, addHost);
  }
  box.style.width = '100%';
  box.style.boxSizing = 'border-box';
  box.style.gridColumn = '1 / -1';
  box.style.margin = '0 0 12px';
  const input = box.querySelector('input');
  if (input) {
    input.style.width = '100%';
    input.style.display = 'block';
    input.style.boxSizing = 'border-box';
  }
}

function v328PlaceHistoryAndHideInvite() {
  if (!v328IsNotebookListScreen()) return;
  const hub = document.getElementById('v323NotebookHub');
  if (!hub) return;

  const invite = hub.querySelector('#v323InviteBtn');
  if (invite) invite.remove();
  const oldInvite = document.getElementById('v322RedeemInviteBtn');
  if (oldInvite) oldInvite.style.display = 'none';

  hub.style.gridTemplateColumns = '1fr';
  hub.style.width = '100%';
  hub.style.margin = '12px 0';

  const add = v328FindButton(/^\+?\s*новый блокнот$|^\+?\s*новий блокнот$/i);
  if (!add) return;
  const addHost = add.parentElement || add;
  if (addHost.parentElement && hub.parentElement === addHost.parentElement && addHost.nextElementSibling !== hub) {
    addHost.insertAdjacentElement('afterend', hub);
  } else if (addHost.parentElement && hub.parentElement !== addHost.parentElement) {
    addHost.insertAdjacentElement('afterend', hub);
  }
}

function v328SettingsHost() {
  if (!screenEl) return null;
  return screenEl;
}

function v328CleanupSettingsOnlyUi() {
  if (v328IsSettingsScreen()) return;
  const invite = document.getElementById('v328SettingsInviteBtn');
  if (invite) invite.remove();
  const version = document.getElementById('v330SettingsVersion');
  if (version) version.remove();
}

function v328AddInviteToSettings() {
  if (!v328IsSettingsScreen()) return;
  const host = v328SettingsHost();
  if (!host) return;

  let btn = document.getElementById('v328SettingsInviteBtn');
  if (!btn) {
    btn = document.createElement('button');
    btn.id = 'v328SettingsInviteBtn';
    btn.className = 'btn-secondary';
    btn.textContent = '🔗 Ввести код приглашения';
    btn.style.cssText = 'width:100%;margin:12px 0;box-sizing:border-box;';
    btn.onclick = () => {
      if (typeof v322OpenRedeemInvite === 'function') v322OpenRedeemInvite();
      else toast('Функция приглашения временно недоступна');
    };
  }

  const all = [...host.querySelectorAll('h1,h2,h3,h4,strong,b,div,p,span')];
  const section = all.find(el => /команда и синхронизация|команда та синхронізація/i.test((el.textContent || '').trim()));
  if (section) {
    const sectionParent = section.parentElement || host;
    if (btn.parentElement !== sectionParent || btn.previousElementSibling !== section) {
      section.insertAdjacentElement('afterend', btn);
    }
  } else if (!host.contains(btn)) {
    host.insertBefore(btn, host.firstElementChild || null);
  }
}

function v330PinSettingsVersion() {
  if (!v328IsSettingsScreen()) return;
  const host = v328SettingsHost();
  if (!host) return;

  for (const el of [...host.querySelectorAll('div,p,small,span')]) {
    const text = (el.textContent || '').trim();
    if (/^Блокнот-скан\s*·/i.test(text) && el.id !== 'v330SettingsVersion') {
      el.style.display = 'none';
    }
  }

  let version = document.getElementById('v330SettingsVersion');
  if (!version) {
    version = document.createElement('div');
    version.id = 'v330SettingsVersion';
    version.style.cssText = 'margin:22px 0 92px;padding:0 2px;text-align:center;color:var(--ink-soft);font-size:13px;line-height:1.4;';
  }
  const currentVersion = String(window.__BLOCKNOT_APP_VERSION__ || '3.3.5');
  version.textContent = 'Блокнот-скан · v' + currentVersion;
  if (version.parentElement !== host || version !== host.lastElementChild) host.appendChild(version);
}

let v328Scheduled = false;
function v328ApplyLayout() {
  if (v328Scheduled) return;
  v328Scheduled = true;
  requestAnimationFrame(() => {
    v328Scheduled = false;
    try {
      v328CleanupSettingsOnlyUi();
      v328PlaceNotebookSearch();
      v328PlaceHistoryAndHideInvite();
      v328AddInviteToSettings();
      v330PinSettingsVersion();
    } catch (e) {
      console.warn('v3 layout', e);
    }
  });
}

const v328Observer = new MutationObserver(v328ApplyLayout);
setTimeout(() => {
  if (document.body) v328Observer.observe(document.body, {childList:true, subtree:true});
  v328ApplyLayout();
}, 120);
