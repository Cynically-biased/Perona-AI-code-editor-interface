const monitorDialog = document.querySelector('#monitor-dialog');
const servicesDialog = document.querySelector('#services-dialog');
const confirmDialog = document.querySelector('#confirm-dialog');
const contextMenu = document.querySelector('#context-menu');
let confirmationPending = false;
let menuTrigger;
let liftedDrag;
let externalDropTarget;
const emptyDragImage = document.createElement('canvas');
emptyDragImage.width = emptyDragImage.height = 1;

function highlightExternalDrop(target) {
  if (externalDropTarget === target) return;
  externalDropTarget?.classList.remove('external-drop-target');
  externalDropTarget = target;
  target?.classList.add('external-drop-target');
}

function configureExternalDrop(target, onDrop) {
  target.addEventListener('dragover', event => {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'copy';
    highlightExternalDrop(target);
  });
  target.addEventListener('dragleave', event => {
    if (externalDropTarget === target && !target.contains(event.relatedTarget)) highlightExternalDrop();
  });
  target.addEventListener('drop', event => {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    event.stopPropagation();
    highlightExternalDrop();
    onDrop(Array.from(event.dataTransfer.files));
  });
}

// Keep Chromium from navigating to a file dropped outside a supported target.
for (const type of ['dragover', 'drop']) {
  document.addEventListener(type, event => {
    if (event.dataTransfer?.types.includes('Files')) {
      event.preventDefault();
      highlightExternalDrop();
    }
  });
}

