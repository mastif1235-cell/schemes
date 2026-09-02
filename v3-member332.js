/* Blocknot Scan v3.3.2: robust notebook action sheet for owner/member phones. */
(function(){
  function v332ToastError(prefix,e){
    const s=String((e&&e.message)||e||'');
    if(/403|forbidden|owner|permission|not_allowed/i.test(s)) toast('Это действие доступно только владельцу блокнота');
    else toast(prefix + (s?': '+s:''));
  }

  /* Use one delegated handler inside the sheet. This avoids duplicate global IDs and
     touch/long-press handlers swallowing individual button taps on some Android browsers. */
  openNotebookActions = function(nb) {
    const body = `<div class="sheet-handle"></div><h2>${esc(nb.title)}</h2>
      <div id="v332NotebookActions" style="display:grid;gap:10px">
        <button type="button" class="btn-secondary" data-v332-action="edit">✏️ Редактировать блокнот</button>
        <button type="button" class="btn-secondary" data-v332-action="cover">📷 Обложка</button>
        <button type="button" class="btn-secondary" data-v332-action="partner">👥 Добавить напарника</button>
        <button type="button" class="btn-secondary" data-v332-action="history">🕘 История</button>
      </div>`;
    const sheet = openSheet(body);
    const close = sheet && sheet.close ? sheet.close : function(){};
    const host = document.getElementById('v332NotebookActions');
    if (!host) return;

    for (const b of host.querySelectorAll('button')) {
      b.style.touchAction='manipulation';
      b.style.pointerEvents='auto';
      b.style.position='relative';
      b.style.zIndex='2';
    }

    host.addEventListener('pointerdown', e => e.stopPropagation());
    host.addEventListener('touchstart', e => e.stopPropagation(), {passive:true});
    host.addEventListener('click', async e => {
      const btn=e.target.closest('button[data-v332-action]');
      if(!btn) return;
      e.preventDefault();
      e.stopPropagation();
      if(btn.disabled) return;
      const action=btn.dataset.v332Action;
      btn.disabled=true;
      try {
        if(action==='edit') {
          close();
          return openNotebookEditorV2(nb);
        }
        if(action==='cover') {
          close();
          return await openNotebookCover(nb);
        }
        if(action==='history') {
          close();
          return await openNotebookHistory(nb);
        }
        if(action==='partner') {
          /* Backend remains authority for owner-only invite permissions. */
          try {
            close();
            return await openNotebookPartner(nb);
          } catch(err) {
            v332ToastError('Не удалось добавить напарника',err);
          }
        }
      } catch(err) {
        v332ToastError('Не удалось выполнить действие',err);
      } finally {
        btn.disabled=false;
      }
    });
  };

  /* Keep the long-press entry point routed through the robust action sheet. */
  openNotebookEditor = function(nb) {
    return nb ? openNotebookActions(nb) : openNotebookEditorV2(nb);
  };
})();
