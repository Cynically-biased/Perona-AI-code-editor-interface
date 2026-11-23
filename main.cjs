const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const { execFile, execFileSync } = require('node:child_process');
const { existsSync, readdirSync, statSync } = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const { realpath, stat, writeFile } = require('node:fs/promises');
const { codexUsage, claudeUsage, claudeUsageSettings } = require('./agent-usage.cjs');
const { createUsageHistory } = require('./usage-history.cjs');
const pty = require('node-pty');
const { createPreview } = require('./preview.cjs');
const { createAppUpdates } = require('./app-updates.cjs');
const { localHosts, suggestPreview } = require('./project-preview.cjs');
const xampp = require('./xampp.cjs');
const { registerInterface } = require('./app-protocol.cjs');
const { createHistory, resumeThread } = require('./history.cjs');
const { openWorkspace } = require('./saved-workspace.cjs');
const { gitStatus, gitAction, trackedGitPaths, cloneRepository } = require('./project-git.cjs');
const { listFolder, previewFile, saveFile, createEntry, importFiles, moveEntry, removeEntry, projectChanges } = require('./project-files.cjs');

app.setName('Perona');
const run = promisify(execFile);
const chats = new Map();
const chatControls = new Map();
const projectShells = new Map();
const projects = new Map();
const starting = new Map();
const chatCleanup = new Map();
const agentUpdates = new Map();
const lastUpdateCheck = new Map();
const claudeUsageFile = path.join(app.getPath('userData'), 'claude-usage.json');
const usageHistory = createUsageHistory(path.join(app.getPath('userData'), 'usage-history.json'));
const claudeSettingsFile = path.join(app.getPath('userData'), 'claude-statusline.json');
const fileOperations = new Set();
const defaultFolder = app.isPackaged ? app.getPath('documents') : path.dirname(__dirname);
let pickerOpen = false;
let folderSelection;
let tmux;
let window;
let discardWindowEdits = false;
let workspace;
let preview;
let previewRequest = 0;
const appUpdates = createAppUpdates(app.isPackaged && process.platform === 'win32',
  status => send('app-update-status', status), app.getVersion());

function findExecutable(name) {
  const options = { windowsHide: true, encoding: 'utf8' };
  try {
    return execFileSync(path.join(process.env.SystemRoot, 'System32', 'where.exe'),
      ['$PATH:' + name + '.exe'], options).trim().split(/\r?\n/)[0];
  } catch {
    if (name === 'tmux' && process.env.LOCALAPPDATA) {
      const packages = path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Packages');
      if (existsSync(packages)) {
        for (const entry of readdirSync(packages)) {
          const candidate = path.join(packages, entry, 'tmux.exe');
          if (entry.startsWith('arndawg.tmux-windows_') && existsSync(candidate)) return candidate;
        }
      }
    }
    throw new Error(name === 'tmux'
      ? 'Install tmux with winget install --id arndawg.tmux-windows --exact.'
      : 'Install ' + name + ' and make its Windows CLI available on PATH.');
  }
}

function tmuxArgs(id, ...args) {
  return ['-L', 'agent-desk-' + id, '-f', 'NUL', ...args];
}

function send(channel, ...args) {
  if (window && !window.isDestroyed()) window.webContents.send(channel, ...args);
}

function size(cols, rows) {
  return [cols, rows].every(n => Number.isInteger(n) && n >= 2 && n <= 1000);
}

function register(channel, handler) {
  ipcMain.handle(channel, (event, ...args) => {
    if (event.sender !== window?.webContents || event.senderFrame !== window.webContents.mainFrame) {
      throw new Error('Unknown window.');
    }
    return handler(...args);
  });
}

function literal(value) {
  return "'" + value.replaceAll("'", "''") + "'";
}

