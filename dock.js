function isViewVisible(view, name) {
  return view.visibleViews?.has(name) ?? false;
}

function setDockBusy(dock, busy) {
  dock.busy = busy;
  syncPreview();
}

function dockButton(label, action) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.addEventListener('click', action);
  return button;
}

function findDockNode(node, id) {
  if (node.id === id) return node;
  if (!node.tabs) return findDockNode(node.first, id) ?? findDockNode(node.second, id);
}

function createProjectDock(chat, project) {
  const root = document.createElement('div');
  root.className = 'project-workspace project-dock';
  root.dataset.project = project.id;
  const indicator = document.createElement('div');
  indicator.className = 'dock-indicator';
  indicator.hidden = true;
  indicator.setAttribute('aria-hidden', 'true');
  root.append(indicator);
  chat.panes.append(root);
  const dock = { root, chat, project, indicator, panes: new Map(), dividers: new Map(), entries: new Map(),
    layout: dockModel.projectLayout(project, () => crypto.randomUUID()) };
  root.addEventListener('dragover', event => {
    if (!dock.drag) return;
    const drop = dockTarget(dock, event);
    indicator.hidden = !drop;
    if (!drop) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const box = root.getBoundingClientRect();
    position(indicator, { ...drop, x: drop.x - box.x, y: drop.y - box.y });
    indicator.classList.toggle('dock-insertion', Boolean(drop.insertion));
  });
  root.addEventListener('dragleave', event => {
    if (!root.contains(event.relatedTarget)) indicator.hidden = true;
  });
  root.addEventListener('drop', event => {
    if (!dock.drag) return;
    event.preventDefault();
    const drop = dockTarget(dock, event);
    if (drop && dockModel.moveGroup(dock.layout, dock.drag, drop.id, drop.placement,
      () => crypto.randomUUID(), drop.before)) applyDock(dock, true);
    finishDrag(dock);
  });
  root.addEventListener('click', event => {
    for (const menu of root.querySelectorAll('.dock-controls[open]')) {
      if (!menu.contains(event.target)) menu.open = false;
    }
  });
  dock.observer = new ResizeObserver(() => renderGeometry(dock));
  dock.observer.observe(root);
  return dock;
}

function configureDock(session) {
  const { view, chat, project } = session;
  const dock = project.dock ??= createProjectDock(chat, project);
  session.dock = dock;
  view.dockTabs = new Map();
  view.dockPanels = new Map([...view.root.querySelectorAll('[data-panel]')].map(panel => [panel.dataset.panel, panel]));
  if (!dockModel.leaves(dock.layout.tree).some(group => group.tabs.some(tab => dockModel.owner(tab) === session.id))) {
    dockModel.appendSession(dock.layout, session.record, dockModel.agentTabs, () => crypto.randomUUID());
  }
  for (const tab of view.root.querySelectorAll('[data-view]')) {
    const name = tab.dataset.view;
    const key = dockModel.key(session.id, name);
    const panel = view.dockPanels.get(name);
    view.dockTabs.set(name, tab);
    dock.entries.set(key, { session, name, tab, panel, label: tab.textContent });
    tab.dataset.dockKey = key;
    tab.draggable = true;
    tab.title = 'Drag to move this tab. Shift-drag to move its whole tab bar.';
    tab.addEventListener('click', () => {
      showView(session, name);
      if (name === 'terminal') showProjectShell(session, true);
      else if (name === 'chat') session.terminal.focus();
    });
    tab.addEventListener('dragstart', event => {
      event.stopPropagation();
      const toolbar = tab.closest('.dock-toolbar');
      if (event.shiftKey) beginDockDrag(dock, event, { pane: toolbar.closest('.dock-pane').dataset.pane }, toolbar);
      else beginDockDrag(dock, event, { tab: key }, tab);
    });
    tab.addEventListener('dragend', () => finishDrag(dock));
    panel.addEventListener('pointerdown', () => {
      if (chat === activeChat && chat.current !== session) showSession(chat, session, false);
    });
  }
  applyDock(dock);
}

