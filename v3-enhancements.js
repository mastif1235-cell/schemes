/* Blocknot Scan v3.2.0: notebook actions, compact covers, photo viewer, recents, search priority, camera framing. */
const V3_RELEASE = '3.2.0';
const V3_RECENTS_KEY = 'blocknot_v3_recent_spreads';
const v3BlobKeyByBlob = new WeakMap();
const v3BlobKeyByUrl = new Map();

const v3GetOriginal = get;
get = async function(store, key) {
  const rec = await v3GetOriginal(store, key);
  if (store === 'blobs' && rec && rec.blob instanceof Blob) v3BlobKeyByBlob.set(rec.blob, String(key));
  return rec;
};
const v3CreateObjectUrlOriginal = URL.createObjectURL.bind(URL);
URL.createObjectURL = function(blob) {
  const url = v3CreateObjectUrlOriginal(blob);
  const key = blob && v3BlobKeyByBlob.get(blob);
  if (key) v3BlobKeyByUrl.set(url, key);
  return url;
};
const v3RevokeObjectUrlOriginal = URL.revokeObjectURL.bind(URL);
URL.revokeObjectURL = function(url) { v3BlobKeyByUrl.delete(url); return v3RevokeObjectUrlOriginal(url); };

function v3PhotoIdFromBlobKey(key) { return String(key || '').replace(/_(thumb|full|preview|original)$/i, ''); }
async function v3PhotoFromImage(img) {
  if (!img || !img.src) return null;
  let key = v3BlobKeyByUrl.get(img.src);
  if (!key && img.dataset && img.dataset.photoId) return get('photos', img.dataset.photoId);
  if (!key) return null;
  return get('photos', v3PhotoIdFromBlobKey(key));
}
async function v3LocalPhotoBlob(photo) {
  if (!photo) return null;
  for (const key of [photo.id + '_full', photo.id + '_original', photo.id + '_thumb']) {
    const rec = await get('blobs', key);
    if (rec && rec.blob) return rec.blob;
  }
  return null;
}
function v3ServerPhotoId(photo) { return photo && (photo.server_id || photo.remote_id || photo.photo_id || photo.id); }
async function v3FetchOriginalBlob(photo) {
  const local = await v3LocalPhotoBlob(photo);
  if (local && !String(photo && photo.server_id || '').length) return local;
  if (isAuthed()) {
    try {
      const id = v3ServerPhotoId(photo);
      if (id) {
        const r = await apiBlob(`/api/photos/${encodeURIComponent(id)}/file`);
        if (r instanceof Blob) return r;
      }
    } catch (_) {}
  }
  return local;
}