async function preferredProjectFolder(preferred) {
  if (typeof preferred !== 'string' || !path.isAbsolute(preferred)) return defaultFolder;
  const resolved = await realpath(preferred).catch(() => null);
  return resolved && (await stat(resolved).catch(() => null))?.isDirectory() ? resolved : defaultFolder;
}

register('workspace-add-new-project', async (id, agent, name, preferred) => {
  const folder = await preferredProjectFolder(preferred);
  workspace.add(id, agent, name, id, folder);
  return folder;
});
async function chooseProjectFolder(preferred, options) {
  if (pickerOpen) return null;
  pickerOpen = true;
  try {
    const { canceled, filePaths: [folder] } = await dialog.showOpenDialog(window, {
      defaultPath: await preferredProjectFolder(preferred), ...options
    });
    return canceled ? null : folder;
  } finally {
    pickerOpen = false;
  }
}
register('settings-pick-folder', preferred => chooseProjectFolder(preferred, {
  title: 'Choose the default project folder', properties: ['openDirectory', 'createDirectory']
}));
register('workspace-open-project', async (id, agent, name, preferred) => {
  const selected = await chooseProjectFolder(preferred, {
    title: 'Open project', buttonLabel: 'Open project', properties: ['openDirectory']
  });
  if (!selected) return null;
  const folder = await realpath(selected);
  if (!(await stat(folder)).isDirectory()) throw new Error('The selected project folder is unavailable.');
  workspace.add(id, agent, name, id, folder);
  return folder;
});
register('settings-zoom', percent => {
  if ([80, 90, 100, 110, 125, 150].includes(percent)) window.webContents.setZoomFactor(percent / 100);
});
register('workspace-load', () => workspace.read());
register('workspace-add-dropped-project', async (id, agent, name, source) => {
  if (typeof source !== 'string' || !path.isAbsolute(source)) throw new Error('Drop a project folder from File Explorer.');
  const folder = await realpath(source).catch(() => null);
  if (!folder || !(await stat(folder).catch(() => null))?.isDirectory()) {
    throw new Error('Drop a folder onto Codex or Claude to open a project.');
  }
  workspace.add(id, agent, name, id, folder);
  return folder;
});
register('workspace-add-project-chat', (...args) => workspace.addChatInProject(...args));
register('workspace-remove-project-chat', (chatId, id) => workspace.removeProjectChat(chatId, id));
register('workspace-save-project-dock', (...args) => workspace.saveProjectDock(...args));
register('workspace-select', (...args) => workspace.select(...args));
register('workspace-rename', (chat, name) => workspace.rename(chat, name));
register('workspace-remove', chat => workspace.remove(chat));
register('app-update-status', () => appUpdates.status());
register('app-update-check', download => appUpdates.check(download !== false));
register('app-update-versions', () => appUpdates.earlierVersions());
register('app-update-downgrade', version => appUpdates.downgrade(version));
register('app-update-install', () => {
  if (starting.size || fileOperations.size || fishInstallation || agentUpdates.size) {
    throw new Error('Wait for the current operation to finish, then restart to update.');
  }
  appUpdates.install();
});

register('agent-usage', async () => {
  const results = await Promise.allSettled([
    Promise.resolve().then(() => agentUpdates.has('codex') ? [] : codexUsage(findExecutable('codex'))),
    claudeUsage(claudeUsageFile)
  ]);
  const usage = Object.fromEntries(['codex', 'claude'].map((agent, index) =>
    [agent, results[index].status === 'fulfilled' ? results[index].value : []]));
  return { usage, charts: await usageHistory(usage) };
});

