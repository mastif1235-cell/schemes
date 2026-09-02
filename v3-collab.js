/* Blocknot Scan v3.2.2: invite-code UI + synced notebook cover thumbnail. */
const V322_COVER_RE = /\n?\[\[BNSCOVER:([A-Za-z0-9+/=]+)\]\]\s*$/;

function v322StripCoverMarker(description) {
  return String(description || '').replace(V322_COVER_RE, '').trimEnd();
}
function v322CoverBase64(description) {
  const m = String(description || '').match(V322_COVER_RE);
  return m ? m[1] : '';
}
function v322Base64ToBlob(b64) {
  const bin = atob(b64), bytes = new Uint8Array(bin.length);
  for (let i=0;i<bin.length;i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], {type:'image/jpeg'});
}
async function v322TinyCoverBase64(blob) {
  const bm = await createImageBitmap(blob);
  const w = 104, h = 146, ratio = w/h;
  let sx=0, sy=0, sw=bm.width, sh=bm.height;
  if (sw/sh > ratio) { sw = Math.round(sh*ratio); sx = Math.round((bm.width-sw)/2); }
  else { sh = Math.round(sw/ratio); sy = Math.round((bm.height-sh)/2); }
  const c = document.createElement('canvas'); c.width=w; c.height=h;
  c.getContext('2d').drawImage(bm,sx,sy,sw,sh,0,0,w,h);
  if (bm.close) bm.close();
  const out = await new Promise((res,rej)=>c.toBlob(b=>b?res(b):rej(new Error('cover thumb failed')),'image/jpeg',0.68));
  const buf = new Uint8Array(await out.arrayBuffer());
  let bin=''; for (const b of buf) bin += String.fromCharCode(b);
  return btoa(bin);
}
async function v322CoverBlobFromNotebook(nb) {
  if (!nb) return null;
  if (nb.cover_blob_id) {
    const rec = await get('blobs', nb.cover_blob_id);
    if (rec && rec.blob) return rec.blob;
  }
  if (nb.cover_photo_id) {
    for (const key of [nb.cover_photo_id+'_thumb', nb.cover_photo_id+'_full', nb.cover_photo_id+'_original']) {
      const rec = await get('blobs', key);
      if (rec && rec.blob) return rec.blob;
    }
  }
  return null;
}
async function v322PatchRemoteCover(nb, remove=false) {
  if (!nb || !nb.server_id || !isAuthed()) return;
  try {
    const currentResp = await api(`/api/notebooks/${encodeURIComponent(nb.server_id)}`);
    const remote = currentResp && currentResp.notebook;
    if (!remote) return;
    const clean = v322StripCoverMarker(remote.description || '');
    let description = clean;
    if (!remove) {
      const blob = await v322CoverBlobFromNotebook(nb);
      if (!blob) return;
      const b64 = await v322TinyCoverBase64(blob);
      description = clean + `${clean ? '\n' : ''}[[BNSCOVER:${b64}]]`;
    }
    const patched = await api(`/api/notebooks/${encodeURIComponent(nb.server_id)}`, {
      method:'PATCH',
      body:JSON.stringify({revision:remote.revision, description})
    });
    if (patched && patched.notebook) nb.revision = patched.notebook.revision;
  } catch (e) {
    console.warn('cover sync failed', e);
    toast('Обложка сохранена локально, синхронизация повторится позже');
  }
}

const v322SaveExternalCoverBase = saveExternalCover;
saveExternalCover = async function(nb,file) {
  await v322SaveExternalCoverBase(nb,file);
  await v322PatchRemoteCover(nb,false);
};
const v322ChooseCoverFromSpreadsBase = chooseCoverFromSpreads;
chooseCoverFromSpreads = async function(nb,parentClose) {
  const r = await v322ChooseCoverFromSpreadsBase(nb,parentClose);
  const grid = document.getElementById('nbCoverGrid');
  if (grid) grid.addEventListener('click', () => setTimeout(()=>v322PatchRemoteCover(nb,false),350), {once:true});
  return r;
};
const v322OpenNotebookCoverBase = openNotebookCover;
openNotebookCover = async function(nb) {
  const r = await v322OpenNotebookCoverBase(nb);
  const rm = document.getElementById('coverRemove');
  if (rm) rm.addEventListener('click', () => setTimeout(()=>v322PatchRemoteCover(nb,true),350), {once:true});
  return r;
};
const v322GetNotebookCoverUrlBase = getNotebookCoverUrl;
getNotebookCoverUrl = async function(nb) {
  const local = await v322GetNotebookCoverUrlBase(nb);
  if (local) return local;
  const b64 = v322CoverBase64(nb && nb.description);
  if (!b64) return null;
  try { return URL.createObjectURL(v322Base64ToBlob(b64)); } catch (_) { return null; }
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
  if (!screenEl || !isAuthed()) return;
  const heading = [...screenEl.querySelectorAll('h1,h2,h3')].find(h => /мои блокноты|мої блокноти/i.test(h.textContent || ''));
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
  /* Hide the transport marker if the base UI prints notebook descriptions. */
  const cards = [...screenEl.querySelectorAll('.notebook-card')];
  for (const card of cards) {
    const walker = document.createTreeWalker(card, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (node.nodeValue && node.nodeValue.includes('[[BNSCOVER:')) node.nodeValue = node.nodeValue.replace(/\[\[BNSCOVER:[A-Za-z0-9+/=]+\]\]/g,'').trim();
    }
  }
}
const v322RenderNotebooksBase = renderNotebooks;
renderNotebooks = async function() {
  await v322RenderNotebooksBase();
  await v322DecorateNotebookTop();
};