const openNotebookEditorV2 = openNotebookEditor;
function openNotebookActions(nb) {
  const body = `<div class="sheet-handle"></div><h2>${esc(nb.title)}</h2><div class="btn-row" style="display:grid;gap:10px;"><button class="btn-secondary" id="nbActionEdit">Редактировать блокнот</button><button class="btn-secondary" id="nbActionPartner">Добавить напарника</button><button class="btn-secondary" id="nbActionCover">📷 Обложка</button><button class="btn-secondary" id="nbActionHistory">🕘 История</button></div>`;
  const {close} = openSheet(body);
  document.getElementById('nbActionEdit').onclick = () => { close(); openNotebookEditorV2(nb); };
  document.getElementById('nbActionPartner').onclick = () => { close(); openNotebookPartner(nb); };
  document.getElementById('nbActionCover').onclick = () => { close(); openNotebookCover(nb); };
  document.getElementById('nbActionHistory').onclick = () => { close(); openNotebookHistory(nb); };
}
openNotebookEditor = function(nb) { return nb ? openNotebookActions(nb) : openNotebookEditorV2(nb); };
async function openNotebookPartner(nb) {
  if (!isAuthed() || !nb.server_id) { toast('Сначала дождитесь синхронизации блокнота'); return; }
  try {
    const invite = await api('/api/invites', {method:'POST', body:JSON.stringify({notebook_id:nb.server_id, role:'MEMBER', expires_in_days:7})});
    const text = `Код приглашения: ${invite.code}`;
    if (navigator.share) await navigator.share({title:nb.title, text});
    else if (navigator.clipboard) { await navigator.clipboard.writeText(invite.code); toast('Код приглашения скопирован'); }
    else prompt('Код приглашения', invite.code);
  } catch (e) { toast('Не удалось создать приглашение: ' + (e.message || e)); }
}
function pickImageFile(capture) {
  return new Promise(resolve => {
    const input = document.createElement('input'); input.type='file'; input.accept='image/*'; input.dataset.v3CoverPicker='1';
    if (capture) input.setAttribute('capture','environment'); input.style.display='none'; document.body.appendChild(input);
    input.onchange=()=>{const file=input.files&&input.files[0]||null;input.remove();resolve(file);};
    input.oncancel=()=>{input.remove();resolve(null);}; input.click();
  });
}
async function cropCoverBlob(file) {
  const bitmap=await createImageBitmap(file), targetW=500,targetH=700,targetRatio=targetW/targetH;
  let sx=0,sy=0,sw=bitmap.width,sh=bitmap.height; const srcRatio=sw/sh;
  if(srcRatio>targetRatio){sw=Math.round(sh*targetRatio);sx=Math.round((bitmap.width-sw)/2);}else{sh=Math.round(sw/targetRatio);sy=Math.round((bitmap.height-sh)/2);}
  const canvas=document.createElement('canvas');canvas.width=targetW;canvas.height=targetH;canvas.getContext('2d').drawImage(bitmap,sx,sy,sw,sh,0,0,targetW,targetH);if(bitmap.close)bitmap.close();
  return new Promise((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(new Error('Не удалось подготовить обложку')),'image/jpeg',.86));
}
async function saveExternalCover(nb,file){if(!file)return;try{const blob=await cropCoverBlob(file),blobId=`notebook_cover_${nb.id}`;await put('blobs',{id:blobId,blob});nb.cover_blob_id=blobId;delete nb.cover_photo_id;nb.updated_at=nowISO();await put('notebooks',nb);if(isAuthed())queueEntityChange('notebook',nb.id);toast('Обложка сохранена');render();}catch(e){toast('Не удалось сохранить обложку: '+(e.message||e));}}
async function chooseCoverFromSpreads(nb,parentClose){const spreads=(await getAllByIndex('spreads','notebook_id',nb.id)).filter(s=>!s.deleted_at);const photos=(await Promise.all(spreads.map(s=>s.current_photo_id?get('photos',s.current_photo_id):null))).filter(Boolean);if(!photos.length){toast('В разворотах пока нет фото');return;}if(parentClose)parentClose();const {close}=openSheet(`<div class="sheet-handle"></div><h2>Фото из разворотов</h2><div id="nbCoverGrid" class="photo-grid"></div>`);const grid=document.getElementById('nbCoverGrid');for(const photo of photos){const rec=await get('blobs',photo.id+'_thumb'),button=document.createElement('button');button.className='btn-secondary';button.style.cssText='min-height:100px;background-size:cover;background-position:center;';button.textContent=rec?'':'Фото';if(rec)button.style.backgroundImage=`url(${URL.createObjectURL(rec.blob)})`;button.onclick=async()=>{nb.cover_photo_id=photo.id;delete nb.cover_blob_id;nb.updated_at=nowISO();await put('notebooks',nb);if(isAuthed())queueEntityChange('notebook',nb.id);close();toast('Обложка сохранена');render();};grid.appendChild(button);}}
async function openNotebookCover(nb){const hasCover=!!(nb.cover_blob_id||nb.cover_photo_id);const {close}=openSheet(`<div class="sheet-handle"></div><h2>📷 Обложка блокнота</h2><p style="margin-top:0;color:var(--muted)">Миниатюра справа на карточке блокнота.</p><div style="display:grid;gap:10px"><button class="btn-primary" id="coverCamera">📸 Сфотографировать блокнот</button><button class="btn-secondary" id="coverGallery">🖼 Выбрать из галереи</button><button class="btn-secondary" id="coverSpreads">📄 Выбрать из фото разворотов</button>${hasCover?'<button class="btn-secondary" id="coverRemove">🗑 Удалить обложку</button>':''}</div>`);document.getElementById('coverCamera').onclick=async()=>{const f=await pickImageFile(true);if(f){close();await saveExternalCover(nb,f);}};document.getElementById('coverGallery').onclick=async()=>{const f=await pickImageFile(false);if(f){close();await saveExternalCover(nb,f);}};document.getElementById('coverSpreads').onclick=()=>chooseCoverFromSpreads(nb,close);const rm=document.getElementById('coverRemove');if(rm)rm.onclick=async()=>{if(nb.cover_blob_id)try{await del('blobs',nb.cover_blob_id);}catch(_){}delete nb.cover_blob_id;delete nb.cover_photo_id;nb.updated_at=nowISO();await put('notebooks',nb);if(isAuthed())queueEntityChange('notebook',nb.id);close();toast('Обложка удалена');render();};}
async function getNotebookCoverUrl(nb){let rec=null;if(nb.cover_blob_id)rec=await get('blobs',nb.cover_blob_id);if(!rec&&nb.cover_photo_id)rec=await get('blobs',nb.cover_photo_id+'_thumb');return rec&&rec.blob?URL.createObjectURL(rec.blob):null;}
function v3ActionLabel(a){return ({spread_created:'Создан разворот',spread_updated:'Изменён разворот',photo_added:'Добавлено фото',notebook_created:'Создан блокнот',notebook_updated:'Изменён блокнот',member_added:'Добавлен напарник',member_removed:'Удалён напарник'}[a]||a||'Изменение');}
async function openNotebookHistory(nb){
  const spreadIds=new Set((await getAllByIndex('spreads','notebook_id',nb.id)).map(s=>s.id));
  const rows=(await getAll('history')).filter(h=>h.notebook_id===nb.id||spreadIds.has(h.spread_id)||spreadIds.has(h.entity_id)).sort((a,b)=>String(b.created_at||b.timestamp||'').localeCompare(String(a.created_at||a.timestamp||'')));
  const names=new Map();
  if(isAuthed()&&nb.server_id){try{const r=await api(`/api/notebooks/${encodeURIComponent(nb.server_id)}/members`);for(const m of (r.members||[]))names.set(m.user_id,m.display_name||m.user_id);}catch(_){}}
  const items=rows.length?rows.slice(0,100).map(h=>{const at=h.created_at||h.timestamp;const who=names.get(h.user_id)||h.display_name||'Пользователь';return `<div style="padding:10px 0;border-bottom:1px solid var(--line)"><b>${esc(v3ActionLabel(h.action))}</b><br><small>${esc(who)} · ${at?new Date(at).toLocaleString('ru-RU'):''}</small></div>`;}).join(''):'<p>История пока пуста.</p>';
  openSheet(`<div class="sheet-handle"></div><h2>🕘 История</h2>${items}`);
}
const renderNotebooksV2=renderNotebooks;
renderNotebooks=async function(){await renderNotebooksV2();const notebooks=(await getAll('notebooks')).filter(n=>!n.deleted_at&&!n.hidden_no_access).sort((a,b)=>(a.sort_order-b.sort_order)||0);const cards=screenEl.querySelectorAll('.notebook-card');for(let i=0;i<cards.length;i++){const nb=notebooks[i];if(!nb)continue;const url=await getNotebookCoverUrl(nb);if(!url)continue;cards[i].style.position='relative';cards[i].style.paddingRight='92px';cards[i].style.backgroundImage='';const old=cards[i].querySelector('.notebook-cover-mini');if(old)old.remove();const img=document.createElement('img');img.className='notebook-cover-mini';img.src=url;img.alt='Обложка блокнота';img.style.cssText='position:absolute;right:16px;top:50%;transform:translateY(-50%);width:52px;height:72px;object-fit:cover;border-radius:7px;border:1px solid rgba(0,0,0,.18);box-shadow:0 2px 6px rgba(0,0,0,.15);background:#eee;';cards[i].appendChild(img);}}
function v3LoadRecents(){try{return JSON.parse(localStorage.getItem(V3_RECENTS_KEY)||'[]');}catch(_){return [];}}
function v3RememberSpread(spread){if(!spread)return;let rows=v3LoadRecents().filter(x=>x.id!==spread.id);rows.unshift({id:spread.id,notebook_id:spread.notebook_id,number:spread.number,title:spread.title||'',at:Date.now()});localStorage.setItem(V3_RECENTS_KEY,JSON.stringify(rows.slice(0,12)));}
async function v3RenderRecentsIfUseful(){if(!screenEl||document.getElementById('v3RecentBlock'))return;const txt=(screenEl.textContent||'').toLowerCase();if(!txt.includes('избран')&&!txt.includes('обран'))return;const rows=v3LoadRecents();if(!rows.length)return;const wrap=document.createElement('div');wrap.id='v3RecentBlock';wrap.style.cssText='margin:0 0 14px;';wrap.innerHTML='<h3 style="margin:0 0 8px">🕘 Последние открытые</h3><div id="v3RecentItems" style="display:grid;gap:8px"></div>';const host=screenEl.firstElementChild||screenEl;host.insertBefore(wrap,host.firstChild);const box=wrap.querySelector('#v3RecentItems');for(const r of rows.slice(0,6)){const s=await get('spreads',r.id);if(!s||s.deleted_at)continue;const b=document.createElement('button');b.className='btn-secondary';b.style.textAlign='left';b.textContent=`№${s.number||'—'} ${s.title||''}`;b.onclick=()=>{v3RememberSpread(s);if(typeof openSpread==='function')openSpread(s);else if(typeof openSpreadEditor==='function')openSpreadEditor(s);else toast('Откройте разворот из списка');};box.appendChild(b);}}
let v3Viewer=null;
function v3ViewerApply(){if(!v3Viewer)return;const {img,scale,x,y,label}=v3Viewer;img.style.transform=`translate(${x}px,${y}px) scale(${scale})`;label.textContent=Math.round(scale*100)+'%';}
function v3ViewerReset(){if(!v3Viewer)return;v3Viewer.scale=1;v3Viewer.x=0;v3Viewer.y=0;v3ViewerApply();}
async function v3ViewerSetPhoto(photo){if(!v3Viewer||!photo)return;v3Viewer.photo=photo;const blob=await v3FetchOriginalBlob(photo);if(!blob){toast('Оригинал пока недоступен');return;}if(v3Viewer.url)URL.revokeObjectURL(v3Viewer.url);v3Viewer.url=URL.createObjectURL(blob);v3Viewer.img.src=v3Viewer.url;v3ViewerReset();await v3ViewerUpdateStatus();const spread=photo.spread_id?await get('spreads',photo.spread_id):null;if(spread)v3RememberSpread(spread);}
async function v3ViewerUpdateStatus(){if(!v3Viewer)return;const p=v3Viewer.photo;let local=!!(await v3LocalPhotoBlob(p)),cloud=!!(p&&(p.server_id||p.telegram_file_id||p.storage_object_id));let state='';try{const q=(await getAll('sync_queue')).find(x=>String(JSON.stringify(x)).includes(String(p.id)));if(q){if(q.status==='failed')state=' · ⚠️ ошибка';else if(q.status==='pending')state=' · ⏳ ожидает';else state=' · 🔄 синхронизация';}}catch(_){}v3Viewer.status.textContent=(local?'📱 локально':'')+(cloud?(local?' · ':'')+'☁️ Telegram':'')+state;}
async function v3ViewerNeighbors(photo){if(!photo)return[];const spread=await get('spreads',photo.spread_id);if(!spread)return[];return (await getAllByIndex('spreads','notebook_id',spread.notebook_id)).filter(s=>!s.deleted_at&&s.current_photo_id).sort((a,b)=>Number(a.number)-Number(b.number)||String(a.number).localeCompare(String(b.number)));}
async function v3ViewerMove(dir){if(!v3Viewer||v3Viewer.scale!==1)return;const p=v3Viewer.photo,sp=await get('spreads',p.spread_id),rows=await v3ViewerNeighbors(p);let i=rows.findIndex(s=>s.id===sp.id);if(i<0)return;i+=dir;if(i<0||i>=rows.length)return;const np=await get('photos',rows[i].current_photo_id);if(np)await v3ViewerSetPhoto(np);}
async function v3OpenViewer(photo){if(!photo)return;const root=document.createElement('div');root.id='v3PhotoViewer';root.style.cssText='position:fixed;inset:0;z-index:99999;background:#080808;color:#fff;display:flex;flex-direction:column;touch-action:none;';root.innerHTML=`<div style="display:flex;align-items:center;gap:8px;padding:10px;background:rgba(0,0,0,.72);z-index:2"><button id="v3Close" class="btn-secondary">← Назад</button><span id="v3Status" style="font-size:12px;flex:1"></span><button id="v3Download" class="btn-secondary">⬇</button></div><div id="v3Stage" style="position:relative;flex:1;overflow:hidden;display:flex;align-items:center;justify-content:center"><img id="v3Img" style="max-width:100%;max-height:100%;object-fit:contain;transform-origin:center;will-change:transform;user-select:none;-webkit-user-drag:none"><button id="v3Prev" style="position:absolute;left:8px;top:50%;font-size:26px;background:#0008;color:#fff;border:0;border-radius:50%;width:44px;height:44px">‹</button><button id="v3Next" style="position:absolute;right:8px;top:50%;font-size:26px;background:#0008;color:#fff;border:0;border-radius:50%;width:44px;height:44px">›</button></div><div style="display:flex;justify-content:center;align-items:center;gap:10px;padding:10px;background:rgba(0,0,0,.72)"><button id="v3Minus" class="btn-secondary">−</button><button id="v3Pct" class="btn-secondary">100%</button><button id="v3Plus" class="btn-secondary">+</button></div>`;document.body.appendChild(root);v3Viewer={root,img:root.querySelector('#v3Img'),stage:root.querySelector('#v3Stage'),label:root.querySelector('#v3Pct'),status:root.querySelector('#v3Status'),photo:null,url:null,scale:1,x:0,y:0,pointers:new Map(),startDist:0,startScale:1,startX:0,startY:0,swipeStartX:0,swipeStartY:0,lastTap:0};root.querySelector('#v3Close').onclick=()=>{if(v3Viewer.url)URL.revokeObjectURL(v3Viewer.url);root.remove();v3Viewer=null;};root.querySelector('#v3Minus').onclick=()=>{v3Viewer.scale=Math.max(1,v3Viewer.scale-.5);if(v3Viewer.scale===1){v3Viewer.x=v3Viewer.y=0;}v3ViewerApply();};root.querySelector('#v3Plus').onclick=()=>{v3Viewer.scale=Math.min(6,v3Viewer.scale+.5);v3ViewerApply();};root.querySelector('#v3Pct').onclick=v3ViewerReset;root.querySelector('#v3Prev').onclick=()=>v3ViewerMove(-1);root.querySelector('#v3Next').onclick=()=>v3ViewerMove(1);root.querySelector('#v3Download').onclick=async()=>{const b=await v3FetchOriginalBlob(v3Viewer.photo);if(!b){toast('Оригинал недоступен');return;}const a=document.createElement('a');a.href=URL.createObjectURL(b);a.download=`spread_${v3Viewer.photo.spread_id||'photo'}_${v3ServerPhotoId(v3Viewer.photo)||'original'}.jpg`;document.body.appendChild(a);a.click();setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove();},1500);};const st=v3Viewer.stage;st.addEventListener('pointerdown',e=>{st.setPointerCapture(e.pointerId);v3Viewer.pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});if(v3Viewer.pointers.size===1){v3Viewer.startX=e.clientX-v3Viewer.x;v3Viewer.startY=e.clientY-v3Viewer.y;v3Viewer.swipeStartX=e.clientX;v3Viewer.swipeStartY=e.clientY;}if(v3Viewer.pointers.size===2){const p=[...v3Viewer.pointers.values()];v3Viewer.startDist=Math.hypot(p[0].x-p[1].x,p[0].y-p[1].y);v3Viewer.startScale=v3Viewer.scale;}});st.addEventListener('pointermove',e=>{if(!v3Viewer.pointers.has(e.pointerId))return;v3Viewer.pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});if(v3Viewer.pointers.size===2){const p=[...v3Viewer.pointers.values()],d=Math.hypot(p[0].x-p[1].x,p[0].y-p[1].y);v3Viewer.scale=Math.max(1,Math.min(6,v3Viewer.startScale*d/(v3Viewer.startDist||d)));v3ViewerApply();}else if(v3Viewer.scale>1){v3Viewer.x=e.clientX-v3Viewer.startX;v3Viewer.y=e.clientY-v3Viewer.startY;v3ViewerApply();}});const up=e=>{const wasSingle=v3Viewer.pointers.size===1;const dx=e.clientX-(v3Viewer.swipeStartX||e.clientX),dy=e.clientY-(v3Viewer.swipeStartY||e.clientY);v3Viewer.pointers.delete(e.pointerId);if(wasSingle&&v3Viewer.scale===1&&Math.abs(dx)>70&&Math.abs(dx)>Math.abs(dy)*1.25)v3ViewerMove(dx<0?1:-1);};st.addEventListener('pointerup',up);st.addEventListener('pointercancel',e=>v3Viewer.pointers.delete(e.pointerId));st.addEventListener('click',e=>{if(e.target!==v3Viewer.img)return;const n=Date.now();if(n-v3Viewer.lastTap<320){if(v3Viewer.scale===1)v3Viewer.scale=2.5;else v3ViewerReset();v3ViewerApply();}v3Viewer.lastTap=n;});await v3ViewerSetPhoto(photo);}
async function v3DecoratePhotos(){const imgs=[...screenEl.querySelectorAll('img')].filter(i=>!i.classList.contains('notebook-cover-mini')&&!i.closest('#v3PhotoViewer'));for(const img of imgs){if(img.dataset.v3Decorated)continue;const p=await v3PhotoFromImage(img);if(!p)continue;img.dataset.v3Decorated='1';img.dataset.photoId=p.id;const host=img.parentElement;if(!host)continue;if(getComputedStyle(host).position==='static')host.style.position='relative';const badge=document.createElement('span');badge.className='v3-photo-status';badge.style.cssText='position:absolute;right:5px;bottom:5px;background:#000b;color:#fff;border-radius:999px;padding:3px 6px;font-size:11px;z-index:3;pointer-events:none;';let local=!!(await v3LocalPhotoBlob(p)),cloud=!!(p.server_id||p.telegram_file_id||p.storage_object_id),q=null;try{q=(await getAll('sync_queue')).find(x=>String(JSON.stringify(x)).includes(String(p.id)));}catch(_){}badge.textContent=q&&q.status==='failed'?'⚠️':q&&q.status==='pending'?'⏳':cloud&&local?'📱☁️':cloud?'☁️':'📱';host.appendChild(badge);}}
document.addEventListener('click',async e=>{const img=e.target.closest&&e.target.closest('img');if(!img||img.classList.contains('notebook-cover-mini')||img.closest('#v3PhotoViewer'))return;const p=await v3PhotoFromImage(img);if(!p)return;e.preventDefault();e.stopPropagation();const sp=p.spread_id?await get('spreads',p.spread_id):null;if(sp)v3RememberSpread(sp);await v3OpenViewer(p);},true);
function v3PromoteExactSearch(input){const q=String(input.value||'').trim();if(!/^\d+$/.test(q))return;setTimeout(()=>{const candidates=[...screenEl.querySelectorAll('.spread-card,.card,[data-spread-id]')].filter(el=>!el.closest('#v3RecentBlock'));for(const el of candidates){const text=(el.textContent||'').replace(/\s+/g,' '),exact=new RegExp(`(?:^|\\s|№)${q}(?:\\s|$|[.:—-])`).test(text);if(exact){el.style.order='-100';el.dataset.v3Exact='1';}else{el.style.order='';delete el.dataset.v3Exact;}}},20);}
document.addEventListener('input',e=>{const i=e.target;if(i instanceof HTMLInputElement&&(i.type==='search'||/поиск|пошук/i.test(i.placeholder||'')))v3PromoteExactSearch(i);},true);
async function v3CropPageFile(file,orientation){const bm=await createImageBitmap(file),ratio=orientation==='landscape'?1.414:1/1.414;let sw=bm.width,sh=bm.height,sx=0,sy=0;if(sw/sh>ratio){sw=Math.round(sh*ratio);sx=Math.round((bm.width-sw)/2);}else{sh=Math.round(sw/ratio);sy=Math.round((bm.height-sh)/2);}const max=2200,tw=orientation==='landscape'?max:Math.round(max*ratio),th=orientation==='landscape'?Math.round(max/ratio):max,c=document.createElement('canvas');c.width=tw;c.height=th;c.getContext('2d').drawImage(bm,sx,sy,sw,sh,0,0,tw,th);if(bm.close)bm.close();const blob=await new Promise((res,rej)=>c.toBlob(b=>b?res(b):rej(new Error('crop failed')),'image/jpeg',.9));return new File([blob],file.name.replace(/\.[^.]+$/, '')+'_crop.jpg',{type:'image/jpeg',lastModified:Date.now()});}
function v3ChoosePageCapture(originalInput){const {close}=openSheet(`<div class="sheet-handle"></div><h2>Сфотографировать страницу</h2><p style="color:var(--muted);margin-top:0">Выберите рамку страницы. Всё за рамкой будет обрезано.</p><div style="display:grid;gap:10px"><button id="v3Portrait" class="btn-primary">▯ Вертикальная страница</button><button id="v3Landscape" class="btn-secondary">▭ Горизонтальная страница</button><button id="v3Gallery" class="btn-secondary">🖼 Галерея без обрезки</button></div>`);const run=async(orientation,capture)=>{close();const temp=document.createElement('input');temp.type='file';temp.accept='image/*';temp.dataset.v3InternalPicker='1';if(capture)temp.setAttribute('capture','environment');temp.style.display='none';document.body.appendChild(temp);temp.onchange=async()=>{let f=temp.files&&temp.files[0];temp.remove();if(!f)return;if(orientation)f=await v3CropPageFile(f,orientation);const dt=new DataTransfer();dt.items.add(f);originalInput.files=dt.files;originalInput.dispatchEvent(new Event('change',{bubbles:true}));};temp.click();};document.getElementById('v3Portrait').onclick=()=>run('portrait',true);document.getElementById('v3Landscape').onclick=()=>run('landscape',true);document.getElementById('v3Gallery').onclick=()=>run(null,false);}
document.addEventListener('click',e=>{const input=e.target;if(!(input instanceof HTMLInputElement)||input.type!=='file'||!String(input.accept||'').includes('image'))return;if(input.dataset.v3CoverPicker||input.dataset.v3InternalPicker)return;e.preventDefault();e.stopPropagation();v3ChoosePageCapture(input);},true);
let v3DecorateTimer=null;const v3Observer=new MutationObserver(()=>{clearTimeout(v3DecorateTimer);v3DecorateTimer=setTimeout(()=>{v3DecoratePhotos().catch(()=>{});v3RenderRecentsIfUseful().catch(()=>{});},80);});v3Observer.observe(screenEl,{childList:true,subtree:true});setTimeout(()=>{v3DecoratePhotos().catch(()=>{});v3RenderRecentsIfUseful().catch(()=>{});},200);
