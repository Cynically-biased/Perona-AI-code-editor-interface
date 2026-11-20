const chats = new Map();
const sessions = new Map();
const counters = { claude: 0, codex: 0 };
const names = { claude: 'Claude', codex: 'Codex' };
const updateButton = document.getElementById('app-update');
let updateState;

function showAppUpdate({ state, version }) {
  updateState = state;
  updateButton.hidden = state === 'unavailable';
  updateButton.disabled = ['checking', 'downloading', 'installing'].includes(state);
  updateButton.textContent = {
    checking: 'Checking…', downloading: 'Downloading update…', ready: 'Restart to update',
    installing: 'Restarting…', current: 'Up to date', error: 'Retry update check'
  }[state] ?? 'Check for updates';
  updateButton.title = version ? 'Perona ' + version : 'Check for a Perona update';
}

window.desk.onAppUpdate(showAppUpdate);
window.desk.appUpdateStatus().then(showAppUpdate).catch(setError);
updateButton.addEventListener('click', async () => {
  try {
    if (updateState !== 'ready') {
      await window.desk.checkAppUpdate();
      return;
    }
    if (hasUnsavedServiceConfig() || [...sessions.values()].some(session => hasUnsavedFile(session.view))) {
      throw new Error('Save your edits before restarting to update Perona.');
    }
    if ([...sessions.values()].some(session => session.running || session.shell?.state === 'running') &&
        !await confirmAction('Restart to update Perona?', 'Restarting will close active agent chats and project terminals.', 'Restart to update')) return;
    if (hasUnsavedServiceConfig() || [...sessions.values()].some(session => hasUnsavedFile(session.view))) {
      throw new Error('Save your edits before restarting to update Perona.');
    }
    await window.desk.installAppUpdate();
  } catch (error) { setError(error); }
});
const grid = document.querySelector('#chats');
const empty = document.querySelector('#empty');
const errorMessage = document.querySelector('#error');
const rowTemplate = document.querySelector('#chat-row');
const renameDialog = document.querySelector('#rename-dialog');
const renameInput = document.querySelector('#chat-name');
let activeChat;
let renamingChat;
let workspaceReady = false;

function rememberWorkspace(chat = activeChat) {
  if (chat !== activeChat || !chat) return;
  const selected = chat.savedProjects.get(chat.selectedId);
  window.desk.selectWorkspace(chat.id, chat.selectedId, undefined,
    undefined, chat.current?.id ?? selected?.activeAgent).catch(setError);
}

function selectChat(chat, focus = true) {
  if (activeChat && activeChat !== chat) {
    activeChat.panel.hidden = true;
    activeChat.link.removeAttribute('aria-current');
  }
  activeChat = chat;
  empty.hidden = Boolean(chat);
  if (!chat) { syncPreview(); return; }

  chat.panel.hidden = false;
  chat.link.setAttribute('aria-current', 'true');
  chat.row.scrollIntoView({ block: 'nearest', container: 'nearest' });
  rememberWorkspace(chat);
  const session = chat.current;
  syncPreview();
  if (!session) return;
  if (focus) {
    if (session.view.selected === 'terminal') showProjectShell(session, true);
    else if (session.view.selected === 'chat') session.terminal.focus();
    else session.view.dockTabs.get(session.view.selected)?.focus();
  }
  refreshHistory(session);
}

function updateChat(chat) {
  const { current, switching, closing } = chat;
  chat.cwd.replaceChildren(...[...chat.savedProjects.values()].map(project =>
    new Option(project.folder, project.id, false, project.id === chat.selectedId)));
  chat.cwd.title = chat.savedProjects.get(chat.selectedId)?.folder || '';
  chat.folderLabel.textContent = chat.cwd.title.split(/[\\/]/).filter(Boolean).at(-1) || chat.cwd.title;
  chat.link.title = [chat.title.textContent, chat.cwd.title].filter(Boolean).join(' · ');
  chat.cwd.disabled = !chat.savedProjects.size || switching || closing;
  chat.status.textContent = current?.updateStatus || (switching ? 'Starting…' : current?.ended ? 'Ended' : current?.running ? '' : 'Saved');
  chat.changeFolder.disabled = switching || closing;
  for (const button of chat.projectChatButtons) {
    button.disabled = !current || switching || closing;
  }
  chat.resume.hidden = Boolean(current && !current.ended) || !chat.selectedId;
  chat.resume.disabled = switching || closing;
  for (const button of chat.closeButtons) button.disabled = switching || closing;
}