function updateAgent(agent) {
  if (agentUpdates.has(agent)) return agentUpdates.get(agent);
  const update = (async () => {
    const command = findExecutable(agent);
    const options = { windowsHide: true, timeout: 180000, cwd: app.getPath('userData') };
    if (agent === 'claude' && /[\\/]WinGet[\\/](?:Packages|Links)[\\/]/i.test(command)) {
      const { stdout } = await run('winget.exe', ['upgrade', '--id', 'Anthropic.ClaudeCode', '--exact',
        '--silent', '--disable-interactivity', '--accept-package-agreements', '--accept-source-agreements'], options)
        .catch(error => {
          if ((error.code >>> 0) === 0x8a15002b) return { stdout: '' }; // No applicable update.
          throw error;
        });
      return stdout;
    }
    const { stdout } = await run(command, ['update'], options);
    return stdout;
  })().finally(() => {
    lastUpdateCheck.set(agent, Date.now());
    agentUpdates.delete(agent);
  });
  agentUpdates.set(agent, update);
  return update;
}

register('pick-chat-folder', async (id, agent, currentFolder) => {
  if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)
      || !['claude', 'codex'].includes(agent) || chats.has(id) || starting.has(id)) {
    throw new Error('Invalid chat request.');
  }
  if (pickerOpen) return null;
  pickerOpen = true;
  folderSelection = undefined;
  try {
    const name = agent === 'claude' ? 'Claude' : 'Codex';
    const { canceled, filePaths: [cwd] } = await dialog.showOpenDialog(window, {
      title: 'Change working folder for ' + name,
      defaultPath: typeof currentFolder === 'string' && path.isAbsolute(currentFolder)
        ? currentFolder : defaultFolder,
      buttonLabel: 'Switch folder',
      properties: ['openDirectory']
    });
    if (canceled || !cwd) return null;
    const folder = path.resolve(cwd);
    folderSelection = { id, agent, cwd: folder };
    return folder;
  } finally {
    pickerOpen = false;
  }
});

register('start-chat', async (id, agent, cols, rows, usePickedFolder, chatId, name) => {
  if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)
      || !['claude', 'codex'].includes(agent) || !size(cols, rows)
      || chats.has(id) || starting.has(id)) {
    throw new Error('Invalid chat request.');
  }
  const saved = workspace.project(chatId, id, agent);
  let cwd = saved?.folder ?? defaultFolder;
  if (!saved && usePickedFolder) {
    if (folderSelection?.id !== id || folderSelection.agent !== agent) {
      throw new Error('Choose a working folder before switching projects.');
    }
    cwd = folderSelection.cwd;
    folderSelection = undefined;
  }
  if (!saved) workspace.add(chatId, agent, name, id, cwd);
  const launch = (async () => {
    if (agentUpdates.has(agent) || (
      Date.now() - (lastUpdateCheck.get(agent) ?? 0) > 6 * 60 * 60 * 1000 &&
      ![...chats.keys()].some(key => projects.get(key)?.agent === agent)
    )) {
      send('chat-update-state', id, 'Checking for updates…');
      await updateAgent(agent).catch(() => {
        send('chat-data', id, '\r\n[Automatic update unavailable. Use Update agent to retry.]\r\n');
      });
    }
    await startChat(id, agent, cwd, cols, rows, chatId, saved?.thread);
  })();
  starting.set(id, launch);
  try {
    await launch;
  } finally {
    starting.delete(id);
  }
});

