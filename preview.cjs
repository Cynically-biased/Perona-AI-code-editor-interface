const { WebContentsView, session } = require('electron');

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
  const view = new WebContentsView({
    webPreferences: { session: partition, sandbox: true, contextIsolation: true, nodeIntegration: false }
  });
  const contents = view.webContents;
  let owner;
  let allowedHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
  let location;
  let resetHistory = false;
  const restrict = (event, url) => {
    try { localUrl(event.url || url, allowedHosts); } catch { event.preventDefault(); }
  };
  contents.on('will-navigate', restrict);
  contents.on('will-redirect', restrict);
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('did-navigate', (_event, url) => {
    if (resetHistory) contents.navigationHistory.clear();
    resetHistory = false;
    location = url;
    notify(owner, { url });
  });
  contents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
    if (isMainFrame) { location = url; notify(owner, { url }); }
  });
  contents.on('did-fail-load', (_event, code, reason, _url, main) => {
    if (main && code !== -3) notify(owner, { error: reason });
  });
  view.setVisible(false);
  window.contentView.addChildView(view);

  return {
    show(id, bounds, input, hosts) {
      if (!bounds || !['x', 'y', 'width', 'height'].every(key => Number.isFinite(bounds[key]))) {
        throw new Error('The preview area is unavailable.');
      }
      const url = localUrl(input, hosts);
      const [width, height] = window.getContentSize();
      const x = Math.max(0, Math.min(width, Math.round(bounds.x)));
      const y = Math.max(0, Math.min(height, Math.round(bounds.y)));
      view.setBounds({ x, y, width: Math.max(0, Math.min(width - x, Math.round(bounds.width))),
        height: Math.max(0, Math.min(height - y, Math.round(bounds.height))) });
      allowedHosts = hosts;
      view.setVisible(true);
      if (owner !== id || location !== url) {
        resetHistory ||= owner !== id;
        owner = id;
        location = url;
        direct.then(() => {
          if (owner === id && location === url && !contents.isDestroyed()) return contents.loadURL(url);
        }).catch(() => {});
      }
    },
    hide() { view.setVisible(false); },
    reload(id) { if (id === owner) contents.reload(); },
    back(id) {
      if (id === owner && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
    },
    dispose() { if (!contents.isDestroyed()) contents.close(); }
  };
}

module.exports = { createPreview };