function showSession(chat, session, focus = true) {
  chat.current = session;
  chat.selectedId = session.project.id;
  session.project.activeAgent = session.extra ? session.id : undefined;
  for (const entry of chat.panes.children) entry.hidden = entry.dataset.project !== session.project.id;
  updateChat(chat);
  if (chat === activeChat) selectChat(chat, focus);
}

function setError(error) {
  errorMessage.textContent = error ? error.message.replace(/^Error invoking remote method .*?: Error: /, '') : '';
  errorMessage.hidden = !error;
}

function removeSession(session) {
  sessions.delete(session.id);
  session.disposeChatInput?.();
  session.observer.disconnect();
  session.terminal.dispose();
  session.shell?.observer.disconnect();
  session.shell?.terminal.dispose();
  if (!session.extra) disposeEditor(session.view);
  session.view.previewObserver?.disconnect();
  removeDockSession(session);
}

function removeChat(chat) {
  const focused = [chat.panel, chat.row].some(element => element.contains(document.activeElement));
  chats.delete(chat.id);
  for (const session of chat.projects.values()) removeSession(session);
  for (const project of chat.savedProjects.values()) project.dock?.observer.disconnect();
  chat.panel.remove();
  chat.row.remove();
  if (chat === activeChat) selectChat([...chats.values()].at(-1), focused);
  if (focused && !activeChat?.panel.contains(document.activeElement)) {
    (activeChat?.link ?? document.getElementById(chat.agent)).focus();
  }
}

async function closeChat(chat) {
  if (chat.switching || chat.closing) return;
  const views = [...chat.projects.values()].map(session => session.view);
  if (views.some(view => view.fileBusy)) return;
  const scope = [...chat.savedProjects.values()].some(project => project.agents?.length)
    ? 'All agent chats in this workspace will close.'
    : 'The chat will be removed from the sidebar.';
  const warning = views.some(hasUnsavedFile)
    ? scope + ' Unsaved file edits will be discarded.'
    : scope;
  if (!await confirmAction('Close “' + chat.title.textContent + '”?', warning, 'Close chat')) return;
  chat.closing = true;
  updateChat(chat);
  const closed = await Promise.allSettled([...chat.projects.values()]
    .map(session => window.desk.close(session.id)));
  const failed = closed.find(result => result.status === 'rejected');
  if (failed) {
    setError(failed.reason);
    chat.closing = false;
    updateChat(chat);
  } else {
    try {
      await window.desk.removeWorkspace(chat.id);
      removeChat(chat);
    } catch (error) {
      chat.closing = false;
      updateChat(chat);
      setError(error);
    }
  }
}

async function closeSideChat(session) {
  const { chat, project, id, record } = session;
  if (!session.extra || chat.closing || chat.switching) return;
  if (!await confirmAction('Close “' + record.name + '”?',
    'This closes only this side chat.', 'Close chat')) return;
  chat.switching = true;
  updateChat(chat);
  try {
    await window.desk.close(id);
    await window.desk.removeProjectChat(chat.id, id);
    project.agents = project.agents.filter(item => item.id !== id);
    dockModel.removeSession(session.dock.layout, id);
    if (project.activeAgent === id) project.activeAgent = undefined;
    chat.projects.delete(id);
    removeSession(session);
    if (chat.current === session) {
      chat.current = undefined;
      const main = chat.projects.get(project.id);
      if (main) showSession(chat, main);
    }
  } catch (error) {
    setError(error);
  } finally {
    chat.switching = false;
    updateChat(chat);
    rememberWorkspace(chat);
  }
}

function folderKey(folder) {
  return folder.toLowerCase().replace(/[\\/]+$/, '');
}