async function startChat(id, agent, cwd, cols, rows, chatId, knownThread) {
  await chatCleanup.get(id);
  if (!statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error('Choose an existing working folder.');
  }
  tmux ??= findExecutable('tmux');
  const command = findExecutable(agent);
  const thread = resumeThread(id, agent, cwd, knownThread);
  const args = agent === 'claude'
    ? (thread ? ['--resume', thread] : ['--session-id', id])
    : ['--no-alt-screen', '-c', 'check_for_update_on_startup=false',
      '-c', "tui.status_line=['model-with-reasoning','current-dir','session-id']"];
  if (agent === 'claude') {
    await writeFile(claudeSettingsFile, claudeUsageSettings(claudeUsageFile));
    args.push('--settings', claudeSettingsFile);
  }
  if (agent === 'codex' && thread) args.push('resume', thread);
  const script = [
    "$ErrorActionPreference = 'Stop'",
    'Set-Location -LiteralPath ' + literal(cwd),
    '& ' + [command, ...args].map(literal).join(' '),
    'exit $LASTEXITCODE'
  ].join('\n');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const env = { ...process.env };
  for (const key of [
    'TMUX', 'TMUX_PANE', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT',
    'CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CODEX_CI',
    'CODEX_INTERNAL_ORIGINATOR_OVERRIDE', 'CODEX_APP_TOOLS_PIPE_PATH'
  ]) delete env[key];

  const history = createHistory(id, agent, cwd, thread,
    providerId => workspace.rememberThread(chatId, id, providerId));
  let terminal;
  try {
    // The Windows tmux port crashes when rendering OSC 8 hyperlinks.
    // Disable the alternate screen before opening the pane so output enters scrollback.
    await run(tmux, tmuxArgs(id, 'start-server',
      ';', 'set-option', '-sa', 'terminal-overrides', ',*:Hls@',
      ';', 'set-option', '-g', 'status-style', 'fg=#f9dce8,bg=#472333',
      ';', 'set-option', '-g', 'window-style', 'fg=#fff0e7,bg=#1b121a',
      ';', 'set-option', '-gw', 'alternate-screen', 'off',
      ';', 'new-session', '-d', '-s', id, '-n', agent,
      '-x', String(cols), '-y', String(rows),
      'powershell.exe', '-NoProfile', '-EncodedCommand', encoded),
    { windowsHide: true, timeout: 5000, cwd, env });
    terminal = pty.spawn(tmux, tmuxArgs(id, 'attach-session', '-t', id),
      { name: 'xterm-256color', cols, rows, cwd, env });
  } catch (error) {
    await run(tmux, tmuxArgs(id, 'kill-server'), { windowsHide: true, timeout: 3000 }).catch(() => {});
    throw error;
  }
  chats.set(id, terminal);
  projects.set(id, { cwd, history, agent, chatId });
  terminal.onData(data => send('chat-data', id, data));
  terminal.onExit(({ exitCode }) => {
    if (chats.get(id) !== terminal) return;
    chats.delete(id);
    const cleanup = run(tmux, tmuxArgs(id, 'kill-server'), { windowsHide: true, timeout: 3000 })
      .catch(() => {}).finally(() => chatCleanup.delete(id));
    chatCleanup.set(id, cleanup);
    send('chat-exit', id, exitCode);
  });
}

function queueChatControl(id, control) {
  const terminal = chats.get(id);
  if (!terminal) return;
  const next = (chatControls.get(id) ?? Promise.resolve()).catch(() => {}).then(() => {
    if (chats.get(id) === terminal) return control(terminal);
  });
  chatControls.set(id, next);
  return next.finally(() => {
    if (chatControls.get(id) === next) chatControls.delete(id);
  });
}

register('chat-input', (id, data) => {
  if (typeof data !== 'string') return;
  if (chatControls.has(id)) return queueChatControl(id, terminal => terminal.write(data));
  chats.get(id)?.write(data);
});

