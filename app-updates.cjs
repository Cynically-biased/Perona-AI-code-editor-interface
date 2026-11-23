const { autoUpdater, NsisUpdater } = require('electron-updater');

const repository = 'Cynically-biased/perona-ai-coding-workbench';
const stableVersion = /^(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})$/;

function compareVersions(first, second) {
  const a = first.split('.').map(Number);
  const b = second.split('.').map(Number);
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

function createAppUpdates(enabled, notify, currentVersion) {
  let status = { state: enabled ? 'idle' : 'unavailable' };
  let availableVersions = new Set();
  let prepared;
  function set(state, version, downgrade = false) {
    status = { state, version, downgrade };
    notify(status);
  }

  async function prepare(updater, version, download = true) {
    prepared = undefined;
    set('checking', version, Boolean(version));
    updater.autoInstallOnAppQuit = false;
    updater.autoDownload = false;
    try {
      const result = await updater.checkForUpdates();
      if (version && (!result?.isUpdateAvailable || result.updateInfo.version !== version)) {
        throw new Error('The selected release has invalid update metadata.');
      }
      if (!result?.isUpdateAvailable) {
        set(result ? 'current' : 'unavailable');
        return;
      }
      if (!download) {
        set('available', result.updateInfo.version);
        return;
      }
      set('downloading', result.updateInfo.version, Boolean(version));
      await updater.downloadUpdate(result.cancellationToken);
      prepared = updater;
      set('ready', result.updateInfo.version, Boolean(version));
    } catch (error) {
      set('error', version, Boolean(version));
      if (version) throw new Error('Could not download Perona ' + version + '. Choose a version and try again.');
    }
  }

  const busy = () => ['checking', 'downloading', 'installing'].includes(status.state);
  return {
    status: () => status,
    async check(download = true) {
      if (status.state === 'unavailable' || status.state === 'ready' || busy()) return;
      await prepare(autoUpdater, undefined, download);
    },
    async earlierVersions() {
      if (!enabled || !stableVersion.test(currentVersion) || busy()) return [];
      const response = await fetch('https://api.github.com/repos/' + repository + '/releases?per_page=100', {
        signal: AbortSignal.timeout(10000),
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Perona' }
      });
      if (!response.ok) throw new Error('Could not load earlier Perona releases. Try again later.');
      const releases = await response.json();
      availableVersions = new Set(releases.flatMap(release => {
        const version = release.tag_name?.slice(1);
        const names = new Set(release.assets?.filter(asset => asset.state === 'uploaded').map(asset => asset.name));
        return !release.draft && !release.prerelease && release.tag_name === 'v' + version &&
          stableVersion.test(version) && compareVersions(version, currentVersion) < 0 &&
          names.has('latest.yml') && names.has('Perona.Setup.' + version + '.x64.exe') ? [version] : [];
      }));
      return [...availableVersions].sort((a, b) => compareVersions(b, a));
    },
    async downgrade(version) {
      if (!enabled || busy() || !availableVersions.has(version)) throw new Error('Choose an available earlier version.');
      const updater = new NsisUpdater({
        provider: 'generic',
        url: 'https://github.com/' + repository + '/releases/download/v' + version + '/'
      });
      updater.allowDowngrade = true;
      await prepare(updater, version);
    },
    install() {
      if (status.state !== 'ready' || !prepared) throw new Error('An update is not ready to install.');
      const { version, downgrade } = status;
      const updater = prepared;
      set('installing', version, downgrade);
      updater.once('error', () => {
        if (status.state === 'installing') set('ready', version, downgrade);
      });
      try {
        updater.quitAndInstall(true, true);
      } catch (error) {
        set('ready', version, downgrade);
        throw error;
      }
    }
  };
}

module.exports = { createAppUpdates };