async function loadProject(chat, project, picked = false, restart = false, sessionId = project.activeAgent) {
  const record = project.agents?.find(item => item.id === sessionId) ?? project;
  if (record !== project && !chat.projects.has(project.id)) await startSession(chat, project, project, false);
  const existing = chat.projects.get(record.id);
  if (existing && !restart) {
    showSession(chat, existing);
    return;
  }
  if (existing) {
    if (hasUnsavedFile(existing.view)) throw new Error('Save your file edits before resuming this session.');
    await window.desk.close(existing.id);
    chat.projects.delete(record.id);
    if (chat.current === existing) chat.current = undefined;
    removeSession(existing);
  }
  const previous = chat.current;
  try {
    await startSession(chat, project, record, picked);
  } catch (error) {
    chat.current = undefined;
    if (previous) showSession(chat, previous);
    else chat.selectedId = project.id;
    throw error;
  }
}

async function openSavedProject(chat, project) {
  const preferred = project.activeAgent ?? project.id;
  await loadProject(chat, project, false, false, project.id);
  for (const record of project.agents ?? []) {
    if (!chat.projects.has(record.id)) {
      try {
        await loadProject(chat, project, false, false, record.id);
      } catch (error) {
        setError(error);
      }
    }
  }
  showSession(chat, chat.projects.get(preferred) ?? chat.projects.get(project.id));
}

async function resumeProject(chat, id, restart = false) {
  if (chat.switching || chat.closing) return;
  const project = chat.savedProjects.get(id);
  if (!project) return;
  chat.switching = true;
  updateChat(chat);
  setError();
  try {
    if (restart) await loadProject(chat, project, false, true);
    else await openSavedProject(chat, project);
  } catch (error) {
    setError(error);
  } finally {
    chat.switching = false;
    updateChat(chat);
    rememberWorkspace(chat);
  }
}

async function switchFolder(chat) {
  if (chat.switching || chat.closing) return;
  setError();
  chat.switching = true;
  updateChat(chat);
  try {
    const id = crypto.randomUUID();
    const folder = await window.desk.pickChatFolder(id, chat.agent, chat.cwd.title);
    if (!folder) return;
    const existing = [...chat.savedProjects.values()].find(project => folderKey(project.folder) === folderKey(folder));
    const project = existing || { id, folder, view: 'chat' };
    chat.savedProjects.set(project.id, project);
    if (existing) await openSavedProject(chat, project);
    else await loadProject(chat, project, true);
  } catch (error) {
    setError(error);
  } finally {
    chat.switching = false;
    updateChat(chat);
    rememberWorkspace(chat);
  }
}

function newButton(text, action) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = text;
  button.addEventListener('click', action);
  return button;
}

function createChat(agent, id, label, projects = [], selectedId) {
  const panel = document.createElement('section');
  panel.className = 'chat';
  panel.id = 'chat-' + id;
  panel.hidden = true;
  const heading = document.createElement('header');
  const title = document.createElement('h2');
  title.id = 'title-' + id;
  panel.setAttribute('aria-labelledby', title.id);
  const cwd = document.createElement('select');
  cwd.setAttribute('aria-label', 'Saved project folders');
  cwd.className = 'cwd';
  const panes = document.createElement('div');
  panes.className = 'agent-panes';

  const row = rowTemplate.content.firstElementChild.cloneNode(true);
  const link = row.querySelector('.chat-link');
  const rename = row.querySelector('.chat-rename');
  const status = row.querySelector('.chat-status');
  const chat = { id, agent, panel, panes, title, cwd, row, link, rename, status,
    folderLabel: row.querySelector('.chat-folder'),
    projects: new Map(), savedProjects: new Map(projects.map(project => [project.id, project])),
    selectedId, switching: false, closing: false };
  const actions = document.createElement('div');
  actions.className = 'chat-actions';
  chat.changeFolder = newButton('Change folder', () => switchFolder(chat));
  chat.resume = newButton('Resume', () => resumeProject(chat, chat.selectedId, true));
  chat.projectChatButtons = Object.entries(names).map(([provider, name]) => {
    const button = newButton('+ ' + name, () => openProjectChat(chat, provider));
    button.title = 'New ' + name + ' chat in this project';
    button.setAttribute('aria-label', button.title);
    return button;
  });
  cwd.addEventListener('change', () => resumeProject(chat, cwd.value));
  const close = newButton('×', () => closeChat(chat));
  close.className = 'pane-close';
  actions.append(...chat.projectChatButtons, chat.resume, chat.changeFolder, close);
  heading.append(title, cwd, actions);
  panel.append(heading, panes);
  grid.append(panel);

  const rowClose = row.querySelector('.chat-close');
  rowClose.addEventListener('click', () => closeChat(chat));
  chat.closeButtons = [close, rowClose];
  chats.set(id, chat);
  setChatName(chat, label);
  link.setAttribute('aria-controls', panel.id);
  link.addEventListener('click', () => {
    selectChat(chat);
    if (!chat.current) resumeProject(chat, chat.selectedId);
  });
  rename.addEventListener('click', () => openRename(chat));
  row.addEventListener('contextmenu', event => showContextMenu(event, [
    ['Open project', () => link.click()],
    ['Rename project', () => openRename(chat)],
    ['Change folder', () => switchFolder(chat)],
    ['Close project', () => closeChat(chat)]
  ], link));
  document.getElementById(agent + '-chats').append(row);
  updateChat(chat);
  return chat;
}