function createDockPane(dock, id) {
  const element = document.createElement('section');
  element.className = 'dock-pane';
  element.dataset.pane = id;
  const toolbar = document.createElement('div');
  toolbar.className = 'dock-toolbar';
  toolbar.draggable = true;
  toolbar.title = 'Drag the tab bar to move all its tabs';
  toolbar.addEventListener('dragstart', event => {
    if (event.target === toolbar) beginDockDrag(dock, event, { pane: id }, toolbar);
  });
  toolbar.addEventListener('dragend', () => finishDrag(dock));
  const heading = document.createElement('div');
  heading.className = 'agent-pane-header';
  const title = document.createElement('h3');
  title.className = 'agent-pane-title';
  title.draggable = true;
  title.title = 'Drag this chat to move all of its tabs';
  title.addEventListener('dragstart', event => {
    event.stopPropagation();
    beginDockDrag(dock, event, { session: title.dataset.session }, element);
  });
  title.addEventListener('dragend', () => finishDrag(dock));
  const close = dockButton('×', () => {
    const entry = dock.entries.get(title.dataset.session + ':chat');
    if (entry) closeSideChat(entry.session);
  });
  close.className = 'agent-pane-close';
  heading.append(title, close);
  const nav = document.createElement('nav');
  nav.className = 'project-nav';
  nav.setAttribute('aria-label', 'Pane tabs');
  const body = document.createElement('div');
  body.className = 'project-body';
  const controls = document.createElement('details');
  controls.className = 'dock-controls';
  const summary = document.createElement('summary');
  summary.textContent = '⋯';
  summary.setAttribute('aria-label', 'Arrange pane');
  summary.title = 'Arrange pane';
  const menu = document.createElement('div');
  menu.className = 'dock-menu';
  controls.append(summary, menu);
  controls.addEventListener('toggle', () => {
    if (controls.open) {
      for (const other of dock.root.querySelectorAll('.dock-controls[open]')) {
        if (other !== controls) other.open = false;
      }
    }
    syncPreview();
  });
  toolbar.append(nav, controls);
  element.append(heading, toolbar, body);
  dock.root.append(element);
  return { element, heading, title, close, nav, body, menu, controls };
}

function arrangeChildren(parent, ordered) {
  let next = parent.firstElementChild;
  for (const element of ordered) {
    if (element === next) next = next.nextElementSibling;
    else if (element.isConnected && parent.isConnected && parent.moveBefore) parent.moveBefore(element, next);
    else parent.insertBefore(element, next);
  }
}

function renderMenu(dock, pane, group, groups) {
  const command = (label, action) => dockButton(label, () => {
    pane.controls.open = false;
    if (action()) applyDock(dock, true);
    syncPreview();
  });
  const directions = [['Split left', 'left'], ['Split right', 'right'], ['Split above', 'up'], ['Split below', 'down']];
  const buttons = directions.map(([label, edge]) => {
    const button = command(label, () => dockModel.dock(dock.layout, group.active, group.id, edge, () => crypto.randomUUID()));
    button.disabled = group.tabs.length < 2;
    return button;
  });
  for (const other of groups.filter(item => item !== group)) {
    const label = dock.entries.get(other.active).label;
    buttons.push(command('Move tab to ' + label,
      () => dockModel.dock(dock.layout, group.active, other.id, 'center', () => crypto.randomUUID())));
  }
  if (groups.length > 1) buttons.push(command('Merge with adjacent pane', () => dockModel.merge(dock.layout, group.id)));
  pane.menu.replaceChildren(...buttons);
}

function renderDock(dock) {
  dock.tree = dockModel.filterTree(dock.layout.tree, key => dock.entries.has(key));
  const groups = dock.tree ? dockModel.leaves(dock.tree) : [];
  const allSessions = new Set([...dock.entries.values()].map(entry => entry.session));
  const visible = new Map([...allSessions].map(session => [session, new Set()]));
  for (const group of groups) {
    const pane = dock.panes.get(group.id) ?? createDockPane(dock, group.id);
    dock.panes.set(group.id, pane);
    const active = dock.entries.get(group.active).session;
    pane.title.dataset.session = active.id;
    pane.title.textContent = active.record.name ?? names[active.agent] + ' · Main chat';
    pane.heading.hidden = allSessions.size < 2;
    pane.close.hidden = !active.extra;
    pane.close.title = pane.close.ariaLabel = 'Close ' + pane.title.textContent;
    const mixed = group.tabs.some(key => dock.entries.get(key).session !== active);
    arrangeChildren(pane.nav, group.tabs.map(key => dock.entries.get(key).tab));
    arrangeChildren(pane.body, group.tabs.map(key => dock.entries.get(key).panel));
    for (const key of group.tabs) {
      const { session, name, tab, panel, label } = dock.entries.get(key);
      const selected = key === group.active;
      tab.textContent = mixed ? (session.record.name ?? 'Main') + ' · ' + label : label;
      tab.setAttribute('aria-pressed', String(selected));
      if (name === 'terminal') {
        panel.classList.toggle('terminal-background', !selected);
        panel.inert = !selected;
      } else panel.hidden = !selected;
      if (selected) {
        visible.get(session).add(name);
        if (group.id === dock.layout.focus) session.view.selected = name;
      }
    }
    renderMenu(dock, pane, group, groups);
  }
  for (const [id, pane] of dock.panes) {
    if (groups.some(group => group.id === id)) continue;
    pane.element.remove();
    dock.panes.delete(id);
  }
  renderGeometry(dock);
  for (const [session, views] of visible) activateDock(session, views);
}

