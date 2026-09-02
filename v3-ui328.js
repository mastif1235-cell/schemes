/* Blocknot Scan v3.2.8: mobile layout cleanup for notebook search, history and invite settings. */

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

  /* User-requested order: search first, then Add spread. */
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

function v328AddInviteToSettings() {
  if (!v328IsSettingsScreen()) return;
  if (document.getElementById('v328SettingsInviteBtn')) return;

  const all = [...document.querySelectorAll('h1,h2,h3,h4,strong,b,div,p,span')];
  const section = all.find(el => /команда и синхронизация|команда та синхронізація/i.test((el.textContent || '').trim()));
  const btn = document.createElement('button');
  btn.id = 'v328SettingsInviteBtn';
  btn.className = 'btn-secondary';
  btn.textContent = '🔗 Ввести код приглашения';
  btn.style.cssText = 'width:100%;margin:12px 0;box-sizing:border-box;';
  btn.onclick = () => {
    if (typeof v322OpenRedeemInvite === 'function') v322OpenRedeemInvite();
    else toast('Функция приглашения временно недоступна');
  };

  if (section) section.insertAdjacentElement('afterend', btn);
  else if (screenEl) screenEl.insertBefore(btn, screenEl.firstElementChild || null);
}

let v328Scheduled = false;
function v328ApplyLayout() {
  if (v328Scheduled) return;
  v328Scheduled = true;
  requestAnimationFrame(() => {
    v328Scheduled = false;
    try {
      v328PlaceNotebookSearch();
      v328PlaceHistoryAndHideInvite();
      v328AddInviteToSettings();
    } catch (e) {
      console.warn('v3.2.8 layout', e);
    }
  });
}

const v328Observer = new MutationObserver(v328ApplyLayout);
setTimeout(() => {
  if (document.body) v328Observer.observe(document.body, {childList:true, subtree:true});
  v328ApplyLayout();
}, 120);
