/* Blocknot Scan v3.4.0: data-safe queue, conflict preservation and shared photo mapping. */
(function () {
  const RETRY_BASE_MS = 15000;
  const RETRY_MAX_MS = 5 * 60 * 1000;
  const UNSYNCED = new Set(['pending', 'syncing', 'failed', 'conflict']);
  const FIELD_NAMES = ['number', 'title', 'status', 'note_short', 'note_full'];
  const scope = () => settings.backend_url.replace(/\/$/, '') + '|' + (settings.user_id || '');
  const metadata = row => Object.fromEntries(FIELD_NAMES.map(key => [key, row[key] ?? (key === 'number' ? 0 : '')]));
  const enabled = name => settings.team_capabilities?.scope === scope() && settings.team_capabilities.flags?.[name] === true;
  const assertScope = expected => { if (expected !== scope()) throw new Error('Аккаунт изменился; повторите синхронизацию'); };
  const recoveringNotebooks = new Set();
  let refreshRequested = false;
  function requestRemoteRefresh() {
    if (!isOnline() || !isAuthed()) return;
    if (syncing) { refreshRequested = true; return; }
    void fullSync();
  }

  async function diagnostics() {
    const queue = (await getAll('sync_queue')).filter(item => UNSYNCED.has(item.status));
    const errors = settings.sync_errors || [];
    const conflict = queue.find(item => item.status === 'conflict');
    const failed = queue.find(item => item.status === 'failed');
    const coverPending = (await getAll('notebooks')).some(row => row.cover_retry);
    const name = item => ({spread_note:'note', photo:'photos', notebook_cover:'covers', spread_fields:'spread'})[item.entity] || item.entity;
    const label = !isOnline() ? 'Нет сети' : syncing ? 'Синхронизация…' : conflict ? 'Конфликт: ' + name(conflict)
      : errors.length ? 'Ошибка: ' + errors.map(row => row.stage).join(', ')
      : failed ? 'Ошибка: ' + name(failed) : coverPending ? 'Ожидает загрузки: covers'
      : queue.length ? 'Ожидает отправки: ' + queue.length : settings.sync_status === 'error' ? 'Ошибка синхронизации' : 'Синхронизировано';
    return {label, pending:queue.length, conflicts:queue.filter(item => item.status === 'conflict').length,
      notebookConflicts:queue.filter(item => item.entity === 'notebook' && item.status === 'conflict').length,
      failed:queue.filter(item => item.status === 'failed').length, errors, coverPending};
  }

  function diagnosticScope(item) {
    return String(item.scope || '(legacy: scope отсутствует)');
  }

  function conflictGroupKey(item) {
    return [diagnosticScope(item), String(item.entity || ''), String(item.local_id || item.photo_id || '')].join('\n');
  }

  function selectedFields(value) {
    if (!value || typeof value !== 'object') return null;
    const selected = {};
    for (const key of FIELD_NAMES) if (Object.hasOwn(value, key)) selected[key] = value[key];
    return Object.keys(selected).length ? selected : null;
  }

  function storedServerCopy(item) {
    return item.server_copy || item.conflicts?.server_copy || item.conflicts?.server_note || null;
  }

  function storedConflicts(item) {
    const source = item.conflicts?.conflicts || item.conflicts;
    if (!source || typeof source !== 'object') return null;
    if (item.entity === 'spread_fields') {
      const result = {};
      for (const key of FIELD_NAMES) {
        const conflict = source[key];
        if (conflict && typeof conflict === 'object') {
          result[key] = {base:conflict.base, mine:conflict.mine, server:conflict.server};
        }
      }
      return Object.keys(result).length ? result : null;
    }
    if (item.entity === 'spread_note' && item.conflicts?.server_note) {
      const note = item.conflicts.server_note;
      return {server_note:{id:note.id, revision:note.revision, body:note.body,
        deleted_at:note.deleted_at || null, updated_at:note.updated_at || null}};
    }
    return null;
  }

  function conflictReason(entity, items) {
    if (entity === 'spread_fields') {
      const fields = new Set();
      for (const item of items) for (const key of Object.keys(storedConflicts(item) || {})) fields.add(key);
      return fields.size
        ? `Поля ${[...fields].join(', ')} отличаются от сохранённой базы и локального значения.`
        : 'Сервер отклонил field merge; подробности ответа не сохранены.';
    }
    if (entity === 'spread') return 'Legacy PATCH использовал устаревшую revision. Кнопка «Повторить» conflict-записи не отправляет.';
    if (entity === 'spread_note') return 'Revision примечания изменилась на другом устройстве.';
    return items.find(item => item.last_error)?.last_error || 'Сервер вернул конфликт; автоматический retry отключён.';
  }

  async function conflictGroups() {
    const conflicts = (await getAll('sync_queue')).filter(item => item.status === 'conflict');
    const grouped = new Map();
    for (const item of conflicts) {
      const key = conflictGroupKey(item);
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(item);
    }
    const groups = [];
    for (const [key, items] of grouped) {
      const first = items[0];
      let spread = null;
      if (first.entity === 'spread' || first.entity === 'spread_fields') spread = await get('spreads', first.local_id);
      else if (first.spread_id) spread = await get('spreads', first.spread_id);
      else if (first.photo_id) {
        const photo = await get('photos', first.photo_id);
        if (photo?.spread_id) spread = await get('spreads', photo.spread_id);
      }
      const storedServer = [...items].reverse().map(storedServerCopy).find(Boolean) || null;
      groups.push({
        key,
        scope:diagnosticScope(first),
        entity:first.entity || '(не указан)',
        localId:first.local_id || first.photo_id || '(не указан)',
        kind:first.entity === 'spread' ? 'legacy spread' : first.entity === 'spread_fields' ? 'spread_fields' : first.entity || 'unknown',
        spread:spread ? {id:spread.id, server_id:spread.server_id || null, number:spread.number,
          title:spread.title || '', revision:spread.revision, values:metadata(spread)} : null,
        server:storedServer ? {id:storedServer.id || null, revision:storedServer.revision,
          deleted_at:storedServer.deleted_at || null, values:selectedFields(storedServer)} : null,
        reason:conflictReason(first.entity, items),
        items:items.sort((a,b) => Number(a.id || 0) - Number(b.id || 0)).map(item => ({
          id:item.id,
          status:item.status,
          retry_count:Number(item.retry_count || 0),
          last_error:item.last_error || null,
          method_or_op:item.method || item.op || item.payload?.op || null,
          revision:item.payload?.revision ?? null,
          base_revision:item.payload?.base_revision ?? null,
          changes:selectedFields(item.payload?.changes),
          base_values:selectedFields(item.payload?.base_values),
          server_conflicts:storedConflicts(item),
          server_copy:storedServerCopy(item) ? {
            id:storedServerCopy(item).id || null,
            revision:storedServerCopy(item).revision,
            deleted_at:storedServerCopy(item).deleted_at || null,
            values:selectedFields(storedServerCopy(item))
          } : null
        }))
      });
    }
    return groups.sort((a,b) => a.kind.localeCompare(b.kind) || String(a.spread?.number ?? '').localeCompare(String(b.spread?.number ?? '')));
  }

  function sameSpreadValues(left, right) {
    return JSON.stringify(metadata(left)) === JSON.stringify(metadata(right));
  }

  function completeSpreadServerCopy(server, expectedId) {
    return !!server && server.id === expectedId && Number.isFinite(Number(server.revision))
      && Number(server.revision) > 0 && FIELD_NAMES.every(key => Object.hasOwn(server, key));
  }

  async function assessLegacySpreadConflict(groupOrKey) {
    const requestedKey = typeof groupOrKey === 'string' ? groupOrKey : groupOrKey?.key;
    const group = (await conflictGroups()).find(item => item.key === requestedKey);
    if (!group || group.entity !== 'spread') return {safe:false, reason:'not_legacy_spread'};
    if (group.scope !== '(legacy: scope отсутствует)') return {safe:false, reason:'not_unscoped_legacy'};
    if (!group.items.length || group.items.some(item => item.status !== 'conflict' || item.method_or_op === 'delete')) {
      return {safe:false, reason:'unsupported_group'};
    }
    const local = await get('spreads', group.localId);
    if (!local?.server_id || local.deleted_at) return {safe:false, reason:'local_spread_unavailable'};
    if (!isOnline() || !isAuthed()) return {safe:false, reason:'server_check_unavailable'};
    const expectedScope = scope();
    const response = await api(`/api/spreads/${encodeURIComponent(local.server_id)}`);
    assertScope(expectedScope);
    const server = response?.spread;
    if (!completeSpreadServerCopy(server, local.server_id)) {
      return {safe:false, reason:'server_data_unavailable', server:null};
    }
    const safe = sameSpreadValues(local, server);
    return {safe, reason:safe ? 'server_equals_local' : 'values_differ',
      server:{id:server.id, revision:Number(server.revision), values:metadata(server)}};
  }

  async function safeLegacySpreadConflictAssessments(groups = null) {
    const source = groups || await conflictGroups();
    const result = new Map();
    for (const group of source.filter(item => item.entity === 'spread')) {
      try { result.set(group.key, await assessLegacySpreadConflict(group)); }
      catch (error) {
        console.warn('Legacy spread conflict check failed', error);
        result.set(group.key, {safe:false, reason:'server_check_failed'});
      }
    }
    return result;
  }

  // Explicit user action only. One fresh GET proves equality before queue rows are retired.
  // No PATCH is sent and the spread, photos and current_photo_id are not written.
  async function safeResolveDuplicateSpreadConflicts(groupOrKey) {
    const requestedKey = typeof groupOrKey === 'string' ? groupOrKey : groupOrKey?.key;
    const group = (await conflictGroups()).find(item => item.key === requestedKey);
    const assessment = await assessLegacySpreadConflict(group);
    if (!assessment.safe) return {resolved:false, reason:assessment.reason};
    const server = assessment.server;
    const queue = await getAll('sync_queue');
    const ids = new Set(group.items.map(item => item.id));
    const currentItems = queue.filter(item => ids.has(item.id));
    if (currentItems.length !== ids.size || currentItems.some(item => item.status !== 'conflict' || conflictGroupKey(item) !== group.key)) {
      return {resolved:false, reason:'group_changed'};
    }
    await window.vNextAtomic('spreads', group.localId, current => {
      if (!current || current.server_id !== server.id || !sameSpreadValues(current, server.values)) throw new Error('Конфликт изменился; ничего не закрыто');
      return {
        retired:currentItems.map(item => ({...item, status:'done', next_attempt_at:null,
          retired_at:nowISO(), retired_reason:'server already equals local business fields',
          retired_previous_error:item.last_error || null, last_error:null}))
      };
    });
    return {resolved:true, count:currentItems.length};
  }

  async function openConflictDiagnostics() {
    const groups = await conflictGroups();
    const assessments = await safeLegacySpreadConflictAssessments(groups);
    const safe = groups.filter(group => assessments.get(group.key)?.safe);
    const {el,close} = openSheet(`<div class="sheet-handle"></div><h2>Диагностика конфликтов</h2>
      <p class="warn-box">Только чтение. Записи со статусом conflict не повторяются кнопкой «Повторить».</p>
      <p class="v340-caption">Просмотр не запускает синхронизацию и не отправляет PATCH. Очередь меняется только после явного нажатия безопасной очистки.</p>
      ${safe.length ? `<button class="btn-secondary" data-safe-conflict-cleanup>Очистить безопасные старые конфликты (${safe.reduce((sum,group) => sum + group.items.length,0)})</button>` : ''}
      <div data-conflict-diagnostics></div>`);
    const host = el.querySelector('[data-conflict-diagnostics]');
    if (!groups.length) { host.innerHTML = '<div class="empty-state">Конфликтов в очереди нет.</div>'; return; }
    for (const group of groups) {
      const card = document.createElement('article');
      card.className = 'v350-conflict-diagnostic';
      const local = group.spread ? group.spread.values : null;
      const assessment = assessments.get(group.key);
      const serverValues = assessment?.server?.values || group.server?.values || group.items.map(item => item.server_conflicts).filter(Boolean);
      const resolution = assessment?.safe ? 'Сервер уже равен телефону. Эту legacy-группу можно безопасно закрыть без отправки.'
        : assessment?.reason === 'values_differ' ? 'Значения отличаются. Конфликт останется до ручного выбора.'
        : assessment?.reason === 'server_data_unavailable' ? 'Нет достоверной server revision или полного набора полей. Автоочистка запрещена.'
        : assessment?.reason === 'not_unscoped_legacy' ? 'Запись содержит scope и не считается старой legacy-записью.'
        : assessment ? 'Безопасность не доказана. Конфликт останется без изменений.' : '';
      card.innerHTML = `<h3>${esc(group.kind)} · ${group.items.length > 1 ? `${group.items.length} дублей` : '1 запись'}</h3>
        <p><strong>Разворот:</strong> ${esc(group.spread ? `№${group.spread.number} ${group.spread.title || ''}` : 'не определён')}</p>
        <p><strong>local_id:</strong> <code>${esc(group.localId)}</code></p>
        <p><strong>scope:</strong> <code>${esc(group.scope)}</code></p>
        <p><strong>Причина:</strong> ${esc(group.reason)}</p>
        ${resolution ? `<p><strong>Решение:</strong> ${esc(resolution)}</p>` : ''}
        <details open><summary>Локально · revision ${esc(group.spread?.revision ?? '—')}</summary><pre>${esc(JSON.stringify(local, null, 2))}</pre></details>
        <details open><summary>С сервера · revision ${esc(assessment?.server?.revision ?? group.server?.revision ?? '—')}</summary><pre>${esc(JSON.stringify(serverValues, null, 2))}</pre></details>
        <details><summary>Queue items: ${group.items.map(item => '#' + item.id).join(', ')}</summary><pre>${esc(JSON.stringify(group.items, null, 2))}</pre></details>`;
      host.appendChild(card);
    }
    el.querySelector('[data-safe-conflict-cleanup]')?.addEventListener('click', async event => {
      event.target.disabled = true;
      let retired = 0;
      for (const group of safe) {
        try {
          const result = await safeResolveDuplicateSpreadConflicts(group.key);
          if (result.resolved) retired += result.count;
        } catch (error) { console.warn('Safe legacy conflict cleanup stopped for one group', error); }
      }
      close();
      await updateSyncIndicator();
      toast(retired ? `Безопасно закрыто старых конфликтов: ${retired}` : 'Конфликты изменились; ничего не закрыто');
    });
  }

  function notebookValues(row) {
    return {title:String(row?.title || ''), description:String(row?.description || ''), archived:!!row?.archived};
  }

  function sameNotebookValues(left, right) {
    return JSON.stringify(notebookValues(left)) === JSON.stringify(notebookValues(right));
  }

  async function notebookConflictGroups(refresh = true) {
    const queue = await getAll('sync_queue');
    const conflicts = queue.filter(item => item.entity === 'notebook' && (!item.scope || item.scope === scope()) && item.status === 'conflict');
    const groups = [];
    for (const localId of new Set(conflicts.map(item => item.local_id))) {
      const items = conflicts.filter(item => item.local_id === localId);
      const local = await get('notebooks', localId);
      let server = items.find(item => item.server_copy)?.server_copy || null;
      if (refresh && local?.server_id && isOnline()) {
        try { server = (await api(`/api/notebooks/${encodeURIComponent(local.server_id)}`)).notebook || server; }
        catch (error) { console.warn('Notebook conflict refresh failed', error); }
      }
      groups.push({localId, local, server, items});
    }
    return groups;
  }

  async function resolveNotebookConflict(group, choice) {
    if (!group?.local || !group?.server || !group.items?.length) throw new Error('Версии блокнота недоступны');
    const server = group.server;
    const sorted = [...group.items].sort((a,b) => Number(a.id || 0) - Number(b.id || 0));
    await window.vNextAtomic('notebooks', group.localId, current => {
      if (!current) throw new Error('Локальный блокнот не найден');
      const row = choice === 'server'
        ? {...current, ...notebookValues(server), revision:server.revision, updated_at:server.updated_at, conflict:null}
        : {...current, revision:server.revision, conflict:null};
      const keep = sorted[sorted.length - 1];
      const retired = sorted.map(item => choice === 'local' && item.id === keep.id
        ? {...item, scope:scope(), status:'pending', retry_count:0, last_error:null, next_attempt_at:null, server_copy:null}
        : {...item, status:'done', last_error:'superseded by notebook conflict resolution', server_copy:null});
      return {row, retired};
    });
    return choice === 'local';
  }

  async function reconcileNotebookConflicts() {
    let resolved = 0;
    for (const group of await notebookConflictGroups(true)) {
      if (!group.local) {
        for (const item of group.items) await put('sync_queue', {...item,status:'done',last_error:'local notebook no longer exists'});
        resolved += group.items.length;
      } else if (group.server && sameNotebookValues(group.local, group.server)) {
        await resolveNotebookConflict(group, 'server');
        resolved += group.items.length;
      }
    }
    return resolved;
  }

  async function openNotebookConflicts() {
    await reconcileNotebookConflicts();
    const groups = (await notebookConflictGroups(true)).filter(group => group.local && group.server);
    if (!groups.length) { toast('Конфликты блокнотов разрешены'); await updateSyncIndicator(); return; }
    const {el,close} = openSheet(`<div class="sheet-handle"></div><h2>Конфликты блокнотов</h2>
      <p class="v340-caption">Выберите итоговую версию. Все старые дубли этого блокнота будут закрыты.</p><div data-notebook-conflicts></div>`);
    const host = el.querySelector('[data-notebook-conflicts]');
    for (const group of groups) {
      const card = document.createElement('article'); card.className = 'v340-notebook-conflict';
      card.innerHTML = `<h3>${esc(group.local.title || group.server.title || 'Блокнот')}</h3>
        <div class="v340-conflict-compare"><div><strong>На телефоне</strong><p>${esc(group.local.title || '')}</p><small>${esc(group.local.description || 'Без описания')}</small></div>
        <div><strong>На сервере</strong><p>${esc(group.server.title || '')}</p><small>${esc(group.server.description || 'Без описания')}</small></div></div>
        <p class="v340-caption">Старых записей: ${group.items.length}. Ревизии: телефон ${esc(group.local.revision ?? '—')}, сервер ${esc(group.server.revision ?? '—')}.</p>
        <div class="btn-row"><button class="btn-secondary" data-choice="server">Версия сервера</button><button class="btn-primary" data-choice="local">Версия телефона</button></div>`;
      card.onclick = async event => {
        const button = event.target.closest('[data-choice]'); if (!button) return;
        card.querySelectorAll('button').forEach(item => { item.disabled = true; });
        try {
          const needsPush = await resolveNotebookConflict(group, button.dataset.choice);
          card.remove();
          if (needsPush) void fullSync(true);
          if (!host.children.length) { close(); toast('Конфликты блокнотов разрешены'); }
          await updateSyncIndicator();
        } catch (error) { toast(error.message); card.querySelectorAll('button').forEach(item => { item.disabled = false; }); }
      };
      host.appendChild(card);
    }
  }

  updateSyncIndicator = async function () {
    const el = document.getElementById('syncDot');
    if (!el) return;
    const state = await diagnostics();
    el.textContent = !isOnline() ? '—' : syncing ? '⟳' : state.conflicts || state.failed || state.errors.length || settings.sync_status === 'error' ? '⚠'
      : state.pending || state.coverPending ? '↑' : '✓';
    el.title = state.label;
    el.setAttribute('aria-label', state.label);
    el.setAttribute('role', 'button'); el.tabIndex = 0; el.style.cursor = 'pointer';
    el.onclick = async () => {
      const fresh = await diagnostics();
      const {el:sheet, close} = openSheet(`<div class="sheet-handle"></div><h2>Синхронизация</h2>
        <p data-sync-diagnostic>${esc(fresh.label)}</p><p>Ожидает отправки: ${fresh.pending}. Конфликтов: ${fresh.conflicts}.</p>
        ${fresh.notebookConflicts ? '<button class="btn-secondary" data-notebook-conflicts>Разобрать конфликты блокнотов</button>' : ''}
        ${fresh.conflicts ? '<button class="btn-secondary" data-conflict-diagnostics>Показать конфликты</button>' : ''}
        <button class="btn-primary" data-sync-retry>Повторить</button>`);
      sheet.querySelector('[data-sync-retry]').onclick = () => { close(); void fullSync(true); };
      sheet.querySelector('[data-notebook-conflicts]')?.addEventListener('click', () => { close(); void openNotebookConflicts(); });
      sheet.querySelector('[data-conflict-diagnostics]')?.addEventListener('click', () => { close(); void openConflictDiagnostics(); });
    };
    el.onkeydown = event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); el.click(); } };
  };

  async function cacheNote(note, localSpread, force = false) {
    const cache_id = scope() + '|' + note.id;
    const local = await get('spread_notes', cache_id);
    if (!force && local?.pending) return;
    await window.vNextAtomic('spread_notes',cache_id,current => ({row:!force && current?.pending ? current :
      {...current, ...note, cache_id, scope:scope(), server_id:note.id,
      server_spread_id:note.spread_id, spread_id:localSpread.id, notebook_id:localSpread.notebook_id, pending:false, sync_error:null}}));
  }

  async function applyTeamChanges(changes) {
    let spreads = await getAll('spreads');
    for (const note of changes.spread_notes || []) {
      let spread = spreads.find(row => row.server_id === note.spread_id);
      if (!spread && note.notebook_id && !recoveringNotebooks.has(note.notebook_id)) {
        // A parent's newest seq can be later than its child's page. Recover the scoped
        // snapshot instead of permanently retrying the same page or skipping the child.
        recoveringNotebooks.add(note.notebook_id);
        try { await applySnapshot(note.notebook_id); }
        finally { recoveringNotebooks.delete(note.notebook_id); }
        spreads = await getAll('spreads'); spread = spreads.find(row => row.server_id === note.spread_id);
      }
      // Never advance the shared cursor past a child we could not persist.
      if (!spread) throw new Error('Примечание ожидает загрузки разворота');
      await cacheNote(note, spread);
    }
    for (const event of changes.activity_events || []) {
      const cache_id = scope() + '|' + event.id;
      await window.vNextAtomic('activity_events',cache_id,() => ({row:{...event, cache_id, scope:scope()}}));
    }
  }

  async function saveNote(spread, body, existing = null, remove = false) {
    if (!isAuthed() || !enabled('team_notes')) throw new Error('Примечания доступны после обновления сервера');
    if (!remove && (!body.trim() || body.trim().length > 10000)) throw new Error('Введите примечание до 10000 символов');
    const id = existing?.id || uid(), cache_id = scope() + '|' + id;
    await window.vNextAtomic('spread_notes', cache_id, current => {
      if (current?.pending) throw new Error('Сначала синхронизируйте предыдущее изменение примечания');
      if (existing && (!current || current.deleted_at)) throw new Error('Примечание недоступно');
      const now = nowISO();
      const row = {...current, id, cache_id, scope:scope(), spread_id:spread.id, notebook_id:spread.notebook_id,
        author_id:current?.author_id || settings.user_id,
        author_display_name:current?.author_display_name || settings.user_display_name,
        body:remove ? current.body : body.trim(), created_at:current?.created_at || now, updated_at:now,
        deleted_at:remove ? now : null, pending:true, sync_error:null};
      return {row, item:{entity:'spread_note', local_id:cache_id, scope:scope(), spread_id:spread.id,
        status:'pending', retry_count:0, method:remove ? 'DELETE' : existing ? 'PATCH' : 'POST',
        note_id:id, payload:{id, body:row.body, revision:current?.revision, client_ref:uid()}}};
    });
    void fullSync();
  }

  async function pushNote(item) {
    if (item.scope !== scope() || !enabled('team_notes')) return queueResult('deferred', 'waiting for account/server capability');
    const spread = await get('spreads', item.spread_id);
    if (!spread?.server_id) return queueResult('deferred', 'spread has no server id');
    const path = item.method === 'POST' ? `/api/spreads/${spread.server_id}/notes` : `/api/notes/${item.note_id}`;
    const data = await api(path, {method:item.method, json:item.payload});
    assertScope(item.scope);
    await cacheNote(data.note, spread, true);
    return queueResult('sent');
  }

  async function noteConflict(note) {
    return (await getAll('sync_queue')).find(item => item.entity === 'spread_note' && item.local_id === note.cache_id &&
      item.scope === scope() && item.status === 'conflict');
  }

  async function resolveNote(note, choice, body) {
    const previous = await noteConflict(note), server = previous?.conflicts?.server_note;
    if (!previous || !server) throw new Error('Нет доступной серверной версии; повторите синхронизацию');
    const {id: previousId, ...requeued} = previous;
    if (choice !== 'server' && server.deleted_at) throw new Error('Примечание удалено на сервере; новый текст можно добавить отдельным примечанием');
    if (choice !== 'server' && previous.method !== 'DELETE' && (!body.trim() || body.trim().length > 10000)) throw new Error('Введите примечание до 10000 символов');
    await window.vNextAtomic('spread_notes',note.cache_id,current => {
      if (!current?.pending) throw new Error('Конфликт уже разрешён');
      const row = {...current,body:choice === 'server' ? server.body : body.trim(),revision:server.revision,
        deleted_at:choice === 'server' ? server.deleted_at : previous.method === 'DELETE' ? nowISO() : null,
        updated_at:server.updated_at,pending:choice !== 'server',sync_error:null};
      return {row,retired:[{...previous,status:'done',last_error:'note conflict resolved explicitly'}],
        ...(choice === 'server' ? {} : {item:{...requeued,status:'pending',retry_count:0,last_error:null,conflicts:null,
          payload:{...previous.payload,body:row.body,revision:server.revision,client_ref:uid()}}})};
    });
    void fullSync();
  }

  async function saveFields(spread, changes, baseValues, retired = []) {
    if (!enabled('field_merge')) throw new Error('Обновите сервер перед редактированием');
    if (!Object.keys(changes).length) return;
    const pending = (await getAll('sync_queue')).filter(row => row.entity === 'spread_fields' && row.local_id === spread.id && UNSYNCED.has(row.status));
    if (pending.some(row => !retired.some(old => old.id === row.id))) throw new Error('Сначала синхронизируйте предыдущее изменение');
    await window.vNextAtomic('spreads', spread.id, current => {
      if (!current || current.deleted_at) throw new Error('Разворот недоступен');
      if (current.fields_pending && !retired.length) throw new Error('Предыдущее изменение ещё синхронизируется');
      const row = {...current, ...changes, field_conflicts:null, fields_pending:true};
      row.searchableText = normalize([row.number,row.title,row.note_short,row.note_full].join(' '));
      return {row, retired:retired.map(item => ({...item, status:'done', last_error:'resolved field conflict'})),
        item:{entity:'spread_fields', local_id:row.id, scope:scope(), status:'pending', retry_count:0,
          payload:{client_ref:uid(), changes, base_values:baseValues}}};
    });
    void fullSync();
  }

  async function pushFields(item) {
    if (item.scope !== scope() || !enabled('field_merge')) return queueResult('deferred', 'waiting for account/server capability');
    const spread = await get('spreads', item.local_id);
    if (!spread?.server_id) return queueResult('deferred', 'spread has no server id');
    const data = await api(`/api/spreads/${spread.server_id}`, {method:'PATCH', json:item.payload});
    assertScope(item.scope);
    const latest = await get('spreads', item.local_id);
    await put('spreads', {...latest, ...metadata(data.spread), revision:data.spread.revision,
      metadata_base:metadata(data.spread), field_conflicts:null, fields_pending:false});
    return queueResult('sent');
  }

  async function pushOrder(item) {
    if (item.scope !== scope() || !enabled('spread_order')) return queueResult('deferred', 'waiting for account/server capability');
    const notebook = await get('notebooks', item.local_id);
    if (!notebook?.server_id) return queueResult('deferred', 'notebook has no server id');
    const data = await api(`/api/notebooks/${notebook.server_id}/spreads/order`, {method:'PUT', json:item.payload});
    assertScope(item.scope);
    await applyChangeBatch({spreads:data.spreads});
    window.BlocknotV3?.emit('spread-order-saved',{notebookId:notebook.id});
    return queueResult('sent');
  }

  function queueResult(status, detail) {
    return {status, detail: detail || null};
  }

  function retryDelay(retryCount) {
    return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * Math.pow(2, Math.max(0, retryCount - 1)));
  }

  function retryDue(item, forceRetry) {
    if (item.status === 'pending') return true;
    if (item.status !== 'failed') return false;
    if (forceRetry) return true;
    const due = Date.parse(item.next_attempt_at || '');
    return !Number.isFinite(due) || due <= Date.now();
  }

  function markRetry(item, error) {
    item.status = 'failed';
    item.retry_count = (item.retry_count || 0) + 1;
    item.last_attempt_at = nowISO();
    item.next_attempt_at = new Date(Date.now() + retryDelay(item.retry_count)).toISOString();
    item.last_error = String(error && error.message ? error.message : error || 'sync failed').slice(0, 500);
  }

  function markDone(item) {
    item.status = 'done';
    item.last_error = null;
    item.next_attempt_at = null;
  }

  function mapServerPhoto(localPhoto, serverPhoto, localSpreadId) {
    return Object.assign(localPhoto, {
      server_id: serverPhoto.id,
      spread_id: localSpreadId,
      version: serverPhoto.version,
      is_current: !!serverPhoto.is_current,
      storage_object_id: serverPhoto.storage_object_id || null,
      telegram_message_id: serverPhoto.telegram_message_id || serverPhoto.message_id || null,
      telegram_file_id: serverPhoto.telegram_file_id || serverPhoto.file_id || null,
      telegram_file_unique_id: serverPhoto.telegram_file_unique_id || serverPhoto.file_unique_id || null,
      telegram_link: serverPhoto.telegram_link || localPhoto.telegram_link || null,
      mime_type: serverPhoto.mime_type,
      file_size: serverPhoto.file_size,
      upload_status: 'synced'
    });
  }

  async function queueHasUnsynced(queue, entity, localId) {
    return queue.some(item => item.entity === entity && item.local_id === localId && UNSYNCED.has(item.status));
  }

  pushNotebook = async function (item) {
    const nb = await get('notebooks', item.local_id);
    if (!nb) return queueResult('discarded', 'local notebook no longer exists');
    if (!nb.server_id) {
      const data = await api('/api/notebooks', {method:'POST', json:{title:nb.title, description:nb.description, client_ref:nb.id}});
      nb.server_id = data.notebook.id;
      nb.revision = data.notebook.revision;
    } else {
      const data = await api(`/api/notebooks/${nb.server_id}`, {method:'PATCH', json:{
        title:nb.title, description:nb.description, archived:nb.archived, revision:nb.revision
      }});
      nb.revision = data.notebook.revision;
    }
    await put('notebooks', nb);
    return queueResult('sent');
  };

  pushSpread = async function (item) {
    const sp = await get('spreads', item.local_id);
    if (!sp) return queueResult('discarded', 'local spread no longer exists');
    if (item.payload && item.payload.op === 'delete') {
      // A local delete must reach the server; otherwise the next snapshot restores the spread.
      // Local-only spreads (no server id) are already deleted as far as the server is concerned.
      const deletedAt = sp.deleted_at || nowISO();
      const nb = await get('notebooks', sp.notebook_id);
      if (!sp.server_id || !nb || !nb.server_id) {
        await put('spreads', {...sp, deleted_at:deletedAt});
        return queueResult('sent');
      }
      try { await api(`/api/spreads/${sp.server_id}`, {method:'DELETE'}); }
      catch (error) {
        if (!error || error.status !== 404) throw error;
      }
      await put('spreads', {...sp, deleted_at:deletedAt});
      return queueResult('sent');
    }
    const nb = await get('notebooks', sp.notebook_id);
    if (!nb || !nb.server_id) return queueResult('deferred', 'notebook has no server id');
    if (!sp.server_id) {
      const data = await api(`/api/notebooks/${nb.server_id}/spreads`, {method:'POST', json:{
        number:sp.number, title:sp.title, note_short:sp.note_short, note_full:sp.note_full,
        status:sp.status, client_ref:sp.id
      }});
      sp.server_id = data.spread.id;
      sp.revision = data.spread.revision;
    } else {
      const data = await api(`/api/spreads/${sp.server_id}`, {method:'PATCH', json:{
        number:sp.number, title:sp.title, note_short:sp.note_short, note_full:sp.note_full,
        status:sp.status, revision:sp.revision
      }});
      sp.revision = data.spread.revision;
      sp.conflict = null;
    }
    await put('spreads', sp);
    return queueResult('sent');
  };

  pushTagLink = async function (item) {
    const sp = await get('spreads', item.local_id);
    if (!sp) return queueResult('discarded', 'local spread no longer exists');
    if (!sp.server_id) return queueResult('deferred', 'spread has no server id');
    const nb = await get('notebooks', sp.notebook_id);
    if (!nb || !nb.server_id) return queueResult('deferred', 'notebook has no server id');
    const tagRow = await get('tags', item.tag_id);
    if (!tagRow) return queueResult('discarded', 'local tag no longer exists');
    if (!tagRow.server_id) {
      const data = await api(`/api/notebooks/${nb.server_id}/tags`, {method:'POST', json:{name:tagRow.name}});
      tagRow.server_id = data.tag.id;
      await put('tags', tagRow);
    }
    if (item.op === 'add') await api(`/api/spreads/${sp.server_id}/tags`, {method:'POST', json:{tag_id:tagRow.server_id}});
    else await api(`/api/spreads/${sp.server_id}/tags/${tagRow.server_id}`, {method:'DELETE'});
    return queueResult('sent');
  };

  pushFavorite = async function (item) {
    const sp = await get('spreads', item.local_id);
    if (!sp) return queueResult('discarded', 'local spread no longer exists');
    if (!sp.server_id) return queueResult('deferred', 'spread has no server id');
    if (item.op === 'add') await api(`/api/favorites/${sp.server_id}`, {method:'PUT'});
    else await api(`/api/favorites/${sp.server_id}`, {method:'DELETE'});
    return queueResult('sent');
  };

  pushNotebookCover = async function (item) {
    const notebook = await get('notebooks', item.local_id);
    if (!notebook) return queueResult('discarded', 'local notebook no longer exists');
    if (!isAuthed() || !enabled('notebook_cover')) return queueResult('deferred', 'cover sync unavailable');
    if (!notebook.server_id) return queueResult('deferred', 'notebook has no server id');
    const path = `/api/notebooks/${encodeURIComponent(notebook.server_id)}/cover`;
    if (item.payload && item.payload.op === 'delete') {
      const data = await api(path, {method:'DELETE', json:{client_ref:item.payload.client_ref}});
      if (data && data.cover) await window.v340ApplyServerCover(notebook, data.cover);
      return queueResult('sent');
    }
    const record = await get('blobs', window.v340CoverBlobId(notebook.id));
    if (!record || !record.blob) return queueResult('discarded', 'local cover blob missing');
    const form = new FormData();
    form.append('file', record.blob, `notebook_cover_${notebook.id}.jpg`);
    const preview = await makeThumbnail(record.blob, 300).catch(error => {
      console.warn('Cover preview could not be prepared', error);
      return null;
    });
    if (preview) form.append('preview', preview, 'cover-preview.webp');
    form.append('client_ref', item.payload.client_ref);
    const headers = {};
    if (settings.auth_token) headers.Authorization = 'Bearer ' + settings.auth_token;
    const response = await fetch(settings.backend_url.replace(/\/$/, '') + path, {method:'PUT', body:form, headers});
    if (!response.ok) {
      const error = new Error('backend ' + response.status);
      error.status = response.status;
      throw error;
    }
    const data = await response.json();
    if (data && data.cover) await window.v340ApplyServerCover(notebook, data.cover);
    return queueResult('sent');
  };

  pushEntityQueue = async function (forceRetry) {
    const queue = (await getAll('sync_queue')).filter(item =>
      item.entity && item.entity !== 'photo' && retryDue(item, !!forceRetry)
    );
    for (const item of queue) {
      try {
        let result = queueResult('discarded', 'unsupported queue entity');
        if (item.entity === 'notebook') result = await pushNotebook(item);
        else if (item.entity === 'spread') result = await pushSpread(item);
        else if (item.entity === 'tag_link') result = await pushTagLink(item);
        else if (item.entity === 'favorite') result = await pushFavorite(item);
        else if (item.entity === 'spread_note') result = await pushNote(item);
        else if (item.entity === 'spread_fields') result = await pushFields(item);
        else if (item.entity === 'spread_order') result = await pushOrder(item);
        else if (item.entity === 'notebook_cover') result = await pushNotebookCover(item);

        if (result.status === 'sent' || result.status === 'discarded') {
          markDone(item);
        } else if (result.status === 'deferred') {
          item.status = 'pending';
          item.last_error = result.detail;
        } else {
          throw new Error(result.detail || 'unknown queue result');
        }
        await put('sync_queue', item);
      } catch (error) {
        if (['spread_note','spread_fields','spread_order'].includes(item.entity)) {
          if (error?.status === 409) {
            item.status = 'conflict'; item.last_error = error.message; item.conflicts = error.data;
          } else markRetry(item, error);
          await put('sync_queue', item);
          if (item.entity === 'spread_fields' && error?.data?.conflicts) {
            const spread = await get('spreads', item.local_id);
            if (spread) await put('spreads', {...spread, field_conflicts:error.data.conflicts});
          }
          if (item.entity === 'spread_note') {
            const note = await get('spread_notes', item.local_id);
            if (note) await put('spread_notes', {...note, sync_error:error.message});
          }
          console.warn('Team change remains in outbox', item.entity, error);
          continue;
        }
        if (error && error.status === 409) {
          item.status = 'conflict';
          item.last_error = 'revision conflict';
          item.server_copy = error.data && error.data.server_copy;
          await put('sync_queue', item);
          const local = await get(item.entity === 'notebook' ? 'notebooks' : 'spreads', item.local_id);
          if (local) {
            local.conflict = item.server_copy || true;
            await put(item.entity === 'notebook' ? 'notebooks' : 'spreads', local);
          }
        } else {
          markRetry(item, error);
          await put('sync_queue', item);
          console.warn('Deferred sync item failed', item.entity, item.local_id, error);
        }
      }
    }
  };

  async function sendPhotoUpload(photo, spread) {
    const blobRec = await get('blobs', photo.id + '_orig');
    const thumbRec = await get('blobs', photo.id + '_thumb');
    if (!blobRec) throw new Error('no local original blob');
    const fd = new FormData();
    fd.append('file', blobRec.blob, `spread_${photo.spread_id}_v${photo.version}`);
    fd.append('client_upload_id', photo.id);
    if (thumbRec) fd.append('preview', thumbRec.blob, 'thumb.webp');
    const path = isAuthed() ? `/api/spreads/${spread.server_id}/photos` : '/upload';
    const headers = {};
    if (settings.auth_token) headers.Authorization = 'Bearer ' + settings.auth_token;
    const resp = await fetch(settings.backend_url.replace(/\/$/, '') + path, {method:'POST', body:fd, headers});
    if (!resp.ok) {
      const error = new Error('backend ' + resp.status);
      error.status = resp.status;
      throw error;
    }
    return await resp.json();
  }

  pushPhotoQueue = async function (forceRetry, options = {}) {
    const onlyItemIds = options.onlyItemIds ? new Set(options.onlyItemIds.map(String)) : null;
    const queue = (await getAll('sync_queue')).filter(item =>
      item.entity === 'photo' && retryDue(item, !!forceRetry)
      && (!onlyItemIds || onlyItemIds.has(String(item.id)))
    );
    for (const item of queue) {
      const photo = await get('photos', item.photo_id);
      const spread = photo ? await get('spreads', photo.spread_id) : null;
      if (!photo || !spread || photo.upload_status === 'synced') {
        markDone(item);
        await put('sync_queue', item);
        continue;
      }
      if (isAuthed() && !spread.server_id) {
        item.status = 'pending';
        item.last_error = 'spread has no server id';
        await put('sync_queue', item);
        continue;
      }
      const photoBeforeAttempt = {...photo};
      const itemBeforeAttempt = {...item};
      photo.upload_status = 'uploading';
      await put('photos', photo);
      try {
        const data = await sendPhotoUpload(photo, spread);
        photo.storage_object_id = data.storage_object_id;
        photo.telegram_message_id = data.message_id;
        photo.telegram_file_id = data.file_id;
        photo.telegram_file_unique_id = data.file_unique_id;
        photo.telegram_link = data.telegram_link || null;
        photo.server_id = data.photo_id || photo.server_id;
        photo.upload_status = 'synced';
        const latestPhoto = await get('photos', photo.id);
        if (latestPhoto) photo.is_current = latestPhoto.is_current;
        await put('photos', photo);
        if (data.spread_revision) {
          const latestSpread = await get('spreads', spread.id);
          if (latestSpread) await put('spreads', {...latestSpread, revision:Math.max(latestSpread.revision || 0, data.spread_revision)});
        }
        markDone(item);
        await put('sync_queue', item);
        if (!options.preserveOriginals && !settings.keep_originals_offline) await del('blobs', photo.id + '_orig');
      } catch (error) {
        if (options.restoreOnFailure) {
          await put('photos', photoBeforeAttempt);
          await put('sync_queue', itemBeforeAttempt);
        } else {
          photo.upload_status = 'upload_failed';
          await put('photos', photo);
          markRetry(item, error);
          await put('sync_queue', item);
        }
        console.warn(options.restoreOnFailure ? 'Photo upload failed; local state restored' : 'Photo upload failed; retry scheduled', photo.id, error);
        if (options.throwOnError) throw error;
      }
    }
  };

  applyChangeBatch = async function (changes) {
    // A parent's latest seq may fall on a later page. Resolve missing parents before
    // applying children; silently skipping a photo/tag/favorite would advance past it.
    const knownNotebooks = new Set((await getAll('notebooks')).map(row => row.server_id));
    for (const row of changes.notebooks || []) knownNotebooks.add(row.id);
    for (const row of [...(changes.spreads || []), ...(changes.notebook_covers || [])]) {
      if (row.notebook_id && !knownNotebooks.has(row.notebook_id)) {
        await applySnapshot(row.notebook_id); knownNotebooks.add(row.notebook_id);
      }
    }
    const knownSpreads = new Set((await getAll('spreads')).map(row => row.server_id));
    for (const row of changes.spreads || []) knownSpreads.add(row.id);
    for (const row of [...(changes.photos || []), ...(changes.spread_tags || []), ...(changes.favorites || [])]) {
      if (!knownSpreads.has(row.spread_id)) {
        const parent = await api(`/api/spreads/${encodeURIComponent(row.spread_id)}`);
        if (!parent?.spread?.notebook_id) throw new Error('Не найден родитель синхронизируемого объекта');
        await applySnapshot(parent.spread.notebook_id);
        if (!(await getAll('spreads')).some(spread => spread.server_id === row.spread_id)) throw new Error('Разворот не сохранён');
        knownSpreads.add(row.spread_id);
      }
    }
    const queue = await getAll('sync_queue');
    const notebooksAll = await getAll('notebooks');
    const spreadsAll = await getAll('spreads');
    const tagsAll = await getAll('tags');

    for (const srvNb of (changes.notebooks || [])) {
      let local = notebooksAll.find(nb => nb.server_id === srvNb.id);
      if (!local) {
        local = {id:uid(), created_at:srvNb.created_at};
        notebooksAll.push(local);
      } else if (await queueHasUnsynced(queue, 'notebook', local.id)) {
        continue;
      }
      Object.assign(local, {server_id:srvNb.id, title:srvNb.title, description:srvNb.description,
        archived:!!srvNb.archived, revision:srvNb.revision, updated_at:srvNb.updated_at, deleted_at:srvNb.deleted_at});
      await put('notebooks', local);
    }

    for (const srvCover of (changes.notebook_covers || [])) {
      const local = notebooksAll.find(nb => nb.server_id === srvCover.notebook_id);
      if (!local) continue;
      if (await queueHasUnsynced(queue, 'notebook_cover', local.id)) continue;
      await window.v340ApplyServerCover(local, srvCover);
    }

    for (const srvSp of (changes.spreads || [])) {
      let local = spreadsAll.find(sp => sp.server_id === srvSp.id);
      const nb = notebooksAll.find(row => row.server_id === srvSp.notebook_id);
      if (!local) {
        if (!nb) continue;
        local = {id:uid(), notebook_id:nb.id, created_at:srvSp.created_at};
        spreadsAll.push(local);
      } else if (await queueHasUnsynced(queue, 'spread', local.id)) {
        continue;
      }
      Object.assign(local, {server_id:srvSp.id, number:srvSp.number, title:srvSp.title,
        note_short:srvSp.note_short, note_full:srvSp.note_full, status:srvSp.status,
        revision:srvSp.revision, updated_at:srvSp.updated_at, deleted_at:srvSp.deleted_at,
        searchableText:normalize([srvSp.number, srvSp.title, srvSp.note_short, srvSp.note_full].join(' '))});
      for (const item of queue.filter(item => item.entity === 'spread_fields' && item.local_id === local.id && UNSYNCED.has(item.status))) {
        Object.assign(local, item.payload.changes);
      }
      local.metadata_base = metadata(srvSp);
      local.server_current_photo_id = srvSp.current_photo_id;
      local.searchableText = normalize([local.number,local.title,local.note_short,local.note_full].join(' '));
      await put('spreads', local);
    }

    for (const srvTag of (changes.tags || [])) {
      let local = tagsAll.find(tag => tag.server_id === srvTag.id);
      if (!local) { local = {id:uid()}; tagsAll.push(local); }
      local.server_id = srvTag.id;
      local.name = srvTag.name;
      await put('tags', local);
    }

    const spreadsFresh = await getAll('spreads');
    for (const srvSt of (changes.spread_tags || [])) {
      const localSp = spreadsFresh.find(sp => sp.server_id === srvSt.spread_id);
      const localTag = tagsAll.find(tag => tag.server_id === srvSt.tag_id);
      if (!localSp || !localTag || await queueHasUnsynced(queue, 'tag_link', localSp.id)) continue;
      const links = await getAllByIndex('spread_tags', 'spread_id', localSp.id);
      const existing = links.find(link => link.tag_id === localTag.id);
      if (srvSt.deleted_at) { if (existing) await del('spread_tags', existing.id); }
      else if (!existing) await put('spread_tags', {spread_id:localSp.id, tag_id:localTag.id});
    }

    const photosAll = await getAll('photos');
    for (const srvPh of (changes.photos || [])) {
      const localSp = spreadsFresh.find(sp => sp.server_id === srvPh.spread_id);
      if (!localSp) continue;
      let localPh = photosAll.find(photo => photo.server_id === srvPh.id);
      if (!localPh) localPh = {id:uid(), created_at:srvPh.created_at};
      const photoPending = queue.some(item => item.entity === 'photo' && item.photo_id === localPh.id && UNSYNCED.has(item.status));
      if (photoPending) continue;
      mapServerPhoto(localPh, srvPh, localSp.id);
      await put('photos', localPh);
      const pendingPhoto = photosAll.some(row => row.spread_id === localSp.id &&
        queue.some(item => item.entity === 'photo' && item.photo_id === row.id && UNSYNCED.has(item.status)));
      if (localPh.is_current && !pendingPhoto && localSp.current_photo_id !== localPh.id) {
        localSp.current_photo_id = localPh.id;
        await put('spreads', localSp);
      }
    }

    for (const fav of (changes.favorites || [])) {
      const localSp = spreadsFresh.find(sp => sp.server_id === fav.spread_id);
      if (!localSp || await queueHasUnsynced(queue, 'favorite', localSp.id)) continue;
      if (fav.deleted_at) { localSp.favorite = false; await del('user_favorites', localSp.id); }
      else { localSp.favorite = true; await put('user_favorites', {spread_id:localSp.id}); }
      await put('spreads', localSp);
    }
    await reconcileCurrentPhotos(changes.spreads || [], queue);
    await applyTeamChanges(changes);
  };

  async function reconcileCurrentPhotos(serverSpreads, queue) {
    const photos = await getAll('photos');
    for (const server of serverSpreads) {
      if (!Object.prototype.hasOwnProperty.call(server, 'current_photo_id')) continue;
      const local = (await getAll('spreads')).find(row => row.server_id === server.id);
      if (!local) continue;
      const own = photos.filter(photo => photo.spread_id === local.id);
      if (own.some(photo => queue.some(item => item.entity === 'photo' && item.photo_id === photo.id && UNSYNCED.has(item.status)))) continue;
      const current = own.find(photo => photo.server_id === server.current_photo_id);
      // A referenced photo may arrive in the next sync page. Keep the image until then.
      if (server.current_photo_id && !current) continue;
      local.current_photo_id = current?.id || null;
      await put('spreads', local);
      for (const photo of own) if (photo.is_current !== (photo.id === current?.id)) {
        photo.is_current = photo.id === current?.id; await put('photos', photo);
      }
    }
  }

  applySnapshot = async function (serverNotebookId) {
    const data = await api(`/api/notebooks/${serverNotebookId}/snapshot`);
    const queue = await getAll('sync_queue');
    let localNb = (await getAll('notebooks')).find(nb => nb.server_id === serverNotebookId);
    if (!localNb) {
      localNb = {id:uid(), server_id:serverNotebookId, title:'', description:'', archived:false,
        sort_order:0, created_at:nowISO(), updated_at:nowISO(), deleted_at:null, revision:1};
    }
    if (!(await queueHasUnsynced(queue, 'notebook', localNb.id))) {
      Object.assign(localNb, {title:data.notebook.title, description:data.notebook.description,
        archived:!!data.notebook.archived, revision:data.notebook.revision});
    }
    localNb.hidden_no_access = false;
    await put('notebooks', localNb);
    if (data.cover && !(await queueHasUnsynced(queue, 'notebook_cover', localNb.id))) {
      await window.v340ApplyServerCover(localNb, data.cover);
    }

    const spreadIdMap = {};
    const localSpreads = await getAll('spreads');
    for (const srvSp of data.spreads) {
      let localSp = localSpreads.find(sp => sp.server_id === srvSp.id);
      if (!localSp) localSp = {id:uid(), notebook_id:localNb.id, created_at:srvSp.created_at, deleted_at:null};
      if (!(await queueHasUnsynced(queue, 'spread', localSp.id))) {
        Object.assign(localSp, {server_id:srvSp.id, notebook_id:localNb.id, number:srvSp.number,
          title:srvSp.title, note_short:srvSp.note_short, note_full:srvSp.note_full,
          status:srvSp.status, revision:srvSp.revision, updated_at:srvSp.updated_at,
          deleted_at:srvSp.deleted_at,
          searchableText:normalize([srvSp.number, srvSp.title, srvSp.note_short, srvSp.note_full].join(' '))});
      }
      await put('spreads', localSp);
      spreadIdMap[srvSp.id] = localSp.id;
    }

    const localTags = await getAll('tags');
    for (const srvTag of data.tags) {
      let localTag = localTags.find(tag => tag.server_id === srvTag.id);
      if (!localTag) { localTag = {id:uid(), name:srvTag.name}; localTags.push(localTag); }
      localTag.server_id = srvTag.id;
      localTag.name = srvTag.name;
      await put('tags', localTag);
    }
    for (const st of data.spread_tags) {
      if (st.deleted_at) continue;
      const localSpId = spreadIdMap[st.spread_id];
      const localTag = localTags.find(tag => tag.server_id === st.tag_id);
      if (!localSpId || !localTag || await queueHasUnsynced(queue, 'tag_link', localSpId)) continue;
      const links = await getAllByIndex('spread_tags', 'spread_id', localSpId);
      if (!links.some(link => link.tag_id === localTag.id)) await put('spread_tags', {spread_id:localSpId, tag_id:localTag.id});
    }

    const localPhotos = await getAll('photos');
    for (const srvPh of data.photos) {
      const localSpId = spreadIdMap[srvPh.spread_id];
      if (!localSpId) continue;
      let localPh = localPhotos.find(photo => photo.server_id === srvPh.id);
      if (!localPh) localPh = {id:uid(), created_at:srvPh.created_at};
      const photoPending = queue.some(item => item.entity === 'photo' && item.photo_id === localPh.id && UNSYNCED.has(item.status));
      if (photoPending) continue;
      mapServerPhoto(localPh, srvPh, localSpId);
      await put('photos', localPh);
      if (localPh.is_current) {
        const sp = await get('spreads', localSpId);
        const pendingPhoto = localPhotos.some(row => row.spread_id === localSpId &&
          queue.some(item => item.entity === 'photo' && item.photo_id === row.id && UNSYNCED.has(item.status)));
        if (sp && !pendingPhoto) {
          sp.current_photo_id = localPh.id;
          await put('spreads', sp);
        }
      }
    }

    const activeFavorites = new Set((data.favorites || []).filter(fav => !fav.deleted_at).map(fav => spreadIdMap[fav.spread_id]).filter(Boolean));
    for (const localSpId of Object.values(spreadIdMap)) {
      if (await queueHasUnsynced(queue, 'favorite', localSpId)) continue;
      const sp = await get('spreads', localSpId);
      if (!sp) continue;
      sp.favorite = activeFavorites.has(localSpId);
      await put('spreads', sp);
      if (sp.favorite) await put('user_favorites', {spread_id:localSpId});
      else await del('user_favorites', localSpId);
    }
    // Reuse incremental mapping for field-level pending edits and authoritative photo IDs.
    await applyChangeBatch({spreads:data.spreads, spread_notes:data.spread_notes || []});
  };

  fullSync = async function (manual) {
    if (syncing) return;
    if (!isOnline()) { if (manual) toast('Нет подключения к интернету'); return; }
    syncing = true;
    settings.sync_status = 'syncing';
    settings.sync_errors = [];
    updateSyncIndicator();
    const recordFailure = (stage, error) => {
      settings.sync_errors.push({stage, message:String(error?.message || error).slice(0, 200)});
    };
    try {
      if (isAuthed()) {
        const sessionScope = scope();
        let sessionVerified = false;
        try {
          const me = await api('/api/me');
          assertScope(sessionScope);
          settings.team_capabilities = {scope:sessionScope, flags:me.capabilities || {}};
          sessionVerified = true;
        } catch (error) {
          assertScope(sessionScope);
          if (error.status === 401 || error.status === 403) throw error;
          recordFailure('session', error);
          // Read endpoints authenticate independently. Keep scoped cached capabilities,
          // but never push using unverified session/capability information.
        }
        // One failing push step must never skip the pull: history/unread would silently stop
        // updating (content still arrives through its own refetch), which is exactly the bug we hit.
        if (sessionVerified) {
          try { await reconcileNotebookConflicts(); }
          catch (error) { recordFailure('notebook conflicts', error); console.warn('Notebook conflicts could not be reconciled', error); }
          try { await pushEntityQueue(!!manual); }
          catch (error) { recordFailure('outbox', error); console.warn('Outbox push failed; continuing with pull', error); }
          assertScope(sessionScope);
          try { await pushPhotoQueue(!!manual); }
          catch (error) { recordFailure('photos', error); console.warn('Photo push failed; continuing with pull', error); }
        }
        assertScope(sessionScope);
        try { await syncMembership(); }
        catch (error) { recordFailure('membership', error); console.warn('Membership refresh failed; continuing with pull', error); }
        assertScope(sessionScope);
        if (enabled('team_notes') && settings.team_snapshot_scope !== sessionScope) {
          // Old clients already advanced the same cursor while ignoring new fields.
          // Backfill notes once without resetting that cursor or deleting local data.
          const notebooks = (await getAll('notebooks')).filter(row => row.server_id && !row.deleted_at && !row.hidden_no_access);
          let backfillComplete = true;
          for (const notebook of notebooks) {
            try { await applySnapshot(notebook.server_id); }
            catch (error) { backfillComplete = false; recordFailure('snapshot', error); console.warn('Snapshot backfill failed', notebook.server_id, error); }
          }
          assertScope(sessionScope);
          if (backfillComplete) settings.team_snapshot_scope = sessionScope;
        }
        await pullChanges();
        try { await window.v340RetryCovers?.(); }
        catch (error) { recordFailure('covers', error); }
        if (sessionVerified) void window.v340MigrateLegacyCovers?.().catch(error => console.warn('Legacy cover migration failed', error));
      } else {
        await pushPhotoQueue(!!manual);
      }
      const remaining = (await getAll('sync_queue')).some(item => UNSYNCED.has(item.status));
      settings.sync_status = settings.sync_errors.length ? 'error' : remaining ? 'pending' : 'idle';
      settings.last_sync_at = nowISO();
    } catch (error) {
      recordFailure('sync', error);
      settings.sync_status = 'error';
      console.error('Synchronization failed', error);
      if (manual) toast('Ошибка синхронизации: ' + (error.message || error));
    }
    try { await saveSettings(); }
    catch (error) { settings.sync_status = 'error'; recordFailure('storage', error); }
    finally { syncing = false; updateSyncIndicator(); }
    window.BlocknotV3?.emit('sync-complete');
    if (route.screen === 'settings') {
      const el = document.getElementById('syncStatus');
      if (el) renderSyncStatus(el);
    }
    if (manual && settings.sync_status === 'idle') toast('Синхронизация завершена');
    else if (manual && settings.sync_status === 'pending') toast('Часть изменений ожидает зависимые данные или повторную отправку');
    if (refreshRequested) { refreshRequested = false; setTimeout(() => void fullSync(), 0); }
  };


  function diagnosticValue(source, key) {
    return source && Object.hasOwn(source, key) ? (source[key] ?? null) : null;
  }

  function redactDiagnosticKey(key) {
    return /(^|_)(auth|authorization|bearer|token|secret|password|bot)(_|$)|chat_id/i.test(String(key || ''));
  }

  function sanitizeDiagnosticValue(value, depth = 0, seen = null) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
    if (typeof value !== 'object') return String(value);
    const tag = Object.prototype.toString.call(value);
    if (tag === '[object Blob]' || tag === '[object File]') {
      return {type:'[binary omitted]', size:typeof value.size === 'number' ? value.size : null,
        mime_type:value.type || null, name:value.name || null};
    }
    if (depth > 8) return '[max depth]';
    const guard = seen || new WeakSet();
    if (guard.has(value)) return '[circular]';
    guard.add(value);
    if (Array.isArray(value)) return value.slice(0, 100).map(item => sanitizeDiagnosticValue(item, depth + 1, guard));
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (redactDiagnosticKey(key)) { out[key] = '[redacted]'; continue; }
      if (key === 'blob' || key === 'body' && item && typeof item === 'object' && typeof item.arrayBuffer === 'function') {
        out[key] = '[binary omitted]'; continue;
      }
      out[key] = sanitizeDiagnosticValue(item, depth + 1, guard);
    }
    return out;
  }

  function backendOrigin() {
    const raw = String(settings.backend_url || '').trim();
    if (!raw) return null;
    if (typeof URL === 'function') {
      try { return new URL(raw).origin; }
      catch (error) { console.warn('Backend URL is not parseable for diagnostics', error); }
    }
    const match = raw.match(/^[a-z][a-z0-9+.-]*:\/\/[^/]+/i);
    return match ? match[0] : raw.replace(/\/.*$/, '');
  }

  function queueStatusCounts(queue) {
    const counts = {total_unsynced:0, pending:0, syncing:0, failed:0, conflict:0};
    for (const item of queue) {
      if (!UNSYNCED.has(item.status)) continue;
      counts.total_unsynced++;
      if (Object.hasOwn(counts, item.status)) counts[item.status]++;
    }
    return counts;
  }

  function explicitQueueFields(item) {
    const payload = item && item.payload || {};
    return {
      id:diagnosticValue(item, 'id'),
      entity:diagnosticValue(item, 'entity'),
      local_id:diagnosticValue(item, 'local_id'),
      server_id:diagnosticValue(item, 'server_id'),
      spread_id:diagnosticValue(item, 'spread_id'),
      photo_id:diagnosticValue(item, 'photo_id'),
      note_id:diagnosticValue(item, 'note_id'),
      tag_id:diagnosticValue(item, 'tag_id'),
      scope:diagnosticValue(item, 'scope'),
      status:diagnosticValue(item, 'status'),
      retry_count:diagnosticValue(item, 'retry_count'),
      created_at:diagnosticValue(item, 'created_at'),
      updated_at:diagnosticValue(item, 'updated_at'),
      last_attempt_at:diagnosticValue(item, 'last_attempt_at'),
      next_attempt_at:diagnosticValue(item, 'next_attempt_at'),
      last_error:diagnosticValue(item, 'last_error'),
      error:diagnosticValue(item, 'error'),
      sync_error:diagnosticValue(item, 'sync_error'),
      method:diagnosticValue(item, 'method'),
      op:diagnosticValue(item, 'op') ?? diagnosticValue(payload, 'op'),
      revision:diagnosticValue(item, 'revision') ?? diagnosticValue(payload, 'revision'),
      base_revision:diagnosticValue(item, 'base_revision') ?? diagnosticValue(payload, 'base_revision'),
      payload:sanitizeDiagnosticValue(diagnosticValue(item, 'payload')),
      server_copy:sanitizeDiagnosticValue(storedServerCopy(item) || diagnosticValue(item, 'server_copy')),
      conflict_data:sanitizeDiagnosticValue(diagnosticValue(item, 'conflict_data') || storedConflicts(item) || diagnosticValue(item, 'conflicts')),
    };
  }

  function localSpreadDiagnostic(spread, allSpreads) {
    if (!spread) {
      return {exists:false, id:null, server_id:null, notebook_id:null, number:null, title:null,
        status:null, note_short:null, note_full:null, revision:null, deleted_at:null,
        current_photo_id:null, duplicate_number:{exists:false, count:0, rows:[]}};
    }
    const duplicates = (allSpreads || []).filter(row => row.id !== spread.id && !row.deleted_at &&
      row.notebook_id === spread.notebook_id && row.number === spread.number)
      .map(row => ({local_id:row.id, server_id:row.server_id || null, revision:row.revision ?? null,
        deleted_at:row.deleted_at || null, number:row.number ?? null, title:row.title || null}));
    return {exists:true, id:spread.id, server_id:spread.server_id || null, notebook_id:spread.notebook_id || null,
      number:spread.number ?? null, title:spread.title ?? null, status:spread.status ?? null,
      note_short:spread.note_short ?? null, note_full:spread.note_full ?? null,
      revision:spread.revision ?? null, deleted_at:spread.deleted_at || null,
      current_photo_id:spread.current_photo_id || null,
      duplicate_number:{exists:duplicates.length > 0, count:duplicates.length + 1,
        rows:[{local_id:spread.id, server_id:spread.server_id || null, revision:spread.revision ?? null,
          deleted_at:spread.deleted_at || null, number:spread.number ?? null, title:spread.title || null}, ...duplicates]}};
  }

  async function blobDiagnostic(blobId) {
    const empty = {exists:false, size:null, mime_type:null, error:null};
    if (!blobId) return empty;
    try {
      const record = await get('blobs', blobId);
      const blob = record && record.blob;
      if (!blob) return empty;
      return {exists:true, size:typeof blob.size === 'number' ? blob.size : null,
        mime_type:blob.type || null, error:null};
    } catch (error) {
      return {exists:false, size:null, mime_type:null, error:String(error && error.message ? error.message : error)};
    }
  }

  async function photoDiagnostic(photo) {
    if (!photo) return null;
    return {
      id:photo.id || null,
      server_id:photo.server_id || null,
      spread_id:photo.spread_id || null,
      version:photo.version ?? null,
      is_current:photo.is_current ?? null,
      upload_status:photo.upload_status ?? null,
      storage_object_id:photo.storage_object_id ?? null,
      telegram_message_id:photo.telegram_message_id ?? null,
      telegram_file_id:photo.telegram_file_id ?? null,
      telegram_file_unique_id:photo.telegram_file_unique_id ?? null,
      telegram_link:photo.telegram_link ?? null,
      mime_type:photo.mime_type ?? null,
      file_size:photo.file_size ?? null,
      client_upload_id:photo.client_upload_id ?? null,
      blobs:{
        orig:await blobDiagnostic((photo.id || '') + '_orig'),
        thumb:await blobDiagnostic((photo.id || '') + '_thumb'),
      }
    };
  }

  async function relatedSpread(item, allPhotos) {
    if (!item) return null;
    if (['spread','spread_fields','spread_order','tag_link','favorite'].includes(item.entity) && item.local_id) {
      const spread = await get('spreads', item.local_id);
      if (spread) return spread;
    }
    if (item.spread_id) {
      const spread = await get('spreads', item.spread_id);
      if (spread) return spread;
    }
    if (item.photo_id) {
      const photo = (allPhotos || []).find(row => row.id === item.photo_id) || await get('photos', item.photo_id);
      if (photo?.spread_id) return await get('spreads', photo.spread_id);
    }
    if (item.entity === 'spread_note' && item.local_id) {
      const note = await get('spread_notes', item.local_id);
      if (note?.spread_id) return await get('spreads', note.spread_id);
    }
    return null;
  }

  async function relatedPhotoDiagnostics(item, spread, allPhotos) {
    const photos = new Map();
    if (item?.photo_id) {
      const direct = (allPhotos || []).find(row => row.id === item.photo_id) || await get('photos', item.photo_id);
      if (direct) photos.set(direct.id, direct);
    }
    if (spread?.id) for (const photo of (allPhotos || []).filter(row => row.spread_id === spread.id)) photos.set(photo.id, photo);
    const result = [];
    for (const photo of photos.values()) result.push(await photoDiagnostic(photo));
    return result.sort((a,b) => (Number(b.is_current) || 0) - (Number(a.is_current) || 0)
      || (Number(b.version) || 0) - (Number(a.version) || 0) || String(a.id).localeCompare(String(b.id)));
  }

  function deriveQueueServerId(item, spread, photos) {
    if (item?.server_id) return item.server_id;
    if (item?.entity === 'photo') return photos.find(photo => photo.id === item.photo_id)?.server_id || null;
    if (spread?.server_id) return spread.server_id;
    return null;
  }


  function localCurrentRole(notebooks) {
    const currentNotebookId = route?.notebookId || null;
    const candidates = currentNotebookId ? (notebooks || []).filter(row => row.id === currentNotebookId)
      : (notebooks || []).filter(row => row.server_id && !row.deleted_at && !row.hidden_no_access);
    for (const notebook of candidates) {
      if (settings.user_id && notebook.owner_id === settings.user_id) return {role:'OWNER', source:'local notebook.owner_id'};
      if (notebook.role || notebook.my_role) return {role:notebook.role || notebook.my_role, source:'local notebook role field'};
    }
    return {role:null, source:'not stored locally; diagnostics is read-only'};
  }

  async function buildReadOnlyDiagnosticReport() {
    const queueAll = await getAll('sync_queue');
    const unfinished = queueAll.filter(item => UNSYNCED.has(item.status))
      .sort((a,b) => Number(a.id || 0) - Number(b.id || 0) || String(a.id || '').localeCompare(String(b.id || '')));
    const allSpreads = await getAll('spreads');
    const allPhotos = await getAll('photos');
    const role = localCurrentRole(await getAll('notebooks'));
    const report = {
      generated_at:nowISO(),
      app_version:window.__BLOCKNOT_APP_VERSION__ || null,
      backend_origin:backendOrigin(),
      current_user_id:settings.user_id || null,
      current_role:role.role,
      current_role_source:role.source,
      sync_scope:scope(),
      sync_cursor:settings.sync_cursor ?? null,
      last_sync_at:settings.last_sync_at ?? null,
      online:typeof isOnline === 'function' ? !!isOnline() : null,
      authenticated:typeof isAuthed === 'function' ? !!isAuthed() : null,
      queue_counts:queueStatusCounts(queueAll),
      items:[],
    };
    for (const item of unfinished) {
      const spread = await relatedSpread(item, allPhotos);
      const photos = await relatedPhotoDiagnostics(item, spread, allPhotos);
      const entry = explicitQueueFields(item);
      entry.server_id = deriveQueueServerId(item, spread, photos) || entry.server_id || null;
      entry.local_spread = localSpreadDiagnostic(spread, allSpreads);
      entry.photos = photos;
      report.items.push(entry);
    }
    return report;
  }

  function sameBusinessFields(local, server) {
    if (!local || !server) return null;
    return JSON.stringify(metadata(local)) === JSON.stringify(metadata(server));
  }

  async function checkSpreadOnServerReadOnly(serverId, localBusiness = null) {
    if (!serverId) return {method:'GET', path:null, http_status:null, exists:false,
      message:'Проверка невозможна: отсутствует server_id'};
    const path = `/api/spreads/${encodeURIComponent(serverId)}`;
    try {
      const data = await api(path);
      const spread = data && data.spread;
      return {method:'GET', path, http_status:200, exists:!!spread,
        server_id:spread?.id || null, revision:spread?.revision ?? null, number:spread?.number ?? null,
        title:spread?.title ?? null, status:spread?.status ?? null, note_short:spread?.note_short ?? null,
        note_full:spread?.note_full ?? null, deleted_at:spread?.deleted_at || null,
        business_fields:spread ? metadata(spread) : null,
        same_business_fields:sameBusinessFields(localBusiness, spread)};
    } catch (error) {
      return {method:'GET', path, http_status:error?.status ?? null, exists:false,
        error:String(error && error.message ? error.message : error)};
    }
  }

  function diagnosticTable(rows) {
    return '<dl class="v352-diag-kv">' + Object.entries(rows).map(([key,value]) =>
      `<dt>${esc(key)}</dt><dd>${esc(value === undefined ? null : value)}</dd>`).join('') + '</dl>';
  }

  function diagnosticPre(value) {
    return `<pre>${esc(JSON.stringify(value, null, 2))}</pre>`;
  }

  async function copyDiagnosticText(text) {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; }
    const area = document.createElement('textarea');
    area.value = text; area.setAttribute('readonly', ''); area.style.position = 'fixed'; area.style.left = '-9999px';
    document.body.appendChild(area); area.select();
    let ok = false;
    try { ok = typeof document.execCommand === 'function' ? document.execCommand('copy') : false; }
    finally { area.remove(); }
    return ok;
  }

  const REPAIR_910 = Object.freeze({
    localNotebookId:'mtk0xajzs8tiep',
    serverNotebookId:'deb42fd8-38a3-4da0-862d-e5538cade2f6',
    localSpreadId:'mtlf4xgftqrtxh',
    localPhotoId:'mtlf4xmzkbhq9s',
    photoQueueId:286,
    spreadQueueId:287,
    untouchedQueueId:367,
    anchorServerId:'c260e443-099c-4797-8f0a-4f02a7d374aa',
    anchorClientRef:'mtlf3c95g2wsiv',
    expectedServerCount:27,
    expectedOrigSize:4950282,
    expectedThumbSize:24520,
    backendOrigin:'https://blocknot-proxy.mastif1235.workers.dev',
  });

  function repair910Queue(queue, id) {
    return queue.find(item => String(item.id) === String(id)) || null;
  }

  function repair910Contiguous(rows, expectedCount) {
    if (!Array.isArray(rows) || rows.length !== expectedCount) return false;
    const numbers = rows.map(row => Number(row.number)).sort((a,b) => a - b);
    return numbers.every((number,index) => number === index + 1)
      && new Set(rows.map(row => row.id)).size === rows.length;
  }

  function repair910BusinessMatches(local, server) {
    return !!local && !!server && ['title','status','note_short','note_full'].every(key =>
      (local[key] ?? '') === (server[key] ?? ''));
  }

  function repair910Check(checks, key, pass, detail) {
    checks.push({key, pass:!!pass, detail:detail ?? null});
  }

  function repair910Backup(state) {
    const localOrder = state.allSpreads.filter(row => row.notebook_id === REPAIR_910.localNotebookId && !row.deleted_at)
      .sort((a,b) => Number(a.number) - Number(b.number) || String(a.id).localeCompare(String(b.id)))
      .map(row => ({id:row.id, server_id:row.server_id || null, number:row.number, title:row.title,
        revision:row.revision ?? null, current_photo_id:row.current_photo_id || null}));
    return sanitizeDiagnosticValue({
      created_at:nowISO(),
      purpose:'Repair 9-10 before-image; blobs are intentionally not copied or changed',
      queue_286:state.queue286,
      queue_287:state.queue287,
      spread_mtlf4xgftqrtxh:state.spread,
      photo_mtlf4xmzkbhq9s:state.photo,
      blob_verification:{orig:state.orig, thumb:state.thumb},
      local_order_before:localOrder,
      server_order_before:state.serverSpreads.map(row => ({id:row.id, client_ref:row.client_ref || null,
        number:row.number, title:row.title, revision:row.revision, current_photo_id:row.current_photo_id || null})),
    });
  }

  function repair910Guard(state) {
    return JSON.stringify(sanitizeDiagnosticValue({
      spread:state.spread, photo:state.photo, queue286:state.queue286, queue287:state.queue287,
      orig:state.orig, thumb:state.thumb, queue367:state.queue367,
      serverSpreads:state.serverSpreads, anchor:state.anchor,
    }));
  }

  async function collectRepair910State() {
    const [spread, photo, notebook, queue, allSpreads, orig, thumb] = await Promise.all([
      get('spreads', REPAIR_910.localSpreadId), get('photos', REPAIR_910.localPhotoId),
      get('notebooks', REPAIR_910.localNotebookId), getAll('sync_queue'), getAll('spreads'),
      blobDiagnostic(REPAIR_910.localPhotoId + '_orig'), blobDiagnostic(REPAIR_910.localPhotoId + '_thumb'),
    ]);
    let serverSpreads = [], anchor = null, serverError = null;
    if (isOnline() && isAuthed() && notebook?.server_id === REPAIR_910.serverNotebookId
        && backendOrigin() === REPAIR_910.backendOrigin) {
      try {
        const list = await api(`/api/notebooks/${encodeURIComponent(REPAIR_910.serverNotebookId)}/spreads`);
        serverSpreads = Array.isArray(list?.spreads) ? list.spreads : [];
        anchor = (await api(`/api/spreads/${encodeURIComponent(REPAIR_910.anchorServerId)}`))?.spread || null;
      } catch (error) {
        serverError = String(error && error.message ? error.message : error);
      }
    }
    return {
      spread, photo, notebook, queue, allSpreads, orig, thumb, serverSpreads, anchor, serverError,
      queue286:repair910Queue(queue, REPAIR_910.photoQueueId),
      queue287:repair910Queue(queue, REPAIR_910.spreadQueueId),
      queue367:repair910Queue(queue, REPAIR_910.untouchedQueueId),
    };
  }

  async function buildRepair910Preview() {
    const state = await collectRepair910State();
    const checks = [];
    const localAnchor = state.allSpreads.find(row => row.server_id === REPAIR_910.anchorServerId && !row.deleted_at);
    const next = state.serverSpreads.filter(row => row.title === '11-12' && !row.deleted_at);
    const serverTargets = state.serverSpreads.filter(row => !row.deleted_at
      && (row.title === '9-10' || row.client_ref === REPAIR_910.localSpreadId));
    const targetQueue = state.queue.filter(item => UNSYNCED.has(item.status) &&
      (item.local_id === REPAIR_910.localSpreadId || item.photo_id === REPAIR_910.localPhotoId));
    const localMappingsCurrent = state.serverSpreads.every(server => {
      const matches = state.allSpreads.filter(local => local.server_id === server.id && !local.deleted_at);
      return matches.length === 1 && Number(matches[0].number) === Number(server.number)
        && Number(matches[0].revision) === Number(server.revision);
    });

    repair910Check(checks, 'production backend', backendOrigin() === REPAIR_910.backendOrigin, backendOrigin());
    repair910Check(checks, 'online + authenticated', isOnline() && isAuthed(), {online:isOnline(), authenticated:isAuthed()});
    repair910Check(checks, 'local notebook mapping', state.notebook?.server_id === REPAIR_910.serverNotebookId,
      {local_id:state.notebook?.id || null, server_id:state.notebook?.server_id || null});
    repair910Check(checks, 'local spread 9-10', !!state.spread && state.spread.id === REPAIR_910.localSpreadId
      && state.spread.notebook_id === REPAIR_910.localNotebookId && state.spread.title === '9-10'
      && Number(state.spread.number) === 3 && !state.spread.server_id && !state.spread.deleted_at
      && state.spread.current_photo_id === REPAIR_910.localPhotoId, localSpreadDiagnostic(state.spread, state.allSpreads));
    repair910Check(checks, 'local photo metadata', !!state.photo && state.photo.id === REPAIR_910.localPhotoId
      && state.photo.spread_id === REPAIR_910.localSpreadId && !state.photo.server_id
      && state.photo.upload_status === 'local_pending' && Number(state.photo.file_size) === REPAIR_910.expectedOrigSize,
      state.photo ? await photoDiagnostic(state.photo) : null);
    repair910Check(checks, 'orig blob intact', state.orig.exists && Number(state.orig.size) === REPAIR_910.expectedOrigSize, state.orig);
    repair910Check(checks, 'thumb blob intact', state.thumb.exists && Number(state.thumb.size) === REPAIR_910.expectedThumbSize, state.thumb);
    repair910Check(checks, 'queue #286 exact', !!state.queue286 && state.queue286.entity === 'photo'
      && state.queue286.photo_id === REPAIR_910.localPhotoId && state.queue286.status === 'pending'
      && state.queue286.last_error === 'spread has no server id', explicitQueueFields(state.queue286));
    repair910Check(checks, 'queue #287 exact', !!state.queue287 && state.queue287.entity === 'spread'
      && state.queue287.local_id === REPAIR_910.localSpreadId && state.queue287.status === 'conflict'
      && state.queue287.last_error === 'revision conflict', explicitQueueFields(state.queue287));
    repair910Check(checks, 'no additional target queue rows', targetQueue.length === 2
      && targetQueue.every(item => [String(REPAIR_910.photoQueueId),String(REPAIR_910.spreadQueueId)].includes(String(item.id))),
      targetQueue.map(item => ({id:item.id, entity:item.entity, status:item.status})));
    repair910Check(checks, 'server GET checks', !state.serverError, state.serverError);
    repair910Check(checks, 'server 9-10 absent', serverTargets.length === 0,
      serverTargets.map(row => ({id:row.id, client_ref:row.client_ref, number:row.number, title:row.title, revision:row.revision})));
    repair910Check(checks, 'server order 1..27', repair910Contiguous(state.serverSpreads, REPAIR_910.expectedServerCount),
      state.serverSpreads.map(row => row.number).sort((a,b) => a-b));
    repair910Check(checks, 'local/server order and revisions current', localMappingsCurrent, null);
    repair910Check(checks, 'server 3-4 current', !!state.anchor && state.anchor.id === REPAIR_910.anchorServerId
      && state.anchor.notebook_id === REPAIR_910.serverNotebookId && state.anchor.title === '3-4'
      && Number(state.anchor.number) === 3 && Number(state.anchor.revision) === 6 && !state.anchor.deleted_at
      && !!localAnchor && localAnchor.id === REPAIR_910.anchorClientRef && Number(localAnchor.revision) === Number(state.anchor.revision),
      state.anchor ? {id:state.anchor.id, number:state.anchor.number, title:state.anchor.title, revision:state.anchor.revision} : null);
    repair910Check(checks, 'unique next spread 11-12', next.length === 1 && Number(next[0].number) === 4,
      next.map(row => ({id:row.id, number:row.number, revision:row.revision})));

    const eligible = checks.every(check => check.pass);
    const backup = repair910Backup(state);
    return {
      eligible,
      checks,
      backup,
      guard:repair910Guard(state),
      plan:{
        temporary_number:REPAIR_910.expectedServerCount + 1,
        final_position:4,
        before_server_id:REPAIR_910.anchorServerId,
        before_title:'3-4',
        after_title:'11-12',
        queue_286:'upload through the normal photo queue path; mark done only on success',
        queue_287:'retire only after server photo metadata and Telegram link are confirmed',
        queue_367:'read guard only; never update or retry',
        blobs:'preserve orig and thumb regardless of offline-original setting',
      },
      _state:state,
    };
  }

  function repair910ValidateCreated(created, local, temporaryNumber) {
    return !!created && created.notebook_id === REPAIR_910.serverNotebookId
      && created.client_ref === REPAIR_910.localSpreadId && Number(created.number) === temporaryNumber
      && Number(created.revision) > 0 && repair910BusinessMatches(local, created) && !created.deleted_at;
  }

  function repair910OrderedRows(rows, targetServerId) {
    if (!repair910Contiguous(rows, REPAIR_910.expectedServerCount + 1)) throw new Error('STOP: server order changed after spread creation');
    const sorted = rows.slice().sort((a,b) => Number(a.number) - Number(b.number));
    const target = sorted.find(row => row.id === targetServerId);
    const anchor = sorted.find(row => row.id === REPAIR_910.anchorServerId);
    const next = sorted.filter(row => row.title === '11-12');
    if (!target || Number(target.number) !== REPAIR_910.expectedServerCount + 1 || !anchor
        || Number(anchor.number) !== 3 || next.length !== 1 || Number(next[0].number) !== 4) {
      throw new Error('STOP: repair anchors changed before reorder');
    }
    const withoutTarget = sorted.filter(row => row.id !== target.id);
    const insertion = withoutTarget.findIndex(row => row.id === next[0].id);
    withoutTarget.splice(insertion, 0, target);
    return withoutTarget;
  }

  async function applyRepair910(expectedGuard) {
    if (!expectedGuard) throw new Error('Сначала выполните Preview и скопируйте backup JSON');
    if (syncing) throw new Error('STOP: уже выполняется синхронизация');
    syncing = true;
    await updateSyncIndicator();
    try {
      const preview = await buildRepair910Preview();
      if (!preview.eligible || preview.guard !== expectedGuard) throw new Error('STOP: состояние изменилось после Preview; ничего не применено');
      const state = preview._state;
      const queue367Before = JSON.stringify(sanitizeDiagnosticValue(state.queue367));
      const temporaryNumber = REPAIR_910.expectedServerCount + 1;
      const createResult = await api(`/api/notebooks/${encodeURIComponent(REPAIR_910.serverNotebookId)}/spreads`, {method:'POST', json:{
        number:temporaryNumber, title:state.spread.title, note_short:state.spread.note_short,
        note_full:state.spread.note_full, status:state.spread.status, client_ref:REPAIR_910.localSpreadId,
      }});
      const created = createResult?.spread;
      if (!repair910ValidateCreated(created, state.spread, temporaryNumber)) throw new Error('STOP: server returned an unexpected spread');
      await window.vNextAtomic('spreads', REPAIR_910.localSpreadId, current => {
        if (!current || current.server_id || current.title !== '9-10' || current.current_photo_id !== REPAIR_910.localPhotoId) {
          throw new Error('STOP: local spread changed during creation');
        }
        return {row:{...current, server_id:created.id, number:created.number, revision:created.revision,
          metadata_base:metadata(created), updated_at:created.updated_at || current.updated_at}};
      });

      const afterCreate = await api(`/api/notebooks/${encodeURIComponent(REPAIR_910.serverNotebookId)}/spreads`);
      const ordered = repair910OrderedRows(afterCreate?.spreads || [], created.id);
      const orderResult = await api(`/api/notebooks/${encodeURIComponent(REPAIR_910.serverNotebookId)}/spreads/order`, {method:'PUT', json:{
        client_ref:'repair-9-10-order-mtlf4xgftqrtxh-v1',
        items:ordered.map(row => ({spread_id:row.id, expected_revision:Number(row.revision), expected_number:Number(row.number)})),
      }});
      const reordered = Array.isArray(orderResult?.spreads) ? orderResult.spreads : [];
      if (!repair910Contiguous(reordered, REPAIR_910.expectedServerCount + 1)) throw new Error('STOP: invalid reorder response');
      const reorderedTarget = reordered.find(row => row.id === created.id);
      const reorderedAnchor = reordered.find(row => row.id === REPAIR_910.anchorServerId);
      const reorderedNext = reordered.filter(row => row.title === '11-12');
      if (!reorderedTarget || Number(reorderedTarget.number) !== 4 || !reorderedAnchor || Number(reorderedAnchor.number) !== 3
          || reorderedNext.length !== 1 || Number(reorderedNext[0].number) !== 5) throw new Error('STOP: 9-10 was not placed between 3-4 and 11-12');
      await applyChangeBatch({spreads:reordered.filter(row => row.id !== created.id)});
      const targetAfterCreate = await get('spreads', REPAIR_910.localSpreadId);
      await put('spreads', {...targetAfterCreate, server_id:created.id, number:reorderedTarget.number,
        revision:reorderedTarget.revision, updated_at:reorderedTarget.updated_at || targetAfterCreate.updated_at,
        metadata_base:metadata(reorderedTarget), server_current_photo_id:reorderedTarget.current_photo_id || null});

      await pushPhotoQueue(true, {onlyItemIds:[REPAIR_910.photoQueueId], preserveOriginals:true,
        restoreOnFailure:true, throwOnError:true});
      const photo = await get('photos', REPAIR_910.localPhotoId);
      const queue286 = await get('sync_queue', REPAIR_910.photoQueueId);
      if (!photo?.server_id || photo.upload_status !== 'synced' || queue286?.status !== 'done'
          || !photo.telegram_message_id || !photo.telegram_link) throw new Error('STOP: photo upload did not return complete Telegram metadata');
      const serverPhoto = (await api(`/api/photos/${encodeURIComponent(photo.server_id)}`))?.photo;
      if (!serverPhoto || serverPhoto.id !== photo.server_id || serverPhoto.spread_id !== created.id
          || !serverPhoto.telegram_message_id || !serverPhoto.telegram_link) throw new Error('STOP: server photo verification failed');

      const finalList = await api(`/api/notebooks/${encodeURIComponent(REPAIR_910.serverNotebookId)}/spreads`);
      const finalRows = Array.isArray(finalList?.spreads) ? finalList.spreads : [];
      const finalTarget = finalRows.find(row => row.id === created.id);
      if (!repair910Contiguous(finalRows, REPAIR_910.expectedServerCount + 1) || !finalTarget
          || Number(finalTarget.number) !== 4 || !repair910BusinessMatches(state.spread, finalTarget)) {
        throw new Error('STOP: final server spread verification failed');
      }
      const queue287 = await get('sync_queue', REPAIR_910.spreadQueueId);
      if (!queue287 || queue287.status !== 'conflict' || queue287.local_id !== REPAIR_910.localSpreadId) {
        throw new Error('STOP: queue #287 changed before retirement');
      }
      await window.vNextAtomic('spreads', REPAIR_910.localSpreadId, current => {
        if (!current || current.server_id !== created.id || current.current_photo_id !== REPAIR_910.localPhotoId) {
          throw new Error('STOP: local mapping changed before queue retirement');
        }
        return {row:{...current, number:finalTarget.number, revision:finalTarget.revision,
          updated_at:finalTarget.updated_at || current.updated_at, metadata_base:metadata(finalTarget), conflict:null,
          server_current_photo_id:finalTarget.current_photo_id || photo.server_id},
          retired:[{...queue287, status:'done', retry_count:queue287.retry_count || 0, next_attempt_at:null,
            retired_at:nowISO(), retired_reason:'Repair 9-10 completed and photo verified',
            retired_previous_error:queue287.last_error || null, last_error:null, server_copy:null}]};
      });
      await applyChangeBatch({spreads:finalRows.filter(row => row.id !== created.id)});

      const [finalSpread, finalPhoto, finalQueue286, finalQueue287, finalQueue367, finalOrig, finalThumb] = await Promise.all([
        get('spreads', REPAIR_910.localSpreadId), get('photos', REPAIR_910.localPhotoId),
        get('sync_queue', REPAIR_910.photoQueueId), get('sync_queue', REPAIR_910.spreadQueueId),
        get('sync_queue', REPAIR_910.untouchedQueueId), blobDiagnostic(REPAIR_910.localPhotoId + '_orig'),
        blobDiagnostic(REPAIR_910.localPhotoId + '_thumb'),
      ]);
      if (JSON.stringify(sanitizeDiagnosticValue(finalQueue367)) !== queue367Before) throw new Error('STOP: queue #367 changed unexpectedly');
      const blobsPreserved = finalOrig.exists && finalThumb.exists
        && Number(finalOrig.size) === REPAIR_910.expectedOrigSize && Number(finalThumb.size) === REPAIR_910.expectedThumbSize;
      if (!blobsPreserved) throw new Error('STOP: local photo blobs changed unexpectedly');
      const totals = queueStatusCounts(await getAll('sync_queue'));
      return {
        completed:true,
        backup:preview.backup,
        spread_server_id:finalSpread.server_id,
        spread_revision:finalSpread.revision,
        final_number:finalSpread.number,
        photo_server_id:finalPhoto.server_id,
        telegram_message_id_present:!!finalPhoto.telegram_message_id,
        telegram_link_present:!!finalPhoto.telegram_link,
        queue_286_status:finalQueue286?.status || null,
        queue_287_status:finalQueue287?.status || null,
        queue_367_unchanged:true,
        totals,
        data_preserved:blobsPreserved && finalSpread.id === REPAIR_910.localSpreadId && finalPhoto.id === REPAIR_910.localPhotoId,
      };
    } finally {
      syncing = false;
      await updateSyncIndicator();
    }
  }

  async function openRepair910() {
    let preview = null, copiedGuard = null;
    const {el,close} = openSheet(`<div class="sheet-handle"></div><div class="v352-diag-head">
      <h2>Repair 9-10</h2><button class="icon-btn" data-repair-close aria-label="Закрыть Repair 9-10">✕</button></div>
      <p class="warn-box">Временный точечный инструмент только для queue #286/#287. Queue #367 не изменяется и не повторяется.</p>
      <button class="btn-secondary" data-repair-preview>Preview / READ-ONLY</button>
      <div data-repair-report></div>
      <details hidden data-repair-backup-wrap><summary>Backup JSON</summary><pre data-repair-backup></pre></details>
      <div class="btn-row"><button class="btn-secondary" data-repair-copy disabled>Копировать backup JSON</button>
      <button class="btn-primary" data-repair-apply disabled>Apply Repair</button></div>`);
    el.querySelector('[data-repair-close]').onclick = close;
    const reportHost = el.querySelector('[data-repair-report]');
    const backupWrap = el.querySelector('[data-repair-backup-wrap]');
    const backupHost = el.querySelector('[data-repair-backup]');
    const previewButton = el.querySelector('[data-repair-preview]');
    const copyButton = el.querySelector('[data-repair-copy]');
    const applyButton = el.querySelector('[data-repair-apply]');
    previewButton.onclick = async () => {
      previewButton.disabled = true; copyButton.disabled = true; applyButton.disabled = true; copiedGuard = null;
      reportHost.textContent = 'Проверяю локальные данные и выполняю только GET…';
      try {
        preview = await buildRepair910Preview();
        reportHost.innerHTML = `<h3>${preview.eligible ? 'Все проверки PASS' : 'STOP: есть несовпадения'}</h3>
          <ul>${preview.checks.map(check => `<li>${check.pass ? '✅' : '❌'} ${esc(check.key)}${check.detail === null ? '' : `<details><summary>Детали</summary>${diagnosticPre(check.detail)}</details>`}</li>`).join('')}</ul>
          <h3>План изменений</h3>${diagnosticPre(preview.plan)}`;
        backupHost.textContent = JSON.stringify(preview.backup, null, 2);
        backupWrap.hidden = false; copyButton.disabled = false;
      } catch (error) {
        preview = null; reportHost.innerHTML = `<p class="warn-box">STOP: ${esc(error.message || error)}</p>`;
      } finally { previewButton.disabled = false; }
    };
    copyButton.onclick = async () => {
      if (!preview) return;
      copyButton.disabled = true;
      try {
        const copied = await copyDiagnosticText(JSON.stringify(preview.backup, null, 2));
        if (!copied) throw new Error('clipboard copy failed');
        copiedGuard = preview.guard;
        applyButton.disabled = !preview.eligible;
        toast('Backup JSON скопирован. Apply доступен только для неизменившегося PASS-состояния.');
      } catch (error) { copiedGuard = null; applyButton.disabled = true; toast('Не удалось скопировать backup JSON'); }
      finally { copyButton.disabled = false; }
    };
    applyButton.onclick = async () => {
      applyButton.disabled = true; previewButton.disabled = true; copyButton.disabled = true;
      reportHost.innerHTML = '<p>Выполняется точечный repair. Не закрывайте приложение…</p>';
      try {
        const result = await applyRepair910(copiedGuard);
        reportHost.innerHTML = `<h3>Repair завершён</h3>${diagnosticPre(result)}`;
        backupHost.textContent = JSON.stringify(result.backup, null, 2);
        toast('Repair 9-10 завершён');
      } catch (error) {
        reportHost.innerHTML = `<p class="warn-box">${esc(error.message || error)}</p><p>Остановлено. Queue #367 не изменялась этим инструментом.</p>`;
      } finally { previewButton.disabled = false; copyButton.disabled = !preview; }
    };
  }

  async function openReadOnlySyncDiagnostics() {
    const report = await buildReadOnlyDiagnosticReport();
    const serverChecks = new Map();
    const {el, close} = openSheet(`<div class="sheet-handle"></div><div class="v352-diag-head">
      <h2>Диагностика синхронизации</h2><button class="icon-btn" data-diag-close aria-label="Закрыть диагностику">✕</button></div>
      <p class="warn-box">READ-ONLY: этот экран не запускает sync/retry и не меняет IndexedDB, очередь, сервер или conflicts.</p>
      <div data-diag-summary></div><div class="btn-row"><button class="btn-secondary" data-copy-report>Копировать отчёт</button></div>
      <div data-diag-items></div>`);
    el.closest('.sheet-backdrop')?.classList.add('v352-diag-sheet');
    el.querySelector('[data-diag-close]').onclick = close;
    const summaryHost = el.querySelector('[data-diag-summary]');
    const itemsHost = el.querySelector('[data-diag-items]');
    summaryHost.innerHTML = diagnosticTable({
      app_version:report.app_version, backend_origin:report.backend_origin, current_user_id:report.current_user_id,
      current_role:report.current_role, current_role_source:report.current_role_source, sync_scope:report.sync_scope, sync_cursor:report.sync_cursor,
      last_sync_at:report.last_sync_at, online:report.online, authenticated:report.authenticated,
      total_unsynced:report.queue_counts.total_unsynced, pending:report.queue_counts.pending,
      syncing:report.queue_counts.syncing, failed:report.queue_counts.failed, conflict:report.queue_counts.conflict,
    });
    if (!report.items.length) itemsHost.innerHTML = '<div class="empty-state">Незавершённых записей sync_queue нет.</div>';
    report.items.forEach((item, index) => {
      const card = document.createElement('article');
      card.className = 'v352-diag-card';
      card.innerHTML = `<h3>#${esc(item.id)} · ${esc(item.entity)} · ${esc(item.status)}</h3>
        ${diagnosticTable({local_id:item.local_id, server_id:item.server_id, spread_id:item.spread_id,
          photo_id:item.photo_id, note_id:item.note_id, tag_id:item.tag_id, scope:item.scope,
          retry_count:item.retry_count, last_error:item.last_error, error:item.error, sync_error:item.sync_error, method:item.method,
          op:item.op, revision:item.revision, base_revision:item.base_revision})}
        <button class="btn-secondary" data-server-check="${index}">Проверить на сервере</button>
        <div data-server-result="${index}" class="v352-diag-result"></div>
        <details open><summary>Local spread</summary>${diagnosticPre(item.local_spread)}</details>
        <details><summary>Photo metadata / blobs</summary>${diagnosticPre(item.photos)}</details>
        <details><summary>Queue payload</summary>${diagnosticPre(item.payload)}</details>
        <details><summary>server_copy / conflict data</summary>${diagnosticPre({server_copy:item.server_copy, conflict_data:item.conflict_data})}</details>`;
      itemsHost.appendChild(card);
    });
    itemsHost.addEventListener('click', async event => {
      const button = event.target.closest('[data-server-check]');
      if (!button) return;
      const index = Number(button.dataset.serverCheck);
      const item = report.items[index];
      const host = itemsHost.querySelector(`[data-server-result="${index}"]`);
      button.disabled = true; host.textContent = 'Проверяю только GET…';
      const spreadServerId = item?.local_spread?.exists ? item.local_spread.server_id : null;
      const result = await checkSpreadOnServerReadOnly(spreadServerId,
        item?.local_spread?.exists ? item.local_spread : null);
      serverChecks.set(String(item?.id ?? index), result);
      host.innerHTML = diagnosticPre(result);
      button.disabled = false;
    });
    el.querySelector('[data-copy-report]').onclick = async event => {
      event.target.disabled = true;
      try {
        const fresh = await buildReadOnlyDiagnosticReport();
        fresh.server_checks = Object.fromEntries(serverChecks.entries());
        const text = JSON.stringify(fresh, null, 2);
        await copyDiagnosticText(text);
        toast('Диагностический отчёт скопирован');
      } catch (error) {
        console.warn('Diagnostic report copy failed', error);
        toast('Не удалось скопировать отчёт');
      } finally { event.target.disabled = false; }
    };
  }

  window.v340Sync = {retryDelay, retryDue, mapServerPhoto, diagnostics, conflictGroups, openConflictDiagnostics,
    assessLegacySpreadConflict, safeResolveDuplicateSpreadConflicts, notebookConflictGroups, resolveNotebookConflict, reconcileNotebookConflicts,
    buildReadOnlyDiagnosticReport, checkSpreadOnServerReadOnly, openReadOnlySyncDiagnostics,
    buildRepair910Preview, applyRepair910, repair910OrderedRows};
  window.vNextSync = {scope, enabled, metadata, saveNote, noteConflict, resolveNote, saveFields, applyTeamChanges, cacheNote, requestRemoteRefresh};
  window.v350OpenSyncDiagnostics = openReadOnlySyncDiagnostics;
  window.v350BuildSyncDiagnosticReport = buildReadOnlyDiagnosticReport;
  window.v353OpenRepair910 = openRepair910;
  const baseQueueEntityChange = typeof queueEntityChange === 'function' ? queueEntityChange : async (entity, localId, extra = {}) => {
    await put('sync_queue', {entity, local_id:localId, status:'pending', retry_count:0, ...extra});
  };
  queueEntityChange = async function (entity, localId, extra = {}) {
    if (entity !== 'notebook') return baseQueueEntityChange(entity, localId, extra);
    const queue = await getAll('sync_queue');
    const same = queue.filter(item => item.entity === 'notebook' && item.local_id === localId
      && (!item.scope || item.scope === scope()) && UNSYNCED.has(item.status));
    const reusable = same.find(item => item.status === 'pending' || item.status === 'failed');
    if (reusable) {
      await put('sync_queue', {...reusable, ...extra, scope:scope(), status:'pending', retry_count:0,
        last_error:null, next_attempt_at:null});
    } else if (!same.some(item => item.status === 'conflict')) {
      await baseQueueEntityChange(entity, localId, {...extra, scope:scope()});
      return;
    }
    void fullSync();
  };
  // The base pull loop only knows about changes and the cursor; unread counts arrive in the same
  // envelope, so the loop is kept here where the server response is available.
  pullChanges = async function () {
    const sessionScope = scope();
    let hasMore = true;
    let guard = 0;
    while (hasMore && guard < 20) {
      guard++;
      const data = await api(`/api/sync?since=${settings.sync_cursor}&limit=500`);
      assertScope(sessionScope);
      await applyChangeBatch(data.changes || {});
      assertScope(sessionScope);
      if (data.unread) {
        settings.unread_by_notebook = data.unread.notebooks || {};
        settings.unread_spreads = data.unread.spreads || {};
        settings.unread_total = data.unread.total || 0;
        await saveSettings();
        window.BlocknotV3?.emit('unread-change');
      }
      settings.sync_cursor = data.next_cursor;
      await saveSettings();
      hasMore = !!data.has_more;
    }
  };

  if (document.head && typeof document.createElement === 'function') {
    const diagnosticStyle = document.createElement('style');
    diagnosticStyle.textContent = `.v350-conflict-diagnostic,.v352-diag-card{margin:12px 0;padding:12px;border:1px solid var(--border);border-radius:12px;background:var(--surface)}
      .v350-conflict-diagnostic h3,.v352-diag-card h3{margin:0 0 10px}.v350-conflict-diagnostic p,.v352-diag-card p{overflow-wrap:anywhere}
      .v350-conflict-diagnostic details,.v352-diag-card details{margin-top:8px}.v350-conflict-diagnostic summary,.v352-diag-card summary{cursor:pointer;font-weight:600}
      .v350-conflict-diagnostic pre,.v352-diag-card pre{white-space:pre-wrap;overflow-wrap:anywhere;padding:8px;border-radius:8px;background:var(--surface-2);font-size:.78rem;max-height:45vh;overflow:auto}
      .v352-diag-head{display:flex;align-items:center;justify-content:space-between;gap:8px}.v352-diag-head h2{margin:0}
      .v352-diag-kv{display:grid;grid-template-columns:minmax(92px,.85fr) minmax(0,1.4fr);gap:6px 10px;font-size:.82rem}.v352-diag-kv dt{font-weight:700;color:var(--ink-soft);overflow-wrap:anywhere}.v352-diag-kv dd{margin:0;overflow-wrap:anywhere}
      .v352-diag-result{margin-top:8px}`;
    document.head.appendChild(diagnosticStyle);
  }
})();