register('update-chat-agent', (id, cols, rows, candidate) => {
  const project = projects.get(id);
  if (!project || !size(cols, rows) || starting.has(id)) throw new Error('Chat is unavailable.');
  const { agent, chatId, cwd, history } = project;
  const saved = workspace.project(chatId, id, agent);
  if (!saved) throw new Error('Chat is unavailable.');
  const thread = history(candidate, true).thread ?? saved.thread;
  const restart = (async () => {
    send('chat-update-state', id, 'Updating agent…');
    const terminal = chats.get(id);
    if (terminal) {
      // Ignore the old pane's exit callback while replacing it.
      chats.delete(id);
      try {
        await run(tmux, tmuxArgs(id, 'kill-server'), { windowsHide: true, timeout: 5000 });
      } catch (error) {
        if (!/no server running|can't find session|no sessions|error connecting/i.test(error.stderr || '')) {
          chats.set(id, terminal);
          return { updateError: 'Perona could not stop this agent safely. Try Update agent again.' };
        }
      }
    }
    let updateError;
    try { await updateAgent(agent); } catch { updateError = 'The agent update failed. Use Update agent to retry.'; }
    if (projects.get(id) !== project) return null;
    await startChat(id, agent, cwd, cols, rows, chatId, thread);
    return { updateError };
  })();
  starting.set(id, restart);
  return restart.finally(() => starting.delete(id));
});
register('chat-scrollback', async (id, end) => {
  if (!chats.has(id) || !Number.isInteger(end) || end < -1 || end > 999) return '';
  const { stdout } = await run(tmux, tmuxArgs(id, 'capture-pane', '-p', '-e', '-J', '-S', '-2000', '-E', String(end), '-t', id),
    { windowsHide: true, timeout: 3000, maxBuffer: 4 * 1024 * 1024 });
  return stdout;
});
register('chat-newline', id => {
  if (!chats.has(id)) return;
  // Send the agents' native Alt+Enter chord directly to the tmux pane.
  const newline = 'send-keys M-Enter';
  return queueChatControl(id, () =>
    run(tmux, tmuxArgs(id, 'if-shell', '-F', '-t', id, '#{pane_in_mode}',
      'send-keys -X cancel ; ' + newline, newline), { windowsHide: true, timeout: 3000 }));
});
register('chat-resize', (id, cols, rows) => {
  if (size(cols, rows)) chats.get(id)?.resize(cols, rows);
});
register('close-chat', async id => {
  if (starting.has(id)) {
    projects.delete(id);
    await starting.get(id).catch(() => {});
  }
  if (!chats.has(id)) {
    projects.delete(id);
    closeProjectShell(id);
    return;
  }
  try {
    await run(tmux, tmuxArgs(id, 'kill-server'), { windowsHide: true, timeout: 3000 });
  } catch (error) {
    if (!/no server running|can't find session/i.test(error.stderr || '')) throw error;
  }
  projects.delete(id);
  closeProjectShell(id);
});

function closeProjectShell(id) {
  const terminal = projectShells.get(id);
  if (!terminal) return;
  projectShells.delete(id);
  terminal.kill();
}

function gitSdkFolder() {
  return path.join(process.env.LOCALAPPDATA || app.getPath('userData'), 'PeronaGitSDK');
}

function gitBashRoots() {
  const drive = process.env.SystemDrive || 'C:';
  const roots = [
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Git'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Git'),
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Git'),
    gitSdkFolder(), path.join(drive + '\\', 'git-sdk-64')
  ];
  try {
    const executable = findExecutable('git');
    const parent = path.dirname(path.dirname(executable));
    roots.unshift(parent, path.dirname(parent));
  } catch {
    // A standard Git for Windows installation may be available outside PATH.
  }
  return roots.filter(Boolean);
}

function findProjectFish() {
  for (const root of gitBashRoots()) {
    const bash = path.join(root, 'bin', 'bash.exe');
    if (existsSync(bash) && existsSync(path.join(root, 'usr', 'bin', 'fish.exe'))) {
      return { bash, msystem: 'MINGW64' };
    }
  }
  const msys = findMsys2();
  if (msys && existsSync(path.join(path.dirname(msys), 'fish.exe'))) {
    return { bash: msys, msystem: 'MSYS' };
  }
}

function findGitBashInstaller() {
  for (const root of gitBashRoots()) {
    const bash = path.join(root, 'bin', 'bash.exe');
    if (existsSync(bash) && existsSync(path.join(root, 'usr', 'bin', 'pacman.exe'))) return bash;
  }
}

