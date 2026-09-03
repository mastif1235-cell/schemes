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

  async function cacheNote(note, localSpread, force = false) {
    const cache_id = scope() + '|' + note.id;
    const local = await get('spread_notes', cache_id);
    if (!force && local?.pending) return;
    await put('spread_notes', {...local, ...note, cache_id, scope:scope(), server_id:note.id,
      server_spread_id:note.spread_id, spread_id:localSpread.id, notebook_id:localSpread.notebook_id, pending:false, sync_error:null});
  }

  async function applyTeamChanges(changes) {
    const spreads = await getAll('spreads');
    for (const note of changes.spread_notes || []) {
      const spread = spreads.find(row => row.server_id === note.spread_id);
      // Never advance the shared cursor past a child we could not persist.
      if (!spread) throw new Error('Примечание ожидает загрузки разворота');
      await cacheNote(note, spread);
    }
    for (const event of changes.activity_events || []) {
      await put('activity_events', {...event, cache_id:scope() + '|' + event.id, scope:scope()});
    }
  }

  async function saveNote(spread, body, existing = null, remove = false) {
    if (!isAuthed() || !enabled('team_notes')) throw new Error('Примечания доступны после обновления сервера');
    if (!remove && (!body.trim() || body.trim().length > 10000)) throw new Error('Введите примечание до 10000 символов');
    const id = existing?.id || uid(), cache_id = scope() + '|' + id;
    await window.vNextAtomic('spread_notes', cache_id, current => {
      if (current?.pending) throw new Error('Сначала синхронизируйте предыдущее изменение примечания');
      if (existing && (!current || current.author_id !== settings.user_id || current.deleted_at)) throw new Error('Можно изменить только своё доступное примечание');
      const now = nowISO();
      const row = {...current, id, cache_id, scope:scope(), spread_id:spread.id, notebook_id:spread.notebook_id,
        author_id:settings.user_id, author_display_name:settings.user_display_name,
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
      telegram_link: serverPhoto.telegram_link || null,
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

  pushPhotoQueue = async function (forceRetry) {
    const queue = (await getAll('sync_queue')).filter(item =>
      item.entity === 'photo' && retryDue(item, !!forceRetry)
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
      photo.upload_status = 'uploading';
      await put('photos', photo);
      try {
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
        const data = await resp.json();
        photo.storage_object_id = data.storage_object_id;
        photo.telegram_message_id = data.message_id;
        photo.telegram_file_id = data.file_id;
        photo.telegram_file_unique_id = data.file_unique_id;
        photo.telegram_link = data.telegram_link || null;
        photo.server_id = data.photo_id || photo.server_id;
        photo.upload_status = 'synced';
        await put('photos', photo);
        if (data.spread_revision) {
          spread.revision = data.spread_revision;
          await put('spreads', spread);
        }
        markDone(item);
        await put('sync_queue', item);
        if (!settings.keep_originals_offline) await del('blobs', photo.id + '_orig');
      } catch (error) {
        photo.upload_status = 'upload_failed';
        await put('photos', photo);
        markRetry(item, error);
        await put('sync_queue', item);
        console.warn('Photo upload failed; retry scheduled', photo.id, error);
      }
    }
  };

  applyChangeBatch = async function (changes) {
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
    updateSyncIndicator();
    try {
      if (isAuthed()) {
        const sessionScope = scope();
        const me = await api('/api/me');
        assertScope(sessionScope);
        settings.team_capabilities = {scope:sessionScope, flags:me.capabilities || {}};
        await pushEntityQueue(!!manual);
        await pushPhotoQueue(!!manual);
        await syncMembership();
        await pullChanges();
      } else {
        await pushPhotoQueue(!!manual);
      }
      const remaining = (await getAll('sync_queue')).some(item => UNSYNCED.has(item.status));
      settings.sync_status = remaining ? 'pending' : 'idle';
      settings.last_sync_at = nowISO();
    } catch (error) {
      settings.sync_status = 'error';
      console.error('Synchronization failed', error);
      if (manual) toast('Ошибка синхронизации: ' + (error.message || error));
    }
    await saveSettings();
    syncing = false;
    updateSyncIndicator();
    window.BlocknotV3?.emit('sync-complete');
    if (route.screen === 'settings') {
      const el = document.getElementById('syncStatus');
      if (el) renderSyncStatus(el);
    }
    if (manual && settings.sync_status === 'idle') toast('Синхронизация завершена');
    else if (manual && settings.sync_status === 'pending') toast('Часть изменений ожидает зависимые данные или повторную отправку');
  };

  window.v340Sync = {retryDelay, retryDue, mapServerPhoto};
  window.vNextSync = {scope, enabled, metadata, saveNote, saveFields, applyTeamChanges, cacheNote};
})();
