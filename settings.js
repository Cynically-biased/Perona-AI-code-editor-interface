const appPreferences = {
  editorFont: 13, tabWidth: 4, wrap: false, minimap: false,
  startup: 'resume', agent: 'codex', folder: '', updates: 'download', zoom: 100, shortcuts: {}
};
try {
  Object.assign(appPreferences, JSON.parse(localStorage.getItem('perona-settings')) ?? {});
} catch {
  // Use the defaults if saved preferences cannot be read.
}

function editorDisplayOptions() {
  return { fontSize: appPreferences.editorFont, wordWrap: appPreferences.wrap ? 'on' : 'off',
    minimap: { enabled: appPreferences.minimap }, detectIndentation: false, tabSize: appPreferences.tabWidth };
}

const settingsDialog = document.getElementById('settings-dialog');
const settingsInput = name => document.getElementById('settings-' + name);
const shortcutCatalog = new Map();
let shortcutOverrides;
let shortcutRecorder;
let shortcutDraft = {};
let recording;
const shortcutStatus = settingsInput('shortcut-status');
const shortcutList = settingsInput('shortcut-list');
const settingsCategories = [...settingsDialog.querySelectorAll('[data-settings-category]')];
const settingsPanels = [...settingsDialog.querySelectorAll('[data-settings-panel]')];
const editorShortcutRows = [
  ['perona.save', 'Save file', 'Write your changes to the project file.'],
  ['undo', 'Undo', 'Reverse the last edit.'],
  ['redo', 'Redo', 'Restore an edit you undid.'],
  ['actions.find', 'Find', 'Search the current file.'],
  ['editor.action.startFindReplaceAction', 'Find and replace', 'Find text and replace it in the current file.'],
  ['editor.action.commentLine', 'Toggle line comment', 'Comment or uncomment the selected lines.'],
  ['editor.action.formatDocument', 'Format document', 'Format the file when its language supports formatting.']
];

function showSettingsCategory(category) {
  for (const button of settingsCategories) {
    button.setAttribute('aria-pressed', String(button.dataset.settingsCategory === category));
  }
  for (const panel of settingsPanels) panel.hidden = panel.dataset.settingsPanel !== category;
  settingsDialog.querySelector('.settings-content').scrollTop = 0;
}

function encodeEditorChord(chord) {
  return chord.keyCode | (chord.ctrlKey ? monaco.KeyMod.CtrlCmd : 0) |
    (chord.shiftKey ? monaco.KeyMod.Shift : 0) | (chord.altKey ? monaco.KeyMod.Alt : 0) |
    (chord.metaKey ? monaco.KeyMod.WinCtrl : 0);
}

function shortcutLabel(value) {
  if (value > 65535) return shortcutLabel(value & 65535) + ' ' + shortcutLabel(value >>> 16);
  const key = (monaco.KeyCode[value & 255] ?? '').replace(/^Key|^Digit/, '');
  return [value & monaco.KeyMod.CtrlCmd && 'Ctrl', value & monaco.KeyMod.Shift && 'Shift',
    value & monaco.KeyMod.Alt && 'Alt', value & monaco.KeyMod.WinCtrl && 'Win', key].filter(Boolean).join('+');
}

function initializeEditorShortcuts(registry, KeyboardEvent) {
  if (shortcutRecorder) return;
  for (const rule of registry.getDefaultKeybindings()) {
    if (!rule.command || !rule.keybinding || rule.command.startsWith('-')) continue;
    const bindings = shortcutCatalog.get(rule.command) ?? [];
    bindings.push({
      label: rule.keybinding.chords.map(chord => shortcutLabel(encodeEditorChord(chord))).join(' '),
      when: rule.when?.serialize(), commandArgs: rule.commandArgs
    });
    shortcutCatalog.set(rule.command, bindings);
  }
  shortcutCatalog.set('perona.save', [{ label: 'Ctrl+S', when: 'editorTextFocus' }]);
  monaco.editor.registerCommand('perona.save', () => {
    const session = [...sessions.values()].find(item => item.view.editor?.hasTextFocus());
    if (session) return saveEditor(session);
  });
  shortcutRecorder = KeyboardEvent;
  applyEditorShortcuts();
}