function liftDragItem(event, source) {
  releaseDragItem();
  const bounds = source.getBoundingClientRect();
  const floating = node('div', '', 'drag-lift');
  const content = source.cloneNode(true);
  content.removeAttribute('id');
  for (const item of content.querySelectorAll('[id]')) item.removeAttribute('id');
  floating.setAttribute('aria-hidden', 'true');
  floating.inert = true;
  floating.style.width = bounds.width + 'px';
  floating.style.height = bounds.height + 'px';
  floating.append(content);
  document.body.append(floating);
  liftedDrag = { source, floating, x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  updateDragLift(event);
  event.dataTransfer.setDragImage(emptyDragImage, 0, 0);
  source.classList.add('drag-source-lifted');
  syncPreview();
}

function updateDragLift(event) {
  if (!liftedDrag) return;
  const { floating, x, y } = liftedDrag;
  floating.style.transform = 'translate3d(' + (event.clientX - x) + 'px, ' + (event.clientY - y) + 'px, 0)';
}

function releaseDragItem() {
  if (!liftedDrag) return;
  liftedDrag.source.classList.remove('drag-source-lifted');
  liftedDrag.floating.remove();
  liftedDrag = undefined;
  syncPreview();
}

document.addEventListener('dragover', updateDragLift, true);
document.addEventListener('dragend', releaseDragItem, true);
document.addEventListener('drop', releaseDragItem, true);

function showContextMenu(event, actions, trigger = event.currentTarget) {
  event.preventDefault();
  event.stopPropagation();
  menuTrigger = trigger;
  const rect = trigger.getBoundingClientRect();
  const keyboard = event.type === 'contextmenu' && !event.clientX && !event.clientY;
  const x = keyboard ? rect.left : event.type === 'click' ? rect.left : event.clientX;
  const y = keyboard || event.type === 'click' ? rect.bottom : event.clientY;
  const buttons = actions.map(([label, action]) => {
    const button = node('button', label);
    button.type = 'button';
    button.setAttribute('role', 'menuitem');
    button.tabIndex = -1;
    button.addEventListener('click', () => {
      contextMenu.hidePopover();
      if (trigger.isConnected) trigger.focus();
      action();
    });
    return button;
  });
  contextMenu.replaceChildren(...buttons);
  if (!contextMenu.matches(':popover-open')) contextMenu.showPopover();
  contextMenu.style.left = Math.max(4, Math.min(x, innerWidth - contextMenu.offsetWidth - 4)) + 'px';
  contextMenu.style.top = Math.max(4, Math.min(y, innerHeight - contextMenu.offsetHeight - 4)) + 'px';
  buttons[0]?.focus();
}

contextMenu.addEventListener('keydown', event => {
  const items = [...contextMenu.children];
  const index = items.indexOf(document.activeElement);
  const targets = { ArrowDown: (index + 1) % items.length,
    ArrowUp: (index + items.length - 1) % items.length, Home: 0, End: items.length - 1 };
  if (Object.hasOwn(targets, event.key)) {
    event.preventDefault();
    items[targets[event.key]]?.focus();
  }
  if (event.key === 'Escape' || event.key === 'Tab') {
    event.preventDefault();
    contextMenu.hidePopover();
    menuTrigger?.focus();
  }
});

async function confirmAction(title, message, action) {
  if (confirmationPending) return false;
  confirmationPending = true;
  confirmDialog.querySelector('#confirm-title').textContent = title;
  confirmDialog.querySelector('#confirm-message').textContent = message;
  confirmDialog.querySelector('#confirm-action').textContent = action;
  confirmDialog.returnValue = '';
  try {
    confirmDialog.showModal();
    syncPreview();
    return await new Promise(resolve => {
      confirmDialog.addEventListener('close', () => resolve(confirmDialog.returnValue === 'save'), { once: true });
    });
  } finally {
    confirmationPending = false;
  }
}
let visiblePreview;
const previewGuest = document.getElementById('local-preview');
let servicesReading = false;

function hidePreview() {
  previewGuest.hidden = true;
  if (visiblePreview) window.desk.previewHide().catch(setError);
  visiblePreview = undefined;
}

function browserMessage(session, text) {
  const element = session.view.previewPanel.querySelector('.browser-message');
  if (element.textContent !== text) element.textContent = text;
  element.hidden = !text;
}

function syncPreview() {
  const session = activeChat?.projects.get(activeChat.selectedId);
  const anyDialog = document.querySelector('dialog[open]');
  if (!session || !isViewVisible(session.view, 'preview') || anyDialog || liftedDrag
      || session.dock.busy || session.dock.root.querySelector('.dock-controls[open]')) {
    hidePreview();
    return;
  }
  if (session.view.previewUrl === undefined) {
    hidePreview();
    if (!session.view.previewDetecting && (session.running || session.ended)) detectPreview(session);
    return;
  }
  if (!session.view.previewUrl) {
    hidePreview();
    browserMessage(session, 'No site is mapped to this folder. Enter its localhost URL to preview it.');
    return;
  }
  const { x, y, width, height } = session.view.surface.getBoundingClientRect();
  if (!width || !height) { hidePreview(); return; }
  Object.assign(previewGuest.style, { left: x + 'px', top: y + 'px', width: width + 'px', height: height + 'px' });
  previewGuest.hidden = false;
  visiblePreview = session;
  window.desk.previewShow(session.id, session.view.previewUrl)
    .catch(error => {
      if (visiblePreview === session) {
        hidePreview();
        browserMessage(session, readableError(error));
      }
    });
}

async function detectPreview(session, replace = false) {
  const { view } = session;
  if (view.previewDetecting) return;
  view.previewDetecting = true;
  const previous = view.previewUrl;
  try {
    const url = await window.desk.previewSuggest(session.id);
    if (!replace && (view.previewUrl !== previous || view.previewUrl !== undefined)) return;
    view.previewUrl = url ?? '';
    view.previewPanel.querySelector('.browser-url').value = view.previewUrl;
    browserMessage(session, '');
    syncPreview();
  } catch (error) {
    view.previewUrl ??= '';
    browserMessage(session, readableError(error));
  } finally {
    view.previewDetecting = false;
  }
}

function configureTools(session) {
  const { view } = session;
  view.previewPanel = view.root.querySelector('[data-panel="preview"]');
  const toolbar = view.previewPanel.querySelector('.browser-toolbar');
  const address = toolbar.querySelector('input');
  view.surface = view.previewPanel.querySelector('.browser-surface');
  toolbar.querySelector('.browser-project').addEventListener('click', () => detectPreview(session, true));
  view.previewObserver = new ResizeObserver(() => {
    if (activeChat === session.chat && !session.dock.root.hidden && isViewVisible(view, 'preview')) syncPreview();
  });
  view.previewObserver.observe(view.surface);
  toolbar.addEventListener('submit', event => {
    event.preventDefault();
    view.previewUrl = address.value.trim();
    browserMessage(session, '');
    syncPreview();
  });
  toolbar.querySelector('.browser-refresh').addEventListener('click', () => {
    browserMessage(session, '');
    window.desk.previewReload(session.id).catch(setError);
  });
  toolbar.querySelector('.browser-back').addEventListener('click', () => {
    browserMessage(session, '');
    window.desk.previewBack(session.id).catch(setError);
  });
}

window.desk.onPreview((id, result) => {
  const session = sessions.get(id);
  if (!session) return;
  if (result.url) {
    session.view.previewUrl = result.url;
    session.view.previewPanel.querySelector('.browser-url').value = result.url;
  }
  browserMessage(session, result.error ? 'Could not load this site: ' + result.error : '');
});

function agentStatus(session) {
  if (session.ended) return 'Ended';
  if (!session.running) return 'Starting';
  if (session.view.snapshot.working) return 'Working';
  return promptReady(session) ? 'Ready' : 'Check Chat';
}

function renderMonitor() {
  if (!monitorDialog.open) return;
  const list = monitorDialog.querySelector('#monitor-list');
  const records = [...sessions.values()];
  const signature = JSON.stringify(records.map(session =>
    [session.id, session.record.name ?? session.chat.title.textContent, session.folder, agentStatus(session)]));
  if (list.dataset.snapshot === signature) return;
  list.dataset.snapshot = signature;
  list.replaceChildren(...records.map(session => {
    const row = node('div', '', 'tool-row');
    const info = node('div', '', 'tool-row-info');
    info.append(node('strong', session.record.name ?? session.chat.title.textContent), node('span', session.folder));
    const open = node('button', 'Open', 'tool-button');
    open.type = 'button';
    open.addEventListener('click', () => {
      monitorDialog.close();
      selectChat(session.chat, false);
      showSession(session.chat, session);
    });
    row.append(info, node('span', agentStatus(session), 'tool-status'), open);
    return row;
  }));
  if (!records.length) list.append(node('p', 'No agent sessions are open.', 'view-state'));
}

const xamppMessage = document.querySelector('#xampp-message');
const detail = document.querySelector('#xampp-detail');
const detailTitle = document.querySelector('#xampp-detail-title');
const configPath = document.querySelector('#xampp-config-path');
const configText = document.querySelector('#xampp-config-text');
const configSave = document.querySelector('#xampp-config-save');
const serviceLog = document.querySelector('#service-log');
let selectedConfig;
let configBusy = false;
let detailRequest = 0;

function panelMessage(text = '') {
  xamppMessage.textContent = text;
  xamppMessage.hidden = !text;
}

function hasUnsavedServiceConfig() {
  return Boolean(selectedConfig?.revision && configText.value !== selectedConfig.text);
}

async function mayLeaveDetail() {
  return !configBusy && (!hasUnsavedServiceConfig() || await confirmAction(
    'Discard configuration edits?', 'Unsaved XAMPP configuration edits will be lost.', 'Discard edits'));
}

async function closeDetails() {
  if (!await mayLeaveDetail()) return false;
  detailRequest++;
  detail.hidden = true;
  selectedConfig = undefined;
  return true;
}

function toolButton(text, action, disabled = false) {
  const button = node('button', text, 'tool-button');
  button.type = 'button';
  button.disabled = disabled;
  button.addEventListener('click', action);
  return button;
}

function presentDetails(title, config = false) {
  detail.hidden = false;
  detailTitle.textContent = title;
  configPath.hidden = configSave.hidden = configText.hidden = !config;
  serviceLog.hidden = config;
  configSave.disabled = true;
}

async function showLog(label, read) {
  if (!await closeDetails()) return;
  const request = ++detailRequest;
  presentDetails(label);
  serviceLog.textContent = 'Loading…';
  try {
    const output = await read();
    if (request !== detailRequest) return;
    serviceLog.textContent = output || 'No entries found.';
    if (label.endsWith(' log')) serviceLog.scrollTop = serviceLog.scrollHeight;
  } catch (error) {
    if (request === detailRequest) serviceLog.textContent = readableError(error);
  }
}

async function readConfig(id, relative) {
  configBusy = true;
  configText.readOnly = true;
  configSave.disabled = configPath.disabled = true;
  configText.value = '';
  panelMessage('Loading configuration…');
  try {
    const data = await window.desk.xamppConfig(id, relative);
    const text = (data.text || '').replace(/\r\n|\r/g, '\n');
    selectedConfig = { id, relative, revision: data.revision, text };
    configText.value = text;
    panelMessage(data.revision ? '' : 'This configuration can only be previewed.');
  } catch (error) {
    selectedConfig = { id, relative };
    panelMessage(readableError(error));
  } finally {
    configBusy = configPath.disabled = false;
    configText.readOnly = !selectedConfig?.revision;
  }
}

async function openConfig(id, label, files) {
  if (!await closeDetails()) return;
  presentDetails(label, true);
  configPath.replaceChildren(...files.map(file => new Option(file, file)));
  readConfig(id, configPath.value);
}

configPath.addEventListener('change', async () => {
  const target = configPath.value;
  if (!await mayLeaveDetail()) {
    if (selectedConfig) configPath.value = selectedConfig.relative;
    return;
  }
  readConfig(selectedConfig.id, target);
});
configText.addEventListener('input', () => {
  configSave.disabled = configBusy || !hasUnsavedServiceConfig() || selectedConfig?.conflict;
});
configSave.addEventListener('click', async () => {
  if (configSave.disabled || !selectedConfig) return;
  const item = selectedConfig;
  const text = configText.value;
  configBusy = configText.readOnly = configPath.disabled = configSave.disabled = true;
  try {
    const result = await window.desk.xamppConfigSave(item.id, item.relative, item.revision, text);
    if (result.conflict) {
      item.conflict = true;
      panelMessage('Changed on disk. Copy your edits before reopening this configuration.');
    } else {
      item.revision = result.revision;
      item.text = text;
      panelMessage('Saved. Restart the affected module if it needs to reread its configuration.');
    }
  } catch (error) {
    panelMessage(readableError(error));
  } finally {
    configBusy = configText.readOnly = configPath.disabled = false;
    configText.dispatchEvent(new Event('input'));
  }
});
document.querySelector('#xampp-detail-close').addEventListener('click', closeDetails);
async function closeServices() {
  if (await closeDetails()) servicesDialog.close();
}
document.querySelector('#xampp-close').addEventListener('click', closeServices);
servicesDialog.addEventListener('cancel', event => {
  event.preventDefault();
  closeServices();
});
document.querySelector('#xampp-panel-config').addEventListener('click', () =>
  openConfig('panel', 'XAMPP configuration', ['xampp-control.ini']));
document.querySelector('#xampp-netstat').addEventListener('click', () => {
  showLog('Listening TCP ports', async () => (await window.desk.xamppNetstat())
    .sort((a, b) => a.port - b.port)
    .map(row => row.address + ':' + row.port + '   PID ' + row.pid).join('\n'));
});
for (const button of document.querySelectorAll('[data-xampp-utility]')) {
  button.addEventListener('click', () => window.desk.xamppUtility(button.dataset.xamppUtility)
    .catch(error => panelMessage(readableError(error))));
}

async function moduleAction(service, action, button) {
  if (['install', 'remove'].includes(action)) {
    const label = action === 'install' ? 'Register service' : 'Remove service';
    const message = action === 'install'
      ? 'Register ' + service.label + ' as a Windows service?'
      : 'Remove the ' + service.label + ' Windows service registration?';
    if (!await confirmAction(label + '?', message, label)) return;
  }
  button.disabled = true;
  panelMessage('');
  try { await window.desk.xamppControl(service.id, action); }
  catch (error) { panelMessage(readableError(error)); }
  finally {
    servicesDialog.querySelector('#services-list').dataset.snapshot = '';
    renderServices();
  }
}

async function renderServices() {
  if (!servicesDialog.open || servicesReading) return;
  servicesReading = true;
  const list = servicesDialog.querySelector('#services-list');
  try {
    const { root, services } = await window.desk.xamppStatus();
    if (!servicesDialog.open) return;
    servicesDialog.querySelector('#xampp-root').textContent = root;
    const signature = JSON.stringify(services.map(({ id, installed, running, busy, issue, pids, ports, service }) =>
      [id, installed, running, busy, issue, pids, ports, service]));
    if (list.dataset.snapshot === signature) return;
    list.dataset.snapshot = signature;
    list.replaceChildren(...services.map(service => {
      const row = node('tr');
      if (service.running) row.classList.add('xampp-running');
      const registration = node('td');
      const serviceText = service.service ? 'Remove' : 'Install';
      if (service.canRegister) registration.append(toolButton(serviceText,
        event => moduleAction(service, service.service ? 'remove' : 'install', event.currentTarget),
        !service.installed || service.busy || service.running));
      else registration.textContent = '—';
      if (service.service) registration.title = service.service.Name;
      const module = node('td', '', 'xampp-module');
      const status = !service.installed ? 'Not installed' : service.busy ? 'Working…' : service.service?.State ?? (service.running ? 'Running' : 'Stopped');
      module.append(node('strong', service.label), node('span', status, 'tool-status'));
      if (service.issue) module.append(node('span', service.issue, 'xampp-issue'));
      const actions = node('td');
      const group = node('div', '', 'xampp-actions');
      group.append(
        toolButton(service.running ? 'Stop' : 'Start',
          event => moduleAction(service, service.running ? 'stop' : 'start', event.currentTarget), !service.installed || service.busy),
        toolButton('Admin', () => window.desk.xamppAdmin(service.id).catch(error => panelMessage(readableError(error))), !service.installed),
        toolButton('Config', () => openConfig(service.id, service.label + ' configuration', service.configs), !service.installed),
        toolButton('Logs', () => showLog(service.label + ' log', () => window.desk.xamppLog(service.id)), !service.installed));
      actions.append(group);
      row.append(registration, module, node('td', service.pids.join(', ') || '—'),
        node('td', service.ports.join(', ') || '—'), actions);
      return row;
    }));
  } catch (error) {
    list.dataset.snapshot = '';
    panelMessage(readableError(error));
  } finally {
    servicesReading = false;
  }
}

document.querySelector('#open-monitor').addEventListener('click', () => {
  monitorDialog.showModal();
  syncPreview();
  renderMonitor();
});
document.querySelector('#open-services').addEventListener('click', () => {
  servicesDialog.showModal();
  syncPreview();
  renderServices();
});
for (const dialog of document.querySelectorAll('dialog')) dialog.addEventListener('close', syncPreview);

setInterval(() => {
  if (monitorDialog.open) {
    for (const session of sessions.values()) refreshHistory(session);
    renderMonitor();
  }
  if (servicesDialog.open) renderServices();
}, 1800);
