const chats = new Map();
const sessions = new Map();
const counters = { claude: 0, codex: 0 };
const names = { claude: 'Claude', codex: 'Codex' };
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
  chat.status.textContent = switching ? 'Starting…' : current?.ended ? 'Ended' : current?.running ? '' : 'Saved';
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
  const resize = () => fitTerminal(body, fit);
  const observer = new ResizeObserver(resize);
  const session = { id, chat, folder, project, record, extra, agent: record.agent ?? chat.agent,
    body, terminal, observer, view, running: false, ended: false };
  configureWorkspace(session);
  terminal.open(body);
  observer.observe(body);
  resize();
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
    session.running = !session.ended;
    if (session.running && (terminal.cols !== cols || terminal.rows !== rows)) {
      window.desk.resize(id, terminal.cols, terminal.rows).catch(setError);
    }
    chat.projects.set(id, session);
    view.dockReady = true;
    applyDock(session.dock);
  } catch (error) {
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