function position(element, bounds) {
  element.style.left = bounds.x + 'px';
  element.style.top = bounds.y + 'px';
  element.style.width = Math.max(0, bounds.width) + 'px';
  element.style.height = Math.max(0, bounds.height) + 'px';
}

function renderGeometry(dock) {
  const bounds = dock.root.getBoundingClientRect();
  if (!bounds.width || !bounds.height) return;
  const seen = new Set();
  const place = (node, box) => {
    if (node.tabs) {
      position(dock.panes.get(node.id).element, box);
      return;
    }
    seen.add(node.id);
    const row = node.axis === 'row';
    const span = row ? box.width : box.height;
    const gap = Math.min(span, 8);
    const usable = span - gap;
    const minimum = Math.min(row ? 84 : 66, usable / 2.5);
    const cut = Math.min(usable - minimum, Math.max(minimum, Math.round(usable * node.ratio)));
    let handle = dock.dividers.get(node.id);
    if (!handle) {
      handle = createDivider(dock, node.id);
      dock.dividers.set(node.id, handle);
    }
    handle.branch = findDockNode(dock.layout.tree, node.id);
    handle.rendered = node;
    handle.bounds = box;
    handle.usable = usable;
    handle.element.dataset.axis = node.axis;
    handle.element.setAttribute('aria-orientation', row ? 'vertical' : 'horizontal');
    handle.element.setAttribute('aria-valuenow', String(usable ? Math.round(cut / usable * 100) : 50));
    if (row) {
      place(node.first, { ...box, width: cut });
      position(handle.element, { x: box.x + cut, y: box.y, width: gap, height: box.height });
      place(node.second, { ...box, x: box.x + cut + gap, width: usable - cut });
    } else {
      place(node.first, { ...box, height: cut });
      position(handle.element, { x: box.x, y: box.y + cut, width: box.width, height: gap });
      place(node.second, { ...box, y: box.y + cut + gap, height: usable - cut });
    }
  };
  if (dock.tree) place(dock.tree, { x: 0, y: 0, width: bounds.width, height: bounds.height });
  for (const [id, handle] of dock.dividers) {
    if (seen.has(id)) continue;
    handle.element.remove();
    dock.dividers.delete(id);
  }
}

function createDivider(dock, id) {
  const element = document.createElement('div');
  element.className = 'dock-divider';
  element.dataset.divider = id;
  element.tabIndex = 0;
  element.setAttribute('role', 'separator');
  element.setAttribute('aria-label', 'Resize adjacent panes');
  element.setAttribute('aria-valuemin', '0');
  element.setAttribute('aria-valuemax', '100');
  const handle = { element };
  const resize = ratio => {
    handle.rendered.ratio = handle.branch.ratio = dockModel.clamp(ratio);
    renderGeometry(dock);
  };
  element.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !event.isPrimary) return;
    event.preventDefault();
    event.stopPropagation();
    element.setPointerCapture(event.pointerId);
    dock.resizing = true;
    setDockBusy(dock, true);
  });
  element.addEventListener('pointermove', event => {
    if (!element.hasPointerCapture(event.pointerId) || !handle.usable) return;
    const root = dock.root.getBoundingClientRect();
    const offset = handle.branch.axis === 'row'
      ? event.clientX - root.x - handle.bounds.x : event.clientY - root.y - handle.bounds.y;
    resize(offset / handle.usable);
  });
  element.addEventListener('lostpointercapture', () => {
    dock.resizing = false;
    setDockBusy(dock, false);
    saveDock(dock);
  });
  element.addEventListener('keydown', event => {
    const keys = handle.branch.axis === 'row' ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown'];
    const index = keys.indexOf(event.key);
    if (index < 0) return;
    event.preventDefault();
    const current = Number(element.getAttribute('aria-valuenow')) / 100;
    resize(current + (index === 0 ? -.05 : .05));
    saveDock(dock);
  });
  dock.root.append(element);
  return handle;
}