function findMsys2() {
  const drive = process.env.SystemDrive || 'C:';
  const roots = [path.join(drive + '\\', 'msys64'), path.join(drive + '\\', 'tools', 'msys64')];
  for (const root of roots) {
    const bin = path.join(root, 'usr', 'bin');
    const bash = path.join(bin, 'bash.exe');
    if (existsSync(bash) && existsSync(path.join(bin, 'pacman.exe'))) return bash;
  }
}

let fishInstallation;
register('project-shell-install-fish', () => {
  if (fishInstallation) return fishInstallation;
  fishInstallation = (async () => {
    const cwd = app.getPath('userData');
    const options = { cwd, windowsHide: true, timeout: 10 * 60 * 1000 };
    let bash = findGitBashInstaller();
    const fresh = !bash;
    if (!bash) {
      try {
        await run('winget.exe', ['install', '--id', 'Git.SDK', '--exact', '--source', 'winget', '--architecture', 'x64',
          '--location', gitSdkFolder(),
          '--silent', '--disable-interactivity', '--accept-package-agreements', '--accept-source-agreements'], options);
      } catch (error) {
        throw new Error(error.code === 'ENOENT'
          ? 'Windows Package Manager is required. Install App Installer from Microsoft Store and try again.'
          : 'Git for Windows SDK installation failed. Check Windows Package Manager and try again.');
      }
      bash = findGitBashInstaller();
    }
    if (!bash) throw new Error('Perona could not find Git Bash with its package manager.');
    try {
      const gitBashOptions = {
        ...options, env: { ...process.env, MSYSTEM: 'MINGW64', CHERE_INVOKING: '1' }
      };
      const pacman = args => run(bash, ['--login', '-c', 'exec /usr/bin/pacman "$@"', 'perona', ...args], gitBashOptions);
      if (fresh) {
        // A runtime upgrade can end the first shell. Finish in a fresh one.
        await pacman(['-Syu', '--noconfirm']);
        await pacman(['-Syu', '--noconfirm']);
      }
      await pacman(['-S', '--needed', '--noconfirm', 'fish', 'fisher', 'mingw-w64-ucrt-x86_64-zoxide']);
      await run(bash, ['--login', '-c', [
        'set -e',
        'config=$(/usr/bin/fish --no-config -c \'printf "%s" $__fish_config_dir\')',
        'test -n "$config"',
        'mkdir -p -- "$config/conf.d"',
        'file="$config/conf.d/perona-zoxide.fish"',
        'if [ ! -e "$file" ]; then',
        '  (set -o noclobber; cat > "$file" <<\'FISH\'',
        'if test -x /ucrt64/bin/zoxide.exe',
        '    if not type -q zoxide',
        '        fish_add_path --append --path /ucrt64/bin',
        '    end',
        '    zoxide init fish | source',
        'end',
        'FISH',
        '  )',
        'fi'
      ].join('\n')], gitBashOptions);
    } catch {
      throw new Error('Could not set up Fish, Fisher, and zoxide in Git Bash. Check your connection and Git SDK permissions, then try again.');
    }
    if (findProjectFish()?.msystem !== 'MINGW64') throw new Error('The installer finished, but Perona could not find Fish in Git Bash.');
  })().finally(() => { fishInstallation = undefined; });
  return fishInstallation;
});

