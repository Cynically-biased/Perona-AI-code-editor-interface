const { autoUpdater } = require('electron-updater');

function createAppUpdates(enabled, notify) {
  let status = { state: enabled ? 'idle' : 'unavailable' };
  function set(state, version) {
    status = { state, version };
    notify(status);
  }
  if (enabled) {
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.on('checking-for-update', () => set('checking'));
    autoUpdater.on('update-available', info => set('downloading', info.version));
    autoUpdater.on('update-not-available', () => set('current'));
    autoUpdater.on('update-downloaded', info => set('ready', info.version));
    autoUpdater.on('error', () => set('error'));
  }
  return {
    status: () => status,
    async check() {
      if (['unavailable', 'checking', 'downloading', 'ready', 'installing'].includes(status.state)) return;
      set('checking');
      try {
        const result = await autoUpdater.checkForUpdates();
        if (!result) set('unavailable');
        else await result.downloadPromise;
      } catch {
        set('error');
      }
    },
    install() {
      if (status.state !== 'ready') throw new Error('An update is not ready to install.');
      set('installing');
      autoUpdater.quitAndInstall(true, true);
    }
  };
}

module.exports = { createAppUpdates };