function applyEditorShortcuts() {
  if (!shortcutRecorder) return;
  shortcutOverrides?.dispose();
  const rules = [];
  for (const [command, defaults] of shortcutCatalog) {
    const changed = Object.hasOwn(appPreferences.shortcuts, command);
    if (command !== 'perona.save' && !changed) continue;
    if (command !== 'perona.save') rules.push({ command: '-' + command, keybinding: 0 });
    const keybinding = changed ? appPreferences.shortcuts[command] : monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS;
    if (Number.isInteger(keybinding) && keybinding > 0 && keybinding <= 0x0fff0fff) {
      for (const binding of defaults) rules.push({ command, keybinding, when: binding.when, commandArgs: binding.commandArgs });
    }
  }
  shortcutOverrides = monaco.editor.addKeybindingRules(rules);
}

function currentShortcut(command) {
  if (Object.hasOwn(shortcutDraft, command)) {
    return shortcutDraft[command] ? shortcutLabel(shortcutDraft[command]) : 'Disabled';
  }
  return [...new Set(shortcutCatalog.get(command)?.map(binding => binding.label))].join(' / ');
}

function renderShortcutRows() {
  shortcutList.replaceChildren();
  for (const [command, label, description] of editorShortcutRows) {
    if (!shortcutCatalog.has(command)) continue;
    const row = node('div', '', 'settings-row settings-shortcut-row');
    const detail = node('span', label);
    detail.append(node('small', description));
    const actions = node('div', '', 'settings-shortcut-controls');
    const record = node('button', currentShortcut(command), 'settings-key');
    record.type = 'button';
    const reset = node('button', 'Reset', 'settings-key-reset');
    reset.type = 'button';
    reset.setAttribute('aria-label', 'Reset shortcut for ' + label);
    const update = () => {
      record.textContent = currentShortcut(command);
      record.setAttribute('aria-label', label + ': ' + record.textContent + '. Change shortcut');
      reset.disabled = !Object.hasOwn(shortcutDraft, command);
    };
    record.addEventListener('click', () => {
      recording = record;
      record.textContent = 'Press keys…';
      shortcutStatus.textContent = 'Recording ' + label + '. Press Escape to cancel.';
    });
    record.addEventListener('blur', () => {
      if (recording !== record) return;
      recording = undefined;
      shortcutStatus.textContent = '';
      update();
    });
    record.addEventListener('keydown', event => {
      if (recording !== record || event.key === 'Tab') return;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Escape') {
        recording = undefined;
        shortcutStatus.textContent = '';
        update();
        return;
      }
      if (['Control', 'Shift', 'Alt', 'Meta'].includes(event.key) || event.repeat || event.isComposing) return;
      const chord = new shortcutRecorder(event).toKeyCodeChord();
      if (!chord.keyCode || (!chord.ctrlKey && !chord.altKey && !chord.metaKey && !/^F\d+$/.test(event.key))) {
        shortcutStatus.textContent = 'Use Ctrl, Alt, or Win with another key, or press a function key.';
        return;
      }
      const key = encodeEditorChord(chord);
      const conflict = editorShortcutRows.find(([other]) => other !== command
        && currentShortcut(other).split(' / ').includes(shortcutLabel(key)));
      if (conflict) {
        shortcutStatus.textContent = 'That shortcut is already used by ' + conflict[1] + '.';
        return;
      }
      shortcutDraft[command] = key;
      recording = undefined;
      shortcutStatus.textContent = label + ' set to ' + shortcutLabel(key) + '.';
      update();
    });
    reset.addEventListener('click', () => {
      delete shortcutDraft[command];
      update();
      record.focus();
      shortcutStatus.textContent = label + ' restored to its default.';
    });
    update();
    actions.append(record, reset);
    row.append(detail, actions);
    shortcutList.append(row);
  }
}

function applySettingsDisplay() {
  document.getElementById('perona-pet').hidden = localStorage.getItem('perona-hide-pet') === 'true';
  document.querySelector('.agent-usage').hidden = localStorage.getItem('perona-hide-usage') === 'true';
  window.desk.setInterfaceZoom(appPreferences.zoom).catch(setError);
}

document.getElementById('open-settings').addEventListener('click', () => {
  settingsInput('terminal-font').value = terminalFontSize();
  settingsInput('pet-visible').checked = localStorage.getItem('perona-hide-pet') !== 'true';
  settingsInput('pet-roam').checked = localStorage.getItem('perona-stay-here') !== 'true';
  settingsInput('usage-visible').checked = localStorage.getItem('perona-hide-usage') !== 'true';
  for (const [id, key] of Object.entries({
    'editor-font': 'editorFont', 'editor-tabs': 'tabWidth', startup: 'startup', agent: 'agent',
    folder: 'folder', updates: 'updates', zoom: 'zoom'
  })) settingsInput(id).value = appPreferences[key];
  settingsInput('editor-wrap').checked = appPreferences.wrap;
  settingsInput('editor-minimap').checked = appPreferences.minimap;
  shortcutDraft = { ...appPreferences.shortcuts };
  showSettingsCategory('appearance');
  settingsDialog.returnValue = '';
  settingsDialog.showModal();
  syncPreview();
});