register('project-shell-start', (chatId, id, agent, cols, rows) => {
  const project = workspace.project(chatId, id, agent);
  if (!project || !size(cols, rows)) throw new Error('Unknown project terminal.');
  if (projectShells.has(id)) return;
  if (!statSync(project.folder, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error('The project folder is unavailable.');
  }
  const shell = findProjectFish();
  if (!shell) return { missingFish: true };
  const { bash, msystem } = shell;
  const terminal = pty.spawn(bash, ['--login', '-c', 'cd -- "$1" && exec /usr/bin/fish --login --interactive',
    'perona', project.folder.replaceAll('\\', '/')], {
    name: 'xterm-256color', cols, rows, cwd: project.folder,
    env: { ...process.env, MSYSTEM: msystem, CHERE_INVOKING: '1', SHELL: '/usr/bin/fish',
      ...(msystem === 'MSYS' ? { MSYS2_PATH_TYPE: 'inherit' } : {}) }
  });
  projectShells.set(id, terminal);
  terminal.onData(data => send('project-shell-data', id, data));
  terminal.onExit(({ exitCode }) => {
    if (projectShells.get(id) !== terminal) return;
    projectShells.delete(id);
    send('project-shell-exit', id, exitCode);
  });
  return { backend: msystem === 'MSYS' ? 'MSYS2' : 'Git Bash' };
});

register('project-shell-input', (id, data) => {
  if (typeof data === 'string') projectShells.get(id)?.write(data);
});
register('project-shell-resize', (id, cols, rows) => {
  if (size(cols, rows)) projectShells.get(id)?.resize(cols, rows);
});

function projectFor(id) {
  const project = projects.get(id);
  if (!project) throw new Error('This project session is unavailable.');
  return project;
}

register('session-history', (id, candidate, idle) => projectFor(id).history(
  typeof candidate === 'string' ? candidate : '', idle === true));

register('project-list', (id, relative) => listFolder(projectFor(id).cwd, relative));
register('project-preview', (id, relative) => previewFile(projectFor(id).cwd, relative));
async function trackFileWork(operation) {
  fileOperations.add(operation);
  try {
    return await operation;
  } finally {
    fileOperations.delete(operation);
  }
}
register('project-save', (id, relative, revision, text) =>
  trackFileWork(saveFile(projectFor(id).cwd, relative, revision, text)));
register('project-create', (id, relative, type) =>
  trackFileWork(createEntry(projectFor(id).cwd, relative, type)));
register('project-import-files', (id, relative, sources, replacement) =>
  trackFileWork(importFiles(projectFor(id).cwd, relative, sources, replacement, target => shell.trashItem(target))));
register('project-move', (id, relative, target) =>
  trackFileWork(moveEntry(projectFor(id).cwd, relative, target)));
register('project-remove', (id, relative, directory) =>
  trackFileWork(removeEntry(projectFor(id).cwd, relative, directory, target => shell.trashItem(target))));
register('project-changes', id => projectChanges(projectFor(id).cwd));
register('git-status', id => gitStatus(projectFor(id).cwd));
register('git-clone', async (id, agent, name, url, preferred) => {
  if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id) || !['codex', 'claude'].includes(agent)) {
    throw new Error('Choose an agent for the new project.');
  }
  if (pickerOpen) throw new Error('Close the current folder picker and try again.');
  pickerOpen = true;
  try {
    const { canceled, filePaths: [selected] } = await dialog.showOpenDialog(window, {
      title: 'Choose an empty folder for the clone',
      defaultPath: await preferredProjectFolder(preferred),
      buttonLabel: 'Clone here',
      properties: ['openDirectory', 'createDirectory']
    });
    if (canceled || !selected) return null;
    const folder = await realpath(selected);
    return await trackFileWork((async () => {
      await cloneRepository(folder, url);
      workspace.add(id, agent, name, id, folder);
      return folder;
    })());
  } finally {
    pickerOpen = false;
  }
});
register('git-tracked-paths', id => trackedGitPaths(projectFor(id).cwd));
register('git-action', (id, action, data) => trackFileWork(gitAction(projectFor(id).cwd, action, data)));
register('git-create-page', provider => {
  if (provider === 'github') return shell.openExternal('https://github.com/new');
  if (provider === 'gitlab') return shell.openExternal('https://gitlab.com/projects/new#blank_project');
  throw new Error('Unknown Git hosting provider.');
});

