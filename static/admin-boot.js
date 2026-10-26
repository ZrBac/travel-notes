/* Login stays small; versioned page assets are declared in an inert HTML template. */
const AdminAssets = (() => {
  const template = document.querySelector('#admin-assets');
  const entries = new Map([...template.content.querySelectorAll('script[src],link[href]')].map((node, order) => {
    const url = node.getAttribute('src') || node.getAttribute('href');
    return [new URL(url, location.href).pathname.split('/').pop(), {url, order, style: node.tagName === 'LINK'}];
  }));
  const pending = new Map();
  const groups = {
    base: {files: ['image-utils.js', 'travel-images.js', 'admin-workspace.js', 'dialog-dismiss.js']},
    images: {needs: ['base'], files: ['admin-images.js']},
    core: {needs: ['images'], files: ['admin.js']},
    shell: {needs: ['core'], files: ['admin-mobile.js']},
    editor: {files: ['travel-editor.css', 'travel-editor.js', 'guide-visual.css']},
    guide: {needs: ['editor'], files: ['guide-templates.js']},
    records: {files: ['footprints-admin.css', 'footprints-admin.js']},
    recordEditor: {needs: ['records', 'editor'], files: ['record-templates.js', 'record-assistant.js', 'record-album.js']},
    journey: {files: ['journey-view.js', 'journey-view.css', 'guide-visual.css']},
    trips: {files: ['trips.css', 'trips.js']},
    trip: {needs: ['trips', 'journey'], files: ['trip-assistant.css', 'trip-assistant.js', 'agent-admin.css']},
    tasks: {files: ['task-manager.js', 'agent-admin.css']},
    planner: {needs: ['tasks', 'journey'], files: ['travel-planner.css', 'travel-planner.js']},
    agent: {needs: ['tasks'], files: ['agent-admin.js']},
    account: {files: ['admin-accounts.js']}
  };
  function load(name) {
    if (pending.has(name)) return pending.get(name);
    const entry = entries.get(name);
    if (!entry) return Promise.reject(new Error('页面资源缺失，请刷新后重试。'));
    const promise = new Promise((resolve, reject) => {
      const node = document.createElement(entry.style ? 'link' : 'script');
      node.dataset.adminAsset = name;
      node.onload = () => resolve();
      node.onerror = () => {
        node.remove(); pending.delete(name);
        reject(new Error('页面资源加载失败，请检查网络后重试。'));
      };
      if (entry.style) {
        node.rel = 'stylesheet'; node.href = entry.url; node.dataset.adminStyleOrder = entry.order;
        // Keep the original cascade regardless of which page is visited first.
        const next = [...document.head.querySelectorAll('[data-admin-style-order]')].find(item => Number(item.dataset.adminStyleOrder) > entry.order);
        document.head.insertBefore(node, next || document.querySelector('#admin-feature-styles'));
      } else {
        node.src = entry.url;
        document.head.append(node);
      }
    });
    pending.set(name, promise);
    return promise;
  }
  function check(signal) {
    if (signal?.aborted) throw new DOMException('页面已切换', 'AbortError');
  }
  function wait(promise, signal) {
    return new Promise((resolve, reject) => {
      const abort = () => finish(new DOMException('页面已切换', 'AbortError'));
      const timer = setTimeout(() => finish(new Error('页面资源加载超时，请检查网络后重试。')), 15000);
      function finish(error, value) {
        clearTimeout(timer); signal?.removeEventListener('abort', abort);
        if (error) reject(error); else resolve(value);
      }
      signal?.addEventListener('abort', abort, {once: true});
      if (signal?.aborted) abort();
      // A timeout/cancel only stops this waiter. Keep a shared download alive so
      // a retry cannot execute a late classic script twice (global consts).
      promise.then(value => finish(null, value), error => finish(error));
    });
  }
  async function ensure(name, signal) {
    check(signal);
    const group = groups[name];
    await Promise.all((group.needs || []).map(dependency => ensure(dependency, signal)));
    check(signal);
    await wait(Promise.all(group.files.map(load)), signal);
  }
  function page(view, id, signal) {
    const group = ({trips: 'trips', 'trip-new': 'trips', trip: 'trip', records: 'records', 'record-trash': 'records', 'record-new': 'recordEditor', 'record-edit': 'recordEditor', new: 'guide', edit: 'guide', 'travel-agent': 'planner', agent: 'agent', account: 'account'})[view] || (view === 'import' && id ? 'guide' : null);
    return group ? ensure(group, signal) : Promise.resolve();
  }
  return {core: () => ensure('shell'), page};
})();

(() => {
  const form = document.querySelector('#login-form');
  const loading = document.querySelector('#loading');
  const login = document.querySelector('#login-page');
  const error = document.querySelector('#login-error');
  const submit = form.querySelector('button[type=submit]');
  let session = null, busy = false;
  async function request(path, body) {
    const controller = body ? null : new AbortController();
    const timer = controller ? setTimeout(() => controller.abort(), 15000) : null;
    try {
      const response = await fetch('/api/' + path, {method: body ? 'POST' : 'GET', credentials: 'same-origin',
        ...(body ? {headers: {'Content-Type': 'application/json', 'X-CSRF-Token': session?.csrf || ''}, body: JSON.stringify(body)} : {signal: controller.signal})});
      const data = await response.json();
      if (controller?.signal.aborted) throw new DOMException('请求超时', 'AbortError');
      if (!response.ok) throw new Error(data.error || '登录失败，请重试。');
      return data;
    } catch (e) {
      if (controller?.signal.aborted) throw new Error('连接超时，请检查网络后重试。');
      if (e instanceof TypeError || e instanceof SyntaxError) throw new Error('暂时无法连接管理后台，请稍后重试。');
      throw e;
    } finally { clearTimeout(timer); }
  }
  function failure(message) {
    login.hidden = true; loading.hidden = false; loading.replaceChildren();
    const copy = document.createElement('p'); copy.textContent = message; copy.setAttribute('role', 'alert');
    const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'button primary';
    retry.id = 'admin-boot-retry'; retry.textContent = '重新加载'; retry.addEventListener('click', start);
    loading.append(copy, retry);
  }
  async function enter() {
    login.hidden = true; loading.hidden = false; loading.textContent = '正在打开管理空间…';
    await AdminAssets.core();
    const initial = session; session = null;
    form.removeEventListener('submit', signIn);
    await init(initial);
  }
  async function start() {
    if (busy) return;
    busy = true; submit.disabled = true; form.inert = true;
    loading.hidden = false; loading.textContent = '正在打开管理空间…';
    try {
      if (!session) session = await request('session');
      if (session.user) await enter();
      else { loading.hidden = true; login.hidden = false; }
    } catch (e) { failure(e.message); }
    finally { busy = false; submit.disabled = false; form.inert = false; }
  }
  async function signIn(event) {
    event.preventDefault(); event.stopImmediatePropagation();
    if (busy || !form.reportValidity()) return;
    busy = true; submit.disabled = true; form.inert = true; error.textContent = '';
    try {
      session = await request('login', Object.fromEntries(new FormData(form)));
      form.elements.password.value = '';
      try { await enter(); } catch (e) { failure(e.message); }
    } catch (e) { error.textContent = e.message; }
    finally { busy = false; submit.disabled = false; form.inert = false; }
  }
  form.addEventListener('submit', signIn);
  void start();
})();
