const { session } = require('electron');

function localUrl(input, hosts) {
  if (typeof input !== 'string' || input.length > 2048) throw new Error('Enter a localhost address.');
  const value = input.trim();
  const url = new URL(/^https?:\/\//i.test(value) ? value : 'http://' + value);
  if (!['http:', 'https:'].includes(url.protocol) || !hosts.has(url.hostname)
      || url.username || url.password) {
    throw new Error('Preview supports only localhost and local hosts-file aliases.');
  }
  return url.href;
}

function createPreview(window, notify) {
  const partition = session.fromPartition('perona-local-preview');
  const direct = partition.setProxy({ mode: 'direct' });
  partition.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  partition.setPermissionCheckHandler(() => false);
  partition.on('will-download', event => event.preventDefault());
  let contents;
  let owner;
  let allowedHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
  let location;
  let resetHistory = false;
  const restrict = (event, url) => {
    try { localUrl(event.url || url, allowedHosts); } catch { event.preventDefault(); }
  };
  let attaching = false;
  window.webContents.on('will-attach-webview', (event, preferences, params) => {
    if (attaching || contents || params.src !== 'about:blank' || params.partition !== 'perona-local-preview') {
      event.preventDefault();
      return;
    }
    attaching = true;
    delete preferences.preload;
    Object.assign(preferences, {
      sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false, webSecurity: true, allowRunningInsecureContent: false,
      webviewTag: false
    });
  });
  function load() {
    const target = location;
    const guest = contents;
    if (!guest || !target) return;
    direct.then(() => {
      if (contents === guest && location === target && !guest.isDestroyed()) return guest.loadURL(target);
    }).catch(() => {});
  }
  window.webContents.on('did-attach-webview', (_event, guest) => {
    contents = guest;
    attaching = false;
    guest.once('destroyed', () => { if (contents === guest) contents = undefined; });
    guest.on('will-navigate', restrict);
    guest.on('will-redirect', restrict);
    guest.setWindowOpenHandler(() => ({ action: 'deny' }));
    guest.on('did-navigate', (_event, url) => {
      if (url === 'about:blank') return;
      if (resetHistory) guest.navigationHistory.clear();
      resetHistory = false;
      location = url;
      notify(owner, { url });
    });
    guest.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (isMainFrame) { location = url; notify(owner, { url }); }
    });
    guest.on('did-fail-load', (_event, code, reason, _url, main) => {
      if (main && code !== -3) notify(owner, { error: reason });
    });
    load();
  });

  return {
    show(id, input, hosts) {
      const url = localUrl(input, hosts);
      allowedHosts = hosts;
      if (owner !== id || location !== url) {
        resetHistory ||= owner !== id;
        owner = id;
        location = url;
        load();
      }
    },
    reload(id) { if (id === owner) contents?.reload(); },
    back(id) {
      if (id === owner && contents?.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
    }
  };
}

module.exports = { createPreview };