register('preview-suggest', id => suggestPreview(projectFor(id).cwd));
register('preview-show', async (id, url) => {
  projectFor(id);
  const request = ++previewRequest;
  const hosts = await localHosts();
  if (request !== previewRequest || window.isDestroyed()) return;
  preview.show(id, url, hosts);
});
register('preview-hide', () => {
  previewRequest++;
});
register('preview-reload', id => preview?.reload(id));
register('preview-back', id => preview?.back(id));
register('xampp-status', async () => ({ root: xampp.root, services: await xampp.inspect() }));
register('xampp-control', async (id, action) => xampp.control(id, action));
register('xampp-log', id => xampp.readLog(id));
register('xampp-admin', id => xampp.openAdmin(id, shell));
register('xampp-netstat', () => xampp.listeners());
register('xampp-utility', action => xampp.utility(action, shell));

function xamppConfig(id, relative) {
  if (!xampp.configPaths(id).includes(relative)) throw new Error('Choose a listed XAMPP configuration file.');
  return relative;
}
register('xampp-config', (id, relative) => previewFile(xampp.root, xamppConfig(id, relative)));
register('xampp-config-save', (id, relative, revision, text) =>
  trackFileWork(saveFile(xampp.root, xamppConfig(id, relative), revision, text)));

function handleInterfaceZoomShortcut(event, input) {
  if (input.type !== 'keyDown' || !input.control || input.alt || input.meta || input.isComposing) return;
  const grow = ['Equal', 'NumpadAdd'].includes(input.code);
  const shrink = ['Minus', 'NumpadSubtract'].includes(input.code);
  if (!grow && !shrink) return;
  event.preventDefault();
  if (!input.isAutoRepeat) send('settings-zoom-step', grow ? 1 : -1);
}

register('window-control', action => {
  switch (action) {
    case 'minimize':
      window.minimize();
      break;
    case 'maximize':
      if (window.isMaximized()) window.unmaximize();
      else window.maximize();
      break;
    case 'discard-close':
      if (fileOperations.size) throw new Error('Wait for the current project operation to finish.');
      discardWindowEdits = true;
      window.close();
      break;
    case 'close':
      window.close();
      break;
  }
});

app.setAppUserModelId('Perona.Desktop');
if (!app.requestSingleInstanceLock()) app.quit();
else app.whenReady().then(() => {
  workspace = openWorkspace(app.getPath('userData'));
  registerInterface(__dirname);
  window = new BrowserWindow({
    title: 'Perona', icon: path.join(__dirname, 'perona-eb05.ico'),
    width: 1280, height: 800, minWidth: 520, minHeight: 360,
    titleBarStyle: 'hidden',
    backgroundColor: '#21141d', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), sandbox: true, webviewTag: true }
  });
  window.webContents.on('before-input-event', handleInterfaceZoomShortcut);
  window.webContents.on('did-attach-webview', (_event, guest) => {
    guest.on('before-input-event', handleInterfaceZoomShortcut);
  });
  preview = createPreview(window, (owner, update) => send('preview-update', owner, update));
  window.on('maximize', () => send('window-maximized', true));
  window.on('unmaximize', () => send('window-maximized', false));
  window.on('move', () => send('window-moved'));
  window.webContents.on('will-prevent-unload', event => {
    if (discardWindowEdits) {
      discardWindowEdits = false;
      if (!fileOperations.size) event.preventDefault();
      return;
    }
    if (!fileOperations.size) send('confirm-window-close');
  });
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.loadURL('perona://app/index.html');
});

app.on('second-instance', () => {
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.focus();
});

app.on('window-all-closed', () => app.quit());

app.on('before-quit', event => {
  if (!starting.size && !fileOperations.size) return;
  event.preventDefault();
  Promise.allSettled([...starting.values(), ...fileOperations]).then(() => app.quit());
});
app.on('will-quit', () => {
  for (const id of projectShells.keys()) closeProjectShell(id);
  for (const id of chats.keys()) {
    try {
      execFileSync(tmux, tmuxArgs(id, 'kill-server'), {
        windowsHide: true, timeout: 3000, stdio: 'ignore'
      });
    } catch {
      // The server may already have exited with its session.
    }
  }
});
