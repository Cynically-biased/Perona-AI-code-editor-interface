const workspaceTemplate = document.querySelector('#project-workspace');
const emptySnapshot = { messages: [], activity: [], working: false };
const codexId = /·\s*([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})(?![a-f0-9])/i;

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text) element.textContent = text;
  if (className) element.className = className;
  return element;
}

function createWorkspace() {
  return {
    root: workspaceTemplate.content.firstElementChild.cloneNode(true),
    selected: 'chat',
    snapshot: emptySnapshot
  };
}

function configureWorkspace(session) {
  const view = session.view;
  const { root } = view;
  root.querySelector('.agent-terminal-heading h3').textContent = names[session.agent] + ' chat';
  view.terminalStatus = root.querySelector('.agent-terminal-status');
  view.updateAgent = root.querySelector('.agent-update');
  view.updateAgent.addEventListener('click', () => updateChatAgent(session));
  if (session.extra) {
    for (const element of root.querySelectorAll('[data-view], [data-panel]')) {
      if (!dockModel.agentTabs.includes(element.dataset.view ?? element.dataset.panel)) element.remove();
    }
  } else {
    root.querySelector('.file-refresh').addEventListener('click', () => loadFiles(session));
    root.querySelector('.changes-refresh').addEventListener('click', () => loadChanges(session));
    configureEditor(session);
    configureTools(session);
    configureGit(session);
  }
  configureDock(session);
}

function promptReady(session) {
  if (!session.running || !session.terminal.modes.bracketedPasteMode) return false;
  const buffer = session.terminal.buffer.active;
  const row = buffer.baseY + buffer.cursorY;
  const line = buffer.getLine(row)?.translateToString(true).trim() ?? '';
  if (buffer.cursorX !== 2) return false;
  if (session.agent === 'codex') {
    const ready = /^›(?:\s+Ask Codex to do anything)?$/.test(line);
    if (ready && !session.providerId) {
      const footer = Array.from({ length: Math.min(7, buffer.length - row - 1) }, (_, index) =>
        buffer.getLine(row + index + 1)?.translateToString(true).trim() ?? '').join('');
      session.providerId = footer.match(codexId)?.[1];
    }
    return ready && Boolean(session.providerId);
  }
  const footer = Array.from({ length: Math.min(10, buffer.length - row + 3) }, (_, index) =>
    buffer.getLine(row - 3 + index)?.translateToString(true) ?? '').join(' ');
  if (/esc to interrupt/i.test(footer)) return false;
  const before = buffer.getLine(row - 1)?.translateToString(true).trim() ?? '';
  const after = buffer.getLine(row + 1)?.translateToString(true).trim() ?? '';
  return /^❯(?:\s+Try\b.*)?$/.test(line) && /^─{8}/.test(before) && /^─{8}/.test(after);
}

function updateWorkspaceState(session) {
  const { view } = session;
  const working = session.running && view.snapshot.working;
  const ready = session.running && !working && session.readyPrompt;
  const status = session.updateStatus || (session.ended ? 'Session ended' : !session.running ? 'Starting…'
    : working ? 'Working…' : ready ? 'Ready' : 'Agent session');
  view.updateAgent.disabled = Boolean(session.updateStatus || session.launchFailed ||
    (!session.ended && !ready));
  session.body.classList.toggle('is-working', working);
  if (view.terminalStatus.textContent !== status) view.terminalStatus.textContent = status;
  view.dockPanels.get('workflow').querySelector('.workflow-state').textContent = working ? 'Working…' : '';
}

function renderHistory(session, snapshot) {
  const view = session.view;
  const workflow = view.dockPanels.get('workflow');
  const list = workflow.querySelector('.activity-list');
  if (JSON.stringify(view.snapshot.activity) !== JSON.stringify(snapshot.activity)) {
    list.replaceChildren(...snapshot.activity.slice().reverse().map(item => {
      const entry = node('li', '', 'activity-entry');
      const line = node('header', '', 'activity-header');
      line.append(node('strong', item.label));
      const status = { inProgress: 'Running', completed: 'Done', failed: 'Failed',
        declined: 'Declined', pending: 'Pending' }[item.status];
      if (status) line.append(node('span', status, 'activity-status'));
      entry.append(line);
      if (item.detail) entry.append(node('pre', item.detail));
      return entry;
    }));
  }
  workflow.querySelector('.activity-empty').hidden = snapshot.activity.length > 0;
  view.snapshot = snapshot;
}

async function refreshHistory(session) {
  const { view } = session;
  if (view.refreshing || session.launchFailed || (!session.running && !session.ended)) return;
  view.refreshing = true;
  try {
    const snapshot = await window.desk.history(session.id, session.providerId, session.readyPrompt);
    if (!sessions.has(session.id)) return;
    if (snapshot.thread) session.providerBound = true;
    if (activeChat?.current === session && (view.sentAt || view.snapshot.messages.length)
        && snapshot.messages.length > view.snapshot.messages.length
        && snapshot.messages.at(-1)?.role === 'assistant') reportPetActivity('answer', session.body);
    renderHistory(session, snapshot);
    updateWorkspaceState(session);
  } catch (error) {
    if (sessions.has(session.id)) {
      if (!view.historyError) {
        view.historyError = true;
        setError(new Error('Workflow history is temporarily unavailable. Chat is still available.'));
      }
      updateWorkspaceState(session);
    }
  } finally {
    view.refreshing = false;
  }
}

