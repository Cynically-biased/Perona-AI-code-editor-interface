const { desktopCapturer, session } = require('electron');

function createWindowCapture(window) {
  let sources = new Map();
  let selected;
  function claim(id) {
    const source = sources.get(id);
    sources.clear();
    if (!source) throw new Error('Choose a window from the current list.');
    return source;
  }
  window.webContents.session.setDisplayMediaRequestHandler((request, callback) => {
    const choice = selected;
    selected = undefined;
    if (request.frame !== window.webContents.mainFrame || !request.userGesture
        || !request.videoRequested || request.audioRequested || !choice || Date.now() > choice.expires) {
      callback({});
      return;
    }
    callback({ video: choice.source });
  });
  return {
    async list() {
      selected = undefined;
      const ownWindow = window.getMediaSourceId().split(':').slice(0, 2).join(':');
      const windows = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 } });
      sources = new Map(windows.filter(source => source.id.startsWith('window:')
        && source.id.split(':').slice(0, 2).join(':') !== ownWindow).map(source => [source.id, source]));
      return [...sources.values()].map(({ id, name }) => ({ id, name }));
    },
    select(id) {
      selected = undefined;
      selected = { source: claim(id), expires: Date.now() + 5000 };
    },
    claim
  };
}

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
      if (!owner || url === 'about:blank') return;
      if (resetHistory) guest.navigationHistory.clear();
      resetHistory = false;
      location = url;
      notify(owner, { url });
    });
    guest.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (owner && isMainFrame && url !== 'about:blank') { location = url; notify(owner, { url }); }
    });
    guest.on('did-fail-load', (_event, code, reason, _url, main) => {
      if (owner && main && code !== -3) notify(owner, { error: reason });
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
    stop(id) {
      if (owner !== id) return;
      owner = undefined;
      location = undefined;
      resetHistory = true;
      if (contents && !contents.isDestroyed()) {
        contents.stop();
        contents.loadURL('about:blank').catch(() => {});
      }
    },
    reload(id) { if (id === owner) contents?.reload(); },
    back(id) {
      if (id === owner && contents?.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
    }
  };
}

module.exports = { createPreview, createWindowCapture };