async function openChat(agent) {
  if (!workspaceReady) return;
  setError();
  try {
    const folder = await window.desk.defaultFolder();
    const id = crypto.randomUUID();
    const project = { id, folder, view: 'chat' };
    const chat = createChat(agent, id, names[agent] + ' ' + ++counters[agent], [project], id);
    selectChat(chat);
    await resumeProject(chat, id);
  } catch (error) {
    setError(error);
  }
}

async function openProjectChat(source, agent) {
  if (!source.current || source.switching || source.closing) return;
  setError();
  source.switching = true;
  updateChat(source);
  try {
    const project = source.current.project;
    const saved = await window.desk.addProjectChat(source.id, project.id, crypto.randomUUID(),
      agent, names[agent] + ' ' + ++counters[agent]);
    (project.agents ??= []).push(saved);
    await loadProject(source, project, false, false, saved.id);
  } catch (error) {
    setError(error);
  } finally {
    source.switching = false;
    updateChat(source);
    rememberWorkspace(source);
  }
}

async function restoreWorkspace() {
  try {
    const saved = await window.desk.savedWorkspace();
    for (const entry of saved.chats) {
      counters[entry.agent] = Math.max(counters[entry.agent] + 1,
        Number(entry.name.match(/^(?:Codex|Claude) (\d+)$/)?.[1]) || 0);
      createChat(entry.agent, entry.id, entry.name, entry.projects, entry.selected);
      for (const project of entry.projects) {
        for (const item of project.agents ?? []) {
          counters[item.agent] = Math.max(counters[item.agent], Number(item.name.match(/ (\d+)$/)?.[1]) || 0);
        }
      }
    }
    const previous = chats.get(saved.active);
    if (previous) {
      selectChat(previous, false);
      resumeProject(previous, previous.selectedId);
    }
    workspaceReady = true;
  } catch (error) {
    setError(error);
  }
}

async function startSession(chat, project, record, usePickedFolder) {
  const { id } = record;
  const { folder } = project;
  const extra = record !== project;
  const view = createWorkspace();
  const body = view.root.querySelector('.agent-terminal');
  const { terminal, fit } = createTerminal();
  const session = { id, chat, folder, project, record, extra, agent: record.agent ?? chat.agent,
    body, terminal, view, running: false, ended: false };
  configureWorkspace(session);
  configureChatInput(session);
  terminal.open(body);
  session.observer = observeTerminalSize(body, fit);
  fitTerminal(body, fit);
  terminal.onData(data => {
    if (!session.running) return;
    if (data === '\r') {
      view.sentAt = Date.now();
      reportPetActivity('send', body);
    }
    window.desk.input(id, data).catch(setError);
  });
  terminal.onResize(({ cols, rows }) => {
    if (session.running) window.desk.resize(id, cols, rows).catch(setError);
  });
  sessions.set(id, session);
  showSession(chat, session);
  try {
    const { cols, rows } = terminal;
    await window.desk.start(id, session.agent, cols, rows, usePickedFolder, chat.id, chat.title.textContent);
    session.updateStatus = '';
    session.running = !session.ended;
    if (session.running && (terminal.cols !== cols || terminal.rows !== rows)) {
      window.desk.resize(id, terminal.cols, terminal.rows).catch(setError);
    }
    chat.projects.set(id, session);
    view.dockReady = true;
    applyDock(session.dock);
  } catch (error) {
    session.updateStatus = '';
    session.ended = session.launchFailed = true;
    chat.projects.set(id, session);
    view.dockReady = true;
    applyDock(session.dock);
    updateWorkspaceState(session);
    setError(error);
  }
  updateWorkspaceState(session);
}

