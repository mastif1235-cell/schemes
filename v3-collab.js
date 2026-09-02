/* Blocknot Scan v3.2.4: invite-code UI + safe local notebook covers.
   Important: cover image data must never be transported inside notebook.description. */
const V322_COVER_RE = /\s*\[\[BNSCOVER:([A-Za-z0-9+/=]+)\]\]\s*/g;

function v322StripCoverMarker(description) {
  return String(description || '').replace(V322_COVER_RE, '').replace(/\n{3,}/g, '\n\n').trim();
}
function v322CoverBase64() { return ''; }

function v322CleanNotebookObject(nb) {
  if (!nb) return false;
  const before = String(nb.description || '');
  const after = v322StripCoverMarker(before);
  if (before === after) return false;
  nb.description = after;
  nb.updated_at = nowISO();
  return true;
}

/*
 * One safe migration path only:
 * - remove legacy [[BNSCOVER:...]] transport markers from local notebook data;
 * - let the app's normal notebook sync queue push the cleaned description;
 * - never issue a second direct notebook PATCH from cover UI.
 */
let v322CoverMigrationRunning = false;
async function v322MigrateLegacyCoverMarkers() {
  if (v322CoverMigrationRunning) return;
  v322CoverMigrationRunning = true;
  try {
    const notebooks = await getAll('notebooks');
    for (const nb of notebooks) {
      if (!v322CleanNotebookObject(nb)) continue;
      await put('notebooks', nb);
      if (isAuthed() && typeof queueEntityChange === 'function') {
        try { queueEntityChange('notebook', nb.id); } catch (_) {}
      }
    }
  } catch (e) {
    console.warn('legacy cover marker cleanup failed', e);
  } finally {
    v322CoverMigrationRunning = false;
  }
}

/* Legacy compatibility stubs. No remote image transport through description. */
async function v322PatchRemoteCover() { return; }

/* Keep cover selection/removal on the existing single notebook sync path.
   External cover blobs remain local until a dedicated backend cover contract exists. */
const v322SaveExternalCoverBase = saveExternalCover;
saveExternalCover = async function(nb, file) {
  if (nb) v322CleanNotebookObject(nb);
  return v322SaveExternalCoverBase(nb, file);
};
const v322ChooseCoverFromSpreadsBase = chooseCoverFromSpreads;
chooseCoverFromSpreads = async function(nb, parentClose) {
  if (nb) v322CleanNotebookObject(nb);
  return v322ChooseCoverFromSpreadsBase(nb, parentClose);
};
const v322OpenNotebookCoverBase = openNotebookCover;
openNotebookCover = async function(nb) {
  if (nb) v322CleanNotebookObject(nb);
  return v322OpenNotebookCoverBase(nb);
};
const v322GetNotebookCoverUrlBase = getNotebookCoverUrl;
getNotebookCoverUrl = async function(nb) {
  if (nb) v322CleanNotebookObject(nb);
  return v322GetNotebookCoverUrlBase(nb);
};

function v322ErrorText(err) {
  const s = String((err && err.message) || err || '');
  if (/invite_not_found|404/i.test(s)) return 'Код приглашения не найден';
  if (/invite_already_used|409/i.test(s)) return 'Этот код уже использован';
  if (/invite_expired|410/i.test(s)) return 'Срок действия кода закончился';
  return 'Не удалось принять приглашение: ' + s;
}
async function v322OpenRedeemInvite() {
  const {close} = openSheet(`<div class="sheet-handle"></div><h2>🔗 Присоединиться к блокноту</h2><p style="color:var(--muted);margin-top:0">Введите код, который прислал владелец блокнота.</p><input id="v322InviteCode" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Код приглашения" style="width:100%;box-sizing:border-box;padding:12px;border:1px solid var(--line);border-radius:10px;font:inherit"><button id="v322RedeemBtn" class="btn-primary" style="width:100%;margin-top:12px">Добавить блокнот</button>`);
  const input = document.getElementById('v322InviteCode');
  const btn = document.getElementById('v322RedeemBtn');
  input.focus();
  const submit = async () => {
    const code = input.value.trim();
    if (!code) { toast('Введите код приглашения'); return; }
    btn.disabled = true; btn.textContent = 'Проверяю…';
    try {
      const r = await api('/api/auth/redeem-invite', {method:'POST', body:JSON.stringify({code})});
      close();
      toast('Блокнот добавлен. Обновляю список…');
      setTimeout(()=>location.reload(),650);
      return r;
    } catch (e) {
      btn.disabled = false; btn.textContent = 'Добавить блокнот';
      toast(v322ErrorText(e));
    }
  };
  btn.onclick = submit;
  input.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
}

async function v322DecorateNotebookTop() {
  if (!screenEl) return;

  /* Defensive UI cleanup for any stale DOM rendered before migration. */
  const cards = [...screenEl.querySelectorAll('.notebook-card')];
  for (const card of cards) {
    const walker = document.createTreeWalker(card, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (node.nodeValue && node.nodeValue.includes('[[BNSCOVER:')) {
        node.nodeValue = v322StripCoverMarker(node.nodeValue);
      }
    }
  }

  if (!isAuthed()) return;
  /* Header is outside screenEl in the base app, so search the document. */
  const heading = [...document.querySelectorAll('h1,h2,h3')].find(h => /мои блокноты|мої блокноти/i.test(h.textContent || ''));
  if (!heading) return;
  if (!document.getElementById('v322RedeemInviteBtn')) {
    const btn = document.createElement('button');
    btn.id = 'v322RedeemInviteBtn'; btn.className = 'btn-secondary';
    btn.textContent = '🔗 Ввести код приглашения';
    btn.style.cssText = 'margin-left:8px;white-space:nowrap;';
    btn.onclick = v322OpenRedeemInvite;
    const hist = document.getElementById('v321GlobalHistoryBtn');
    (hist || heading).insertAdjacentElement('afterend', btn);
  }
}

const v322RenderNotebooksBase = renderNotebooks;
renderNotebooks = async function() {
  await v322MigrateLegacyCoverMarkers();
  await v322RenderNotebooksBase();
  await v322DecorateNotebookTop();
};

/* Also run once after startup so edit/export cannot expose a legacy marker first. */
setTimeout(() => v322MigrateLegacyCoverMarkers(), 250);
