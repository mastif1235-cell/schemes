import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const swSource = fs.readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
const indexSource = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

function createWorker({failInstall = false, offline = true} = {}) {
  const handlers = {};
  const deleted = [];
  const entries = new Map([['./index.html', new Response('cached-index', {status:200})]]);
  let skipWaitingCalls = 0;
  const cache = {
    addAll: async urls => {
      if (failInstall) throw new Error('missing shell file');
      for (const url of urls) if (!entries.has(url)) entries.set(url, new Response(url));
    }
  };
  const caches = {
    open: async () => cache,
    keys: async () => ['blocknot-shell-v30', 'blocknot-shell-v340', 'unrelated-cache'],
    delete: async key => { deleted.push(key); return true; },
    match: async request => {
      const key = typeof request === 'string' ? request : new URL(request.url).pathname.split('/').pop();
      return entries.get(key) || entries.get('./' + key);
    }
  };
  const self = {
    location:{origin:'https://example.test'},
    clients:{claim:async () => {}},
    skipWaiting:async () => { skipWaitingCalls++; },
    addEventListener:(type, handler) => { handlers[type] = handler; }
  };
  const context = {
    self, caches, URL, Request, Response, Promise,
    fetch:async request => {
      if (offline) throw new Error('offline');
      return new Response('network:' + request.url);
    }
  };
  vm.createContext(context);
  vm.runInContext(swSource, context, {filename:'sw.js'});
  return {handlers, deleted, getSkipWaitingCalls:() => skipWaitingCalls};
}

async function dispatchWait(handler, extra = {}) {
  let promise;
  handler({waitUntil:value => { promise = value; }, ...extra});
  return promise;
}

async function dispatchFetch(handler, request) {
  let promise;
  handler({request, respondWith:value => { promise = value; }});
  return promise;
}

assert.doesNotMatch(indexSource, /getRegistrations\s*\(/);
assert.doesNotMatch(indexSource, /\.unregister\s*\(/);
assert.doesNotMatch(indexSource, /location\.replace\s*\(/);

{
  const worker = createWorker();
  await dispatchWait(worker.handlers.install);
  assert.equal(worker.getSkipWaitingCalls(), 0, 'install must not force activation');
  worker.handlers.message({data:{type:'SKIP_WAITING'}});
  assert.equal(worker.getSkipWaitingCalls(), 1, 'explicit update command activates waiting worker');
}

{
  const worker = createWorker({failInstall:true});
  await assert.rejects(dispatchWait(worker.handlers.install), /missing shell file/);
}

{
  const worker = createWorker({offline:true});
  const response = await dispatchFetch(worker.handlers.fetch, {
    url:'https://example.test/schemes/', method:'GET', mode:'navigate', headers:new Headers(),
    credentials:'same-origin', redirect:'follow'
  });
  assert.equal(await response.text(), 'cached-index');
}

{
  const worker = createWorker();
  await dispatchWait(worker.handlers.activate);
  assert.deepEqual(worker.deleted, ['blocknot-shell-v30', 'blocknot-shell-v340']);
}

console.log('sw-offline: PASS');
