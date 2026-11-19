(() => {
  const tabs = ['chat', 'workflow', 'files', 'changes', 'git', 'preview', 'terminal'];
  const agentTabs = ['chat', 'workflow', 'terminal'];
  const clamp = ratio => Math.min(.94, Math.max(.06, ratio));
  const pane = (id, names, active = names[0]) => ({ id, tabs: names, active });
  const split = (id, axis, first, second, ratio = .5) => ({ id, axis, ratio, first, second });

  function leaves(root) {
    return root.tabs ? [root] : [...leaves(root.first), ...leaves(root.second)];
  }

  function fresh(active, allowed = tabs) {
    return { tree: pane('pane-0', [...allowed], allowed.includes(active) ? active : 'chat'), focus: 'pane-0' };
  }

  function normalize(value, allowed = tabs) {
    if (Array.isArray(value?.groups)) {
      const groups = value.groups;
      if (groups.length < 1 || groups.length > 2 || groups.some(group => !Array.isArray(group?.tabs))) return;
      const first = pane('pane-0', groups[0].tabs, groups[0].active);
      const tree = groups.length === 1 ? first
        : split('split-0', value.axis === 'down' ? 'column' : 'row', first,
          pane('pane-1', groups[1].tabs, groups[1].active), value.ratio);
      value = { tree, focus: 'pane-' + value.focus };
    }
    const ids = new Set();
    const assigned = new Set();
    function parse(record, depth = 0) {
      if (!record || depth >= allowed.length || typeof record.id !== 'string'
          || !/^[a-z0-9-]{1,64}$/i.test(record.id) || ids.has(record.id)) return;
      ids.add(record.id);
      if (Array.isArray(record.tabs)) {
        if (!record.tabs.length || !record.tabs.includes(record.active)) return;
        for (const name of record.tabs) {
          if (!allowed.includes(name) || assigned.has(name)) return;
          assigned.add(name);
        }
        return pane(record.id, [...record.tabs], record.active);
      }
      if (!['row', 'column'].includes(record.axis) || !Number.isFinite(record.ratio)) return;
      const first = parse(record.first, depth + 1);
      const second = parse(record.second, depth + 1);
      if (first && second) return split(record.id, record.axis, first, second, clamp(record.ratio));
    }
    const tree = parse(value?.tree);
    if (!tree || allowed.some(name => name !== 'git' && !assigned.has(name))) return;
    const panes = leaves(tree);
    if (allowed.includes('git') && !assigned.has('git')) {
      const changes = panes.find(item => item.tabs.includes('changes'));
      changes.tabs.splice(changes.tabs.indexOf('changes') + 1, 0, 'git');
    }
    return { tree, focus: panes.some(item => item.id === value.focus) ? value.focus : panes[0].id };
  }

  function replace(root, target, replacement) {
    if (root === target) return replacement;
    if (!root.tabs) {
      root.first = replace(root.first, target, replacement);
      root.second = replace(root.second, target, replacement);
      return root.first && root.second ? root : root.first || root.second;
    }
    return root;
  }

  function take(layout, origin, name) {
    origin.tabs.splice(origin.tabs.indexOf(name), 1);
    if (!origin.tabs.length) layout.tree = replace(layout.tree, origin, null);
    else if (origin.active === name) origin.active = origin.tabs[0];
  }

  function dock(layout, name, targetId, placement, id, before) {
    const list = leaves(layout.tree);
    const origin = list.find(item => item.tabs.includes(name));
    const target = list.find(item => item.id === targetId);
    if (!origin || !target) return false;
    if (placement === 'center') {
      if (name === before) return false;
      if (origin === target) origin.tabs.splice(origin.tabs.indexOf(name), 1);
      else take(layout, origin, name);
      const index = target.tabs.indexOf(before);
      target.tabs.splice(index < 0 ? target.tabs.length : index, 0, name);
      target.active = name;
      layout.focus = target.id;
      return true;
    }
    if (!['left', 'right', 'up', 'down'].includes(placement)
        || origin === target && target.tabs.length === 1) return false;
    take(layout, origin, name);
    const newPane = pane(id(), [name]);
    const leading = placement === 'left' || placement === 'up';
    const axis = ['left', 'right'].includes(placement) ? 'row' : 'column';
    layout.tree = replace(layout.tree, target,
      split(id(), axis, leading ? newPane : target, leading ? target : newPane));
    layout.focus = newPane.id;
    return true;
  }

  function movePane(layout, originId, targetId, placement, id, before) {
    const panes = leaves(layout.tree);
    const origin = panes.find(item => item.id === originId);
    const target = panes.find(item => item.id === targetId);
    if (!origin || !target || origin === target) return false;
    if (!['center', 'left', 'right', 'up', 'down'].includes(placement)) return false;
    layout.tree = replace(layout.tree, origin, null);
    if (placement === 'center') {
      const index = target.tabs.indexOf(before);
      target.tabs.splice(index < 0 ? target.tabs.length : index, 0, ...origin.tabs);
      target.active = origin.active;
      layout.focus = target.id;
    } else {
      const leading = placement === 'left' || placement === 'up';
      const axis = ['left', 'right'].includes(placement) ? 'row' : 'column';
      layout.tree = replace(layout.tree, target,
        split(id(), axis, leading ? origin : target, leading ? target : origin));
      layout.focus = origin.id;
    }
    return true;
  }

  const key = (id, tab) => id + ':' + tab;
  const owner = tab => tab.split(':', 1)[0];
  const projectTabs = project => [
    ...tabs.map(tab => key(project.id, tab)),
    ...(project.agents ?? []).flatMap(agent => agentTabs.map(tab => key(agent.id, tab)))
  ];

  function appendSession(layout, record, allowed, id) {
    const local = normalize(record.layout, allowed) ?? fresh(record.view, allowed);
    const qualify = node => node.tabs
      ? pane(id(), node.tabs.map(tab => key(record.id, tab)), key(record.id, node.active))
      : split(id(), node.axis, qualify(node.first), qualify(node.second), node.ratio);
    const tree = qualify(local.tree);
    if (layout.tree) {
      layout.tree = split(id(), 'row', layout.tree, tree, .6);
    } else {
      layout.tree = tree;
      layout.focus = leaves(tree)[0].id;
    }
  }

  function projectLayout(project, id) {
    const saved = normalize(project.dockLayout, projectTabs(project));
    if (saved) return saved;
    const layout = {};
    appendSession(layout, project, tabs, id);
    for (const agent of project.agents ?? []) appendSession(layout, agent, agentTabs, id);
    return layout;
  }

  function filterTree(node, keep, rename = id => id) {
    if (node.tabs) {
      const names = node.tabs.filter(keep);
      return names.length ? pane(rename(node.id), names, names.includes(node.active) ? node.active : names[0]) : null;
    }
    const first = filterTree(node.first, keep, rename);
    const second = filterTree(node.second, keep, rename);
    return first && second ? split(rename(node.id), node.axis, first, second, node.ratio) : first || second;
  }

  function removeSession(layout, sessionId) {
    layout.tree = filterTree(layout.tree, tab => owner(tab) !== sessionId);
    if (!leaves(layout.tree).some(item => item.id === layout.focus)) layout.focus = leaves(layout.tree)[0].id;
  }

  function moveGroup(layout, drag, targetId, placement, id, before) {
    const panes = leaves(layout.tree);
    if (drag.pane && drag.pane === targetId) return false;
    const origin = panes.find(item => item.id === drag.pane);
    const keep = tab => drag.session ? owner(tab) === drag.session
      : drag.tab ? tab === drag.tab : Boolean(origin?.tabs.includes(tab));
    if (!panes.some(item => item.tabs.some(keep))) return false;
    if (drag.tab && targetId) return dock(layout, drag.tab, targetId, placement, id, before);
    if (drag.pane && targetId) return movePane(layout, drag.pane, targetId, placement, id, before);
    const target = panes.find(item => item.id === targetId);
    if (targetId && (!target || target.tabs.every(keep))) return false;
    const remaining = filterTree(layout.tree, tab => !keep(tab));
    if (!remaining) return false;
    const moved = filterTree(layout.tree, keep, id);
    if (placement === 'center') {
      if (!target) return false;
      const destination = leaves(remaining).find(item => item.id === targetId);
      const at = destination.tabs.indexOf(before);
      destination.tabs.splice(at < 0 ? destination.tabs.length : at, 0, ...leaves(moved).flatMap(item => item.tabs));
      destination.active = leaves(moved)[0].active;
      layout.tree = remaining;
      layout.focus = destination.id;
    } else {
      const leading = placement === 'left' || placement === 'up';
      const axis = ['left', 'right'].includes(placement) ? 'row' : 'column';
      const anchor = target ? leaves(remaining).find(item => item.id === targetId) : remaining;
      layout.tree = replace(remaining, anchor,
        split(id(), axis, leading ? moved : anchor, leading ? anchor : moved));
      layout.focus = leaves(moved)[0].id;
    }
    return true;
  }

  function neighbor(root, target) {
    if (root.tabs) return;
    if (root.first === target) return leaves(root.second)[0];
    if (root.second === target) return leaves(root.first).at(-1);
    return neighbor(root.first, target) || neighbor(root.second, target);
  }

  function merge(layout, id) {
    const pane = leaves(layout.tree).find(value => value.id === id);
    const destination = pane && neighbor(layout.tree, pane);
    if (!destination) return false;
    destination.tabs.push(...pane.tabs);
    destination.active = pane.active;
    layout.tree = replace(layout.tree, pane, null);
    layout.focus = destination.id;
    return true;
  }

  const model = { tabs, agentTabs, clamp, leaves, fresh, normalize, dock, merge,
    key, owner, projectTabs, projectLayout, appendSession, filterTree, removeSession, moveGroup };
  if (typeof module === 'object' && module.exports) module.exports = model;
  else globalThis.dockModel = model;
})();
