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
const commandChoice = settingsInput('command');
const commandFilter = settingsInput('command-filter');
const shortcutStatus = settingsInput('shortcut-status');
const recordShortcut = settingsInput('record');
const recordChord = settingsInput('record-chord');

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

function commandLabel(command) {
  return command === 'perona.save' ? 'Save file' : command;
}

function updateShortcutStatus() {
  const command = commandChoice.value;
  const available = shortcutCatalog.has(command);
  for (const id of ['record', 'record-chord', 'unbind', 'reset-key']) settingsInput(id).disabled = !available;
  if (!available) {
    shortcutStatus.textContent = 'No matching commands.';
    return;
  }
  const defaults = [...new Set(shortcutCatalog.get(command).map(binding => binding.label))].join(', ');
  const changed = Object.hasOwn(shortcutDraft, command);
  shortcutStatus.textContent = changed
    ? 'Current: ' + (shortcutDraft[command] ? shortcutLabel(shortcutDraft[command]) : 'Disabled') + ' · Default: ' + defaults
    : 'Default: ' + defaults;
}

function listShortcutCommands() {
  const current = commandChoice.value;
  const search = commandFilter.value.trim().toLowerCase();
  const commands = [...shortcutCatalog.keys()].sort((a, b) => commandLabel(a).localeCompare(commandLabel(b)))
    .filter(command => commandLabel(command).toLowerCase().includes(search));
  commandChoice.replaceChildren(...commands.map(command => new Option(commandLabel(command), command)));
  if (commands.includes(current)) commandChoice.value = current;
  updateShortcutStatus();
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
  commandFilter.value = '';
  listShortcutCommands();
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

settingsInput('keybindings').addEventListener('toggle', async event => {
  if (!event.currentTarget.open || shortcutRecorder) return;
  shortcutStatus.textContent = 'Loading editor commands…';
  try {
    await monacoReady();
    listShortcutCommands();
  } catch (error) { shortcutStatus.textContent = readableError(error); }
});
commandFilter.addEventListener('input', listShortcutCommands);
commandChoice.addEventListener('change', updateShortcutStatus);
for (const [id, disable] of [['unbind', true], ['reset-key', false]]) {
  settingsInput(id).addEventListener('click', () => {
    if (disable) shortcutDraft[commandChoice.value] = null;
    else delete shortcutDraft[commandChoice.value];
    updateShortcutStatus();
  });
}
function captureShortcut(event) {
  if (!recording) return;
  if (event.key === 'Tab') return;
  event.preventDefault();
  event.stopPropagation();
  if (event.key === 'Escape') {
    recording = undefined;
    updateShortcutStatus();
    return;
  }
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(event.key)) return;
  const chord = new shortcutRecorder(event).toKeyCodeChord();
  if (!chord.keyCode || (!recording.first && event.key.length === 1 && !chord.ctrlKey && !chord.altKey && !chord.metaKey)) {
    shortcutStatus.textContent = 'Use a modifier with a printable key, or press a function key.';
    return;
  }
  const key = encodeEditorChord(chord);
  if (recording.twoKeys && !recording.first) {
    recording.first = key;
    shortcutStatus.textContent = shortcutLabel(key) + ' … Press the second shortcut.';
    return;
  }
  shortcutDraft[commandChoice.value] = recording.first ? monaco.KeyMod.chord(recording.first, key) : key;
  recording = undefined;
  updateShortcutStatus();
}

for (const button of [recordShortcut, recordChord]) {
  button.addEventListener('click', () => {
    recording = { twoKeys: button === recordChord };
    button.focus();
    shortcutStatus.textContent = 'Press the shortcut you want to use. Press Escape to cancel.';
  });
  button.addEventListener('blur', () => {
    if (recording) {
      recording = undefined;
      updateShortcutStatus();
    }
  });
  button.addEventListener('keydown', captureShortcut);
}

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