settingsInput('pick-folder').addEventListener('click', async () => {
  try {
    const folder = await window.desk.pickSettingsFolder(settingsInput('folder').value);
    if (folder && settingsDialog.open) settingsInput('folder').value = folder;
  } catch (error) { setError(error); }
});
settingsInput('clear-folder').addEventListener('click', () => { settingsInput('folder').value = ''; });

for (const button of settingsCategories) {
  button.addEventListener('click', async () => {
    const category = button.dataset.settingsCategory;
    showSettingsCategory(category);
    if (category !== 'keybindings') return;
    shortcutStatus.textContent = shortcutRecorder ? '' : 'Loading shortcuts…';
    try {
      await monacoReady();
      if (!settingsDialog.open) return;
      shortcutStatus.textContent = '';
      renderShortcutRows();
    } catch (error) { shortcutStatus.textContent = readableError(error); }
  });
}

for (const button of settingsDialog.querySelectorAll('.settings-cancel, .settings-close')) {
  button.addEventListener('click', () => settingsDialog.close('cancel'));
}

settingsDialog.addEventListener('invalid', event => {
  if (event.target !== settingsDialog.querySelector('form').querySelector(':invalid')) return;
  const panel = event.target.closest('[data-settings-panel]');
  if (panel?.hidden) showSettingsCategory(panel.dataset.settingsPanel);
}, true);

const zoomLevels = [...settingsInput('zoom').options].map(option => Number(option.value));
window.desk.onInterfaceZoomStep(direction => {
  if (recording) {
    shortcutStatus.textContent = 'Ctrl+− and Ctrl++ are reserved for interface zoom.';
    return;
  }
  const index = zoomLevels.indexOf(zoomLevels.includes(appPreferences.zoom) ? appPreferences.zoom : 100);
  const zoom = zoomLevels[Math.max(0, Math.min(zoomLevels.length - 1, index + direction))];
  if (zoom === appPreferences.zoom) return;
  appPreferences.zoom = zoom;
  settingsInput('zoom').value = zoom;
  localStorage.setItem('perona-settings', JSON.stringify(appPreferences));
  window.desk.setInterfaceZoom(zoom).catch(setError);
});

settingsDialog.addEventListener('close', () => {
  recording = undefined;
  if (settingsDialog.returnValue !== 'save') return;
  const previousSize = terminalFontSize();
  const previousRoam = localStorage.getItem('perona-stay-here') === 'true';
  const roam = settingsInput('pet-roam').checked;
  localStorage.setItem('perona-terminal-font', settingsInput('terminal-font').value);
  localStorage.setItem('perona-hide-pet', String(!settingsInput('pet-visible').checked));
  localStorage.setItem('perona-stay-here', String(!roam));
  localStorage.setItem('perona-hide-usage', String(!settingsInput('usage-visible').checked));
  Object.assign(appPreferences, {
    editorFont: settingsInput('editor-font').valueAsNumber,
    tabWidth: settingsInput('editor-tabs').valueAsNumber,
    wrap: settingsInput('editor-wrap').checked,
    minimap: settingsInput('editor-minimap').checked,
    startup: settingsInput('startup').value,
    agent: settingsInput('agent').value,
    folder: settingsInput('folder').value,
    updates: settingsInput('updates').value,
    zoom: Number(settingsInput('zoom').value),
    shortcuts: shortcutDraft
  });
  localStorage.setItem('perona-settings', JSON.stringify(appPreferences));
  applySettingsDisplay();
  applyEditorShortcuts();
  if (previousRoam !== !roam) document.dispatchEvent(new Event('perona-roaming-change'));
  const size = terminalFontSize();
  for (const session of sessions.values()) {
    session.view.editor?.updateOptions(editorDisplayOptions());
    for (const file of session.view.files?.values() ?? []) {
      file.model?.updateOptions({ tabSize: appPreferences.tabWidth, indentSize: 'tabSize' });
    }
    if (size === previousSize) continue;
    updateTerminalFont(session.terminal, session.body, session.fit, size);
    session.updateHistoryFont(size);
    const { shell } = session;
    if (shell) updateTerminalFont(shell.terminal, shell.body, shell.fit, size);
  }
});