window.desk.onData((id, data) => {
  const session = sessions.get(id);
  if (!session) return;
  session.terminal.write(data, () => updateWorkspaceState(session));
});
window.desk.onAgentUpdate((id, status) => {
  const session = sessions.get(id);
  if (!session) return;
  session.updateStatus = status;
  updateWorkspaceState(session);
  if (session.chat.current === session) updateChat(session.chat);
});

async function updateChatAgent(session) {
  if (session.view.updateAgent.disabled) return;
  const { terminal, chat } = session;
  session.updateStatus = 'Updating agent…';
  session.running = session.ended = false;
  updateWorkspaceState(session);
  if (chat.current === session) updateChat(chat);
  try {
    const result = await window.desk.updateAgent(session.id, terminal.cols, terminal.rows, session.providerId);
    if (!result || sessions.get(session.id) !== session) return;
    session.running = !session.ended;
    if (session.running) await window.desk.resize(session.id, terminal.cols, terminal.rows);
    if (result.updateError) terminal.writeln('\r\n[' + result.updateError + ']');
    if (chat === activeChat && chat.current === session && isViewVisible(session.view, 'chat')) terminal.focus();
  } catch (error) {
    session.ended = true;
    setError(error);
  } finally {
    session.updateStatus = '';
    if (sessions.get(session.id) === session) {
      updateWorkspaceState(session);
      if (chat.current === session) updateChat(chat);
    }
  }
  refreshAgentUsage();
}

let refreshingAgentUsage = false;
for (const agent of Object.keys(names)) {
  const section = document.getElementById(agent + '-usage-section');
  const key = 'usage-collapsed-' + agent;
  section.open = localStorage.getItem(key) !== 'true';
  section.addEventListener('toggle', () => localStorage.setItem(key, String(!section.open)));
}

const usageDate = new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: 'numeric' });
const usageAmount = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });

function usageChart(title, buckets) {
  const chart = node('figure', '', 'usage-chart');
  const svg = (tag, attributes) => {
    const element = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
    return element;
  };
  const amount = used => usageAmount.format(used) + '%';
  const points = buckets.flatMap(({ used, start }, index) => Number.isFinite(used)
    ? [{ used, start, index, x: 3 + index / (buckets.length - 1) * 194 }] : []);
  const latest = points.at(-1);
  const plot = svg('svg', { viewBox: '0 0 200 39', preserveAspectRatio: 'none', role: 'img',
    'aria-label': title + ' of account-wide 7-day limit usage. Dashed lines skip missing hours.' });
  const values = points.map(point => point.used);
  const low = values.length ? Math.floor(Math.min(...values) / 10) * 10 : 0;
  const high = values.length ? Math.max(low + 10, Math.ceil(Math.max(...values) / 10) * 10) : 100;
  const y = used => 35 - (used - low) / (high - low) * 31;
  for (const level of [4, 19.5, 35]) {
    plot.append(svg('line', { x1: 3, x2: 197, y1: level, y2: level, class: 'usage-grid' }));
  }
  for (const [index, point] of points.entries()) {
    const previous = points[index - 1];
    if (previous) plot.append(svg('line', {
      x1: previous.x, y1: y(previous.used), x2: point.x, y2: y(point.used),
      class: point.index - previous.index > 1 ? 'usage-line usage-gap' : 'usage-line'
    }));
    const dot = svg('circle', { cx: point.x, cy: y(point.used), r: point === latest ? 2.5 : 1.25 });
    const tooltip = svg('title', {});
    tooltip.textContent = usageDate.format(point.start) + ' · ' + amount(point.used) + ' used';
    dot.append(tooltip);
    plot.append(dot);
  }
  const caption = node('figcaption');
  caption.append(node('strong', title), node('span', latest ? amount(latest.used) + ' used' : 'Collecting readings'));
  const axis = node('div', '', 'usage-axis');
  axis.append(node('span', amount(low) + '–' + amount(high) + ' scale'),
    node('span', latest ? usageDate.format(latest.start) : ''));
  chart.append(caption, plot, axis);
  return chart;
}