function dockTarget(dock, event) {
  if (!dock.tree) return;
  const bounds = dock.root.getBoundingClientRect();
  const xEdge = event.clientX - bounds.left;
  const yEdge = event.clientY - bounds.top;
  const region = { width: bounds.width, height: bounds.height, x: bounds.left, y: bounds.top };
  if (xEdge < 11) return { ...region, placement: 'left', width: region.width / 2 };
  if (xEdge > bounds.width - 11) return { ...region, placement: 'right', x: region.x + region.width / 2, width: region.width / 2 };
  if (yEdge < 11 && !event.target.closest('.dock-toolbar')) return { ...region, placement: 'up', height: region.height / 2 };
  if (yEdge > bounds.height - 11) return { ...region, placement: 'down', y: region.y + region.height / 2, height: region.height / 2 };
  const pane = event.target.closest('.dock-pane');
  if (!pane || !dock.root.contains(pane)) return;
  const id = pane.dataset.pane;
  if (dock.drag.pane === id) return;
  const group = dockModel.leaves(dock.tree).find(item => item.id === id);
  if (dock.drag.session && group.tabs.every(key => dockModel.owner(key) === dock.drag.session)) return;
  const nav = pane.querySelector('.project-nav');
  const tab = event.target.closest('[data-view]');
  if (tab) {
    const box = tab.getBoundingClientRect();
    const after = event.clientX > box.left + box.width / 2;
    const before = after ? group.tabs[group.tabs.indexOf(tab.dataset.dockKey) + 1] : tab.dataset.dockKey;
    return { id, placement: 'center', before, x: after ? box.right : box.left, y: box.top,
      width: 3, height: box.height, insertion: true };
  }
  if (event.target.closest('.dock-toolbar')) {
    const bar = nav.getBoundingClientRect();
    return { id, placement: 'center', x: bar.right - 4, y: bar.top, width: 3, height: bar.height, insertion: true };
  }
  const box = pane.querySelector('.project-body').getBoundingClientRect();
  if (!box.width || !box.height) return;
  const target = { id, placement: 'center', x: box.x + 3, y: box.y + 3, width: box.width - 6, height: box.height - 6 };
  const x = (event.clientX - box.x) / box.width;
  const y = (event.clientY - box.y) / box.height;
  if (group.tabs.length === 1 && group.tabs.includes(dock.drag.tab)) return target;
  if (x < .28 && x <= y && x <= 1 - y) return { ...target, placement: 'left', width: target.width / 2 };
  if (x > .72 && 1 - x <= y && 1 - x <= 1 - y) return { ...target, placement: 'right', x: target.x + target.width / 2, width: target.width / 2 };
  if (y < .28) return { ...target, placement: 'up', height: target.height / 2 };
  if (y > .72) return { ...target, placement: 'down', y: target.y + target.height / 2, height: target.height / 2 };
  return target;
}


function saveDock(dock) {
  window.desk.saveProjectDock(dock.chat.id, dock.project.id, dock.layout).catch(setError);
}

function applyDock(dock, persist = false) {
  renderDock(dock);
  if (persist) saveDock(dock);
  syncPreview();
}

function removeDockSession(session) {
  const dock = session.dock;
  for (const name of session.view.dockTabs.keys()) {
    dock.entries.delete(dockModel.key(session.id, name));
    session.view.dockTabs.get(name).remove();
    session.view.dockPanels.get(name).remove();
  }
  applyDock(dock);
}

function activateDock(session, visible) {
  const { view } = session;
  view.visibleViews = visible;
  if (!view.dockReady) return;
  const previous = view.activatedViews ?? new Set();
  view.activatedViews = visible;
  if (visible.has('files') && !view.filesLoaded && !previous.has('files')) loadFiles(session);
  if (visible.has('changes') && !previous.has('changes')) loadChanges(session);
  if (visible.has('git') && !previous.has('git')) refreshGit(session);
  if (visible.has('terminal') && !previous.has('terminal')) showProjectShell(session);
  if (visible.has('chat') || visible.has('workflow')) refreshHistory(session);
}

function showView(session, name) {
  const dock = session.dock;
  const key = dockModel.key(session.id, name);
  const group = dockModel.leaves(dock.layout.tree).find(pane => pane.tabs.includes(key));
  if (!group) return;
  dock.layout.focus = group.id;
  group.active = key;
  const previous = session.chat.current;
  if (previous !== session) showSession(session.chat, session, false);
  applyDock(dock, true);
}

function beginDockDrag(dock, event, drag, image) {
  if (dock.resizing) {
    event.preventDefault();
    return;
  }
  dock.drag = drag;
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', drag.tab ?? drag.pane ?? drag.session);
  liftDragItem(event, image);
  dock.root.classList.add('docking');
  setDockBusy(dock, true);
}

function finishDrag(dock) {
  dock.drag = undefined;
  dock.root.classList.remove('docking');
  dock.indicator.hidden = true;
  setDockBusy(dock, false);
}
