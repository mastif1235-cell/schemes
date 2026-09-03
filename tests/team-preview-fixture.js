(async function fixtureInit(){
  const results=[];
  const check=(name,ok)=>{results.push((ok?'PASS ':'FAIL ')+name);if(!ok)throw new Error(name);};
  try {
    await fixtureV2Open();
    await put('notebooks',{id:'nb',server_id:'remote-nb',title:'Тестовый блокнот',description:'keep',sort_order:0,revision:1});
    for(let i=1;i<=3;i++)await put('spreads',{id:'s'+i,server_id:'remote-s'+i,notebook_id:'nb',number:i,title:'Разворот '+i,
      status:'Актуально',revision:1,note_short:'Старое примечание',note_full:'Старый текст сохранён',current_photo_id:null});
    await put('blobs',{id:'fixture-original',blob:new Blob(['original'])});
    db.close();await openDB();await loadSettings();
    check('IndexedDB v2 → v3: original preserved',db.version===3&&(await get('blobs','fixture-original')).blob.size===8);
    db.close();await openDB();check('Reopen v3',db.version===3);
    const before=(await getAll('sync_queue')).length;
    try{await window.vNextAtomic('spreads','s1',row=>({row:{...row,title:'bad'},item:{entity:'test',bad:()=>{}}}));}catch(error){console.info('Expected fixture transaction abort',error.message);}
    check('Atomic IDB rollback',(await get('spreads','s1')).title==='Разворот 1'&&(await getAll('sync_queue')).length===before);
    settings.backend_url=location.origin;settings.auth_token='fixture-only';settings.user_id='u1';settings.user_display_name='Артём';
    settings.team_capabilities={scope:window.vNextSync.scope(),flags:{team_notes:true,activity:true,field_merge:true,spread_order:true}};
    fullSync=async()=>{};
    await window.vNextSync.saveNote(await get('spreads','s1'),'Тестовое примечание');
    check('Note + outbox persisted',(await getAll('spread_notes')).length===1&&(await getAll('sync_queue')).length===1);
    const old=await get('spreads','s1');await put('spreads',{...old,title:'Текст с телефона B'});
    const canvas=document.createElement('canvas');canvas.width=64;canvas.height=32;canvas.getContext('2d').fillRect(0,0,64,32);
    const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
    await attachPhoto(old,new File([blob],'fixture.png',{type:'image/png'}));
    check('Photo preserves independently edited text',(await get('spreads','s1')).title==='Текст с телефона B');
    check('Photo does not queue stale metadata PATCH',!(await getAll('sync_queue')).some(row=>row.entity==='spread'));
    api=async(path,options={})=>{
      if(path.endsWith('/notes')&&options.method==='POST')return{note:{...options.json,spread_id:'remote-s1',author_id:'u1',author_display_name:'Артём',revision:1,created_at:nowISO()}};
      if(path.startsWith('/api/notes/'))return{note:{...options.json,id:path.split('/').pop(),spread_id:'remote-s1',author_id:'u1',author_display_name:'Артём',revision:2,created_at:nowISO(),deleted_at:options.method==='DELETE'?nowISO():null}};
      if(path.includes('/activity'))return{events:[{id:'fixture-event',notebook_id:'remote-nb',spread_id:'remote-s1',actor:{id:'u2',display_name:'Петя'},action:'note.updated',old_value:{body:'Было'},new_value:{body:'Стало'},created_at:nowISO(),seq:7}],legacy_events:[],has_more:false,next_before_seq:7};
      if(options.method==='PATCH'&&path.startsWith('/api/spreads/')){const sp=(await getAll('spreads')).find(row=>row.server_id===path.split('/').pop());return{spread:{...sp,...options.json.changes,id:sp.server_id,revision:sp.revision+1}};}
      if(path.endsWith('/spreads/order'))return{spreads:await Promise.all(options.json.items.map(async(item,index)=>({...await get('spreads',item.spread_id.replace('remote-','')),id:item.spread_id,notebook_id:'remote-nb',number:index+1,revision:item.expected_revision+1})))};
      throw new Error('Fixture endpoint not supported: '+path);
    };
    await pushEntityQueue(false);check('Note confirmed',(await getAll('spread_notes'))[0].pending===false);
    const conflictNote=(await getAll('spread_notes'))[0];
    const conflictItem=(await getAll('sync_queue')).find(item=>item.entity==='spread_note');
    await put('spread_notes',{...conflictNote,pending:true,sync_error:'fixture conflict'});
    await put('sync_queue',{...conflictItem,status:'conflict',method:'PATCH',conflicts:{server_note:{id:conflictNote.id,body:'other phone',revision:3,deleted_at:null}}});
    await window.vNextSync.resolveNote(conflictNote,'mine','Разрешённый конфликт примечания');
    check('Note conflict resolution creates a new outbox entry',(await getAll('sync_queue')).filter(item=>item.entity==='spread_note').length===2);
    await pushEntityQueue(false);
    check('Resolved note confirmed',(await getAll('spread_notes'))[0].body==='Разрешённый конфликт примечания'&&!(await getAll('spread_notes'))[0].pending);
    await window.vNextSync.applyTeamChanges({spread_notes:[{id:'second',spread_id:'remote-s1',author_id:'u2',author_display_name:'Петя',body:'Примечание другого участника',revision:1,created_at:nowISO()}]});
    fullSync=async()=>{await pushEntityQueue(true);window.BlocknotV3.emit('sync-complete');};
    route={screen:'spreads',notebookId:'nb'};await render();
  }catch(error){results.push('ERROR '+error.stack);console.error(error);}
  const report=document.createElement('details');report.open=true;report.style='position:relative;background:#fff;color:#111;padding:12px;z-index:10000';
  const summary=document.createElement('summary');summary.textContent='LOCAL FIXTURE TEST RESULTS — production untouched';report.appendChild(summary);
  const pre=document.createElement('pre');pre.textContent=results.join('\n');report.appendChild(pre);document.body.prepend(report);
})();