async function refreshAgentUsage() {
  if (refreshingAgentUsage) return;
  refreshingAgentUsage = true;
  try {
    const { usage, charts } = await window.desk.agentUsage();
    for (const agent of Object.keys(names)) {
      document.getElementById(agent + '-charts').replaceChildren(
        usageChart('Last 24 hours', charts[agent].daily), usageChart('Last 7 days', charts[agent].weekly));
      const panel = document.getElementById(agent + '-usage');
      const windows = usage[agent];
      if (!windows.length) {
        panel.textContent = agent === 'claude' ? 'Available after a supported chat reply' : 'Usage unavailable';
        continue;
      }
      panel.replaceChildren(...windows.map(({ label, used, reset }) => {
        const row = node('div', '', 'usage-window');
        const meter = document.createElement('progress');
        meter.max = 100;
        meter.value = Math.min(100, used);
        meter.setAttribute('aria-label', names[agent] + ' ' + label + ' usage');
        if (reset) row.title = 'Resets ' + new Date(reset * 1000).toLocaleString();
        row.append(node('span', label), node('span', Math.round(used) + '% used'), meter);
        return row;
      }));
    }
  } catch (error) {
    setError(error);
  } finally {
    refreshingAgentUsage = false;
  }
}
refreshAgentUsage();
setInterval(refreshAgentUsage, 60000);

window.desk.onExit((id, code) => {
  const session = sessions.get(id);
  if (!session) return;
  session.running = false;
  session.ended = true;
  if (session.chat.current === session) updateChat(session.chat);
  refreshHistory(session);
  session.terminal.writeln('\r\n[Chat ended' + (code ? ' with exit code ' + code : '') + ']');
});

for (const agent of Object.keys(names)) {
  document.getElementById(agent).addEventListener('click', () => openChat(agent));
}

function setChatName(chat, name) {
  chat.title.textContent = chat.title.title = name;
  chat.row.querySelector('.chat-label').textContent = name;
  chat.link.title = [name, chat.cwd.title].filter(Boolean).join(' · ');
  chat.rename.setAttribute('aria-label', 'Rename ' + name);
  for (const button of chat.closeButtons) {
    button.setAttribute('aria-label', 'Close project ' + name);
    button.title = 'Close project ' + name;
  }
}

function openRename(chat) {
  renamingChat = chat;
  renameDialog.returnValue = '';
  renameInput.value = chat.title.textContent;
  renameDialog.showModal();
  syncPreview();
  renameInput.select();
}

renameDialog.addEventListener('close', () => {
  const name = renameInput.value.trim();
  if (renameDialog.returnValue === 'save' && name && chats.has(renamingChat?.id)) {
    setChatName(renamingChat, name);
    window.desk.renameWorkspace(renamingChat.id, name).catch(setError);
  }
  renamingChat = undefined;
});

setInterval(() => {
  for (const session of sessions.values()) {
    const visible = session.chat === activeChat && session.project.id === activeChat.selectedId
      && (isViewVisible(session.view, 'chat') || isViewVisible(session.view, 'workflow'));
    const needsBinding = session.running && session.agent === 'codex' && session.providerId && !session.providerBound;
    if (visible || needsBinding) refreshHistory(session);
  }
}, 900);

const maximizeButton = document.getElementById('window-maximize');
for (const action of ['minimize', 'maximize', 'close']) {
  document.getElementById('window-' + action).addEventListener('click', () => {
    window.desk.windowControl(action).catch(setError);
  });
}
window.desk.onWindowMaximized(maximized => {
  maximizeButton.classList.toggle('is-maximized', maximized);
  maximizeButton.title = maximized ? 'Restore' : 'Maximize';
  maximizeButton.setAttribute('aria-label', maximizeButton.title + ' window');
});

window.desk.onConfirmWindowClose(async () => {
  if (!await confirmAction('Close Perona?', 'Unsaved edits will be lost.', 'Discard and close')) return;
  window.desk.windowControl('discard-close').catch(setError);
});
window.addEventListener('beforeunload', event => {
  if (hasUnsavedServiceConfig() || [...sessions.values()].some(session => hasUnsavedFile(session.view))) {
    event.preventDefault();
    event.returnValue = false;
  }
});
restoreWorkspace();
