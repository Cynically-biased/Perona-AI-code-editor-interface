const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const { execFile, execFileSync } = require('node:child_process');
const { existsSync, readdirSync, statSync } = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const pty = require('node-pty');
const { createPreview } = require('./preview.cjs');
const { localHosts, suggestPreview } = require('./project-preview.cjs');
const xampp = require('./xampp.cjs');
const { registerInterface } = require('./app-protocol.cjs');
const { createHistory, resumeThread } = require('./history.cjs');
const { openWorkspace } = require('./saved-workspace.cjs');
const { gitStatus, gitAction } = require('./project-git.cjs');
const { listFolder, previewFile, saveFile, createEntry, moveEntry, removeEntry, projectChanges } = require('./project-files.cjs');

const run = promisify(execFile);
const chats = new Map();
const chatControls = new Map();
const projectShells = new Map();
const projects = new Map();
const starting = new Map();
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

register('default-folder', () => defaultFolder);
register('workspace-load', () => workspace.read());
register('workspace-add-project-chat', (...args) => workspace.addChatInProject(...args));
register('workspace-remove-project-chat', (chatId, id) => workspace.removeProjectChat(chatId, id));
register('workspace-save-project-dock', (...args) => workspace.saveProjectDock(...args));
register('workspace-select', (...args) => workspace.select(...args));
register('workspace-rename', (chat, name) => workspace.rename(chat, name));
register('workspace-remove', chat => workspace.remove(chat));

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
  const launch = startChat(id, agent, cwd, cols, rows, chatId, saved?.thread);
  starting.set(id, launch);
  try {
    await launch;
  } finally {
    starting.delete(id);
  }
});

async function startChat(id, agent, cwd, cols, rows, chatId, knownThread) {
  if (!statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error('Choose an existing working folder.');
  }
  projects.set(id, { cwd });
  tmux ??= findExecutable('tmux');
  const command = findExecutable(agent);
  const thread = resumeThread(id, agent, cwd, knownThread);
  const args = agent === 'claude'
    ? (thread ? ['--resume', thread] : ['--session-id', id])
    : ['--no-alt-screen', '-c', "tui.status_line=['model-with-reasoning','current-dir','session-id']"];
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
  projects.set(id, { cwd, history });
  terminal.onData(data => send('chat-data', id, data));
  terminal.onExit(({ exitCode }) => {
    if (chats.get(id) !== terminal) return;
    chats.delete(id);
    run(tmux, tmuxArgs(id, 'kill-server'), { windowsHide: true, timeout: 3000 }).catch(() => {});
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
register('chat-scroll', (id, lines) => {
  if (!chats.has(id) || !Number.isInteger(lines) || !lines) return;
  const count = Math.min(60, Math.abs(lines));
  const scroll = 'send-keys -X -N ' + count + (lines < 0 ? ' scroll-up' : ' scroll-down');
  const enterCopyMode = lines < 0 ? 'copy-mode -e ; ' + scroll : '';
  return queueChatControl(id, () =>
    run(tmux, tmuxArgs(id, 'if-shell', '-F', '-t', id, '#{pane_in_mode}', scroll, enterCopyMode),
      { windowsHide: true, timeout: 3000 }));
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

function findGitFish() {
  const roots = [
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Git'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Git'),
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Git')
  ];
  try {
    const executable = findExecutable('git');
    const parent = path.dirname(path.dirname(executable));
    roots.unshift(parent, path.dirname(parent));
  } catch {
    // A standard Git for Windows installation may be available outside PATH.
  }
  let foundBash = false;
  for (const root of roots.filter(Boolean)) {
    const bash = path.join(root, 'bin', 'bash.exe');
    if (!existsSync(bash)) continue;
    foundBash = true;
    if (existsSync(path.join(root, 'usr', 'bin', 'fish.exe'))) return bash;
  }
  throw new Error(foundBash
    ? 'Install fish in your Git for Windows installation to start this terminal.'
    : 'Install Git for Windows with Git Bash and fish to start this terminal.');
}

register('project-shell-start', (chatId, id, agent, cols, rows) => {
  const project = workspace.project(chatId, id, agent);
  if (!project || !size(cols, rows)) throw new Error('Unknown project terminal.');
  if (projectShells.has(id)) return;
  if (!statSync(project.folder, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error('The project folder is unavailable.');
  }
  const bash = findGitFish();
  const terminal = pty.spawn(bash, ['--login', '-c', 'cd -- "$1" && exec /usr/bin/fish --login --interactive',
    'perona', project.folder.replaceAll('\\', '/')], {
    name: 'xterm-256color', cols, rows, cwd: project.folder,
    env: { ...process.env, MSYSTEM: 'MINGW64', CHERE_INVOKING: '1', SHELL: '/usr/bin/fish' }
  });
  projectShells.set(id, terminal);
  terminal.onData(data => send('project-shell-data', id, data));
  terminal.onExit(({ exitCode }) => {
    if (projectShells.get(id) !== terminal) return;
    projectShells.delete(id);
    send('project-shell-exit', id, exitCode);
  });
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
register('project-move', (id, relative, target) =>
  trackFileWork(moveEntry(projectFor(id).cwd, relative, target)));
register('project-remove', (id, relative, directory) =>
  trackFileWork(removeEntry(projectFor(id).cwd, relative, directory, target => shell.trashItem(target))));
register('project-changes', id => projectChanges(projectFor(id).cwd));
register('git-status', id => gitStatus(projectFor(id).cwd));
register('git-action', (id, action, data) => trackFileWork(gitAction(projectFor(id).cwd, action, data)));
register('git-create-page', provider => {
  if (provider === 'github') return shell.openExternal('https://github.com/new');
  if (provider === 'gitlab') return shell.openExternal('https://gitlab.com/projects/new#blank_project');
  throw new Error('Unknown Git hosting provider.');
});

register('preview-suggest', id => suggestPreview(projectFor(id).cwd));
register('preview-show', async (id, bounds, url) => {
  projectFor(id);
  const request = ++previewRequest;
  const hosts = await localHosts();
  if (request !== previewRequest || window.isDestroyed()) return;
  preview ??= createPreview(window, (owner, update) => send('preview-update', owner, update));
  preview.show(id, bounds, url, hosts);
});
register('preview-hide', () => {
  previewRequest++;
  preview?.hide();
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

app.setName('Perona');
app.setAppUserModelId('Perona.Desktop');
if (!app.requestSingleInstanceLock()) app.quit();
else app.whenReady().then(() => {
  workspace = openWorkspace(app.getPath('userData'));
  registerInterface(__dirname);
  window = new BrowserWindow({
    title: 'Perona', icon: path.join(__dirname, 'perona-eb05.ico'),
    width: 1280, height: 800, minWidth: 720, minHeight: 460,
    titleBarStyle: 'hidden',
    backgroundColor: '#21141d', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), sandbox: true }
  });
  window.on('closed', () => { preview?.dispose(); preview = undefined; });
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