function loadFiles(session) {
  return loadFileBranch(session, '', session.view.filesPanel.querySelector('.file-list'));
}

async function loadFileBranch(session, directory, list) {
  const { view } = session;
  const loading = node('p', 'Loading files…', 'view-state');
  list.replaceChildren(loading);
  try {
    const result = await window.desk.files(session.id, directory);
    if (loading.parentElement !== list || !view.filesPanel.contains(list)) return;
    if (!directory) view.filesLoaded = true;
    const expanded = [];
    list.replaceChildren(...result.entries.map(entry => {
      const button = node('button', '', entry.directory ? 'file-entry directory' : 'file-entry');
      if (!entry.directory) button.append(fileFormatBadge(entry.name));
      button.append(node('span', entry.name, 'file-name'));
      button.type = 'button';
      button.title = entry.name;
      const relative = directory ? directory + '/' + entry.name : entry.name;
      const branch = entry.directory ? node('div', '', 'file-children') : null;
      const toggle = () => {
        const open = branch.hidden;
        branch.hidden = !open;
        button.setAttribute('aria-expanded', String(open));
        if (open) {
          view.expandedFolders.add(relative);
          loadFileBranch(session, relative, branch);
        } else view.expandedFolders.delete(relative);
      };
      const open = entry.directory ? toggle : () => loadPreview(session, relative);
      button.addEventListener('click', open);
      const row = node('div', '', 'file-list-row');
      const move = node('button', '…', 'file-move');
      move.type = 'button';
      move.title = 'Actions for ' + entry.name;
      move.setAttribute('aria-label', move.title);
      move.setAttribute('aria-haspopup', 'menu');
      const actions = () => [
        [entry.directory ? (branch.hidden ? 'Expand folder' : 'Collapse folder') : 'Open file', open],
        ...(entry.directory ? [
          ['New file here', () => openFileAction(session, 'file', relative + '/')],
          ['New folder here', () => openFileAction(session, 'directory', relative + '/')]
        ] : []),
        ['Rename', () => openFileAction(session, 'rename', relative)],
        ['Move to path…', () => openFileAction(session, 'move', relative)],
        ['Remove', () => removeFileEntry(session, relative, entry.directory === true)]
      ];
      if (entry.directory) {
        branch.hidden = !view.expandedFolders.has(relative);
        button.setAttribute('aria-expanded', String(!branch.hidden));
        if (!branch.hidden) expanded.push([relative, branch]);
        configureFileDrop(session, row, () => relative);
      }
      row.addEventListener('contextmenu', event => showContextMenu(event, actions(), button));
      move.addEventListener('click', event => showContextMenu(event, actions(), move));
      button.draggable = true;
      button.addEventListener('dragstart', event => {
        if (view.fileBusy) { event.preventDefault(); return; }
        if (contextMenu.matches(':popover-open')) contextMenu.hidePopover();
        view.fileDrag = relative;
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', entry.name);
        liftDragItem(event, row);
      });
      button.addEventListener('dragend', () => {
        view.fileDrag = undefined;
        for (const target of view.filesPanel.querySelectorAll('.file-directory-target')) {
          target.classList.remove('file-directory-target');
        }
      });
      const remove = node('button', '×', 'file-remove');
      remove.type = 'button';
      remove.title = 'Remove ' + entry.name;
      remove.setAttribute('aria-label', remove.title);
      remove.addEventListener('click', () => removeFileEntry(session, relative, entry.directory === true));
      row.append(button, move, remove);
      if (!branch) return row;
      const folder = node('div');
      folder.append(row, branch);
      return folder;
    }));
    if (!result.entries.length) list.append(node('p', 'This folder is empty.', 'view-state'));
    if (result.truncated) list.append(node('p', 'Showing the first 1,500 items.', 'view-state'));
    await Promise.all(expanded.map(([path, branch]) => loadFileBranch(session, path, branch)));
  } catch (error) {
    if (loading.parentElement === list) list.replaceChildren(node('p', readableError(error), 'view-state'));
  }
}

async function loadChanges(session) {
  const { view } = session;
  const panel = view.dockPanels.get('changes');
  const content = panel.querySelector('.changes-content');
  const refresh = panel.querySelector('.changes-refresh');
  if (refresh.disabled) return;
  refresh.disabled = true;
  content.replaceChildren(node('p', 'Checking Git…', 'view-state'));
  try {
    const result = await window.desk.changes(session.id);
    content.replaceChildren();
    if (result.status?.trim()) {
      content.append(node('h4', 'Changed files'), node('pre', result.status.trimEnd(), 'diff-content'));
    }
    if (result.diff?.trim()) {
      const diff = node('pre', '', 'diff-content');
      const lines = result.diff.trimEnd().split('\n');
      for (const line of lines.slice(0, 2500)) {
        const kind = line.startsWith('+') ? 'addition' : line.startsWith('-') ? 'removal' : '';
        diff.append(node('span', line + '\n', kind));
      }
      if (lines.length > 2500) diff.append(node('span', '… Diff preview truncated'));
      content.append(node('h4', 'Diff'), diff);
    }
    if (result.notice || !result.status?.trim()) {
      content.append(node('p', result.notice || 'No uncommitted changes.', 'view-state'));
    }
  } catch (error) {
    content.replaceChildren(node('p', readableError(error), 'view-state'));
  } finally {
    refresh.disabled = false;
  }
}

function readableError(error) {
  return error.message.replace(/^Error invoking remote method .*?: Error: /, '');
}
