let editorReady;
const fileDialog = document.querySelector('#file-action-dialog');
const filePathInput = document.querySelector('#file-action-path');
let fileAction;

function monacoReady() {
  if (!editorReady) {
    editorReady = new Promise((resolve, reject) => {
      window.MonacoEnvironment = {
        getWorkerUrl: () => new URL('./monaco-worker.js', location.href).href
      };
      window.require.config({ paths: { vs: './node_modules/monaco-editor/min/vs' } });
      window.require(['vs/editor/editor.main'], () => {
        monaco.editor.defineTheme('perona', {
          base: 'vs-dark', inherit: true, rules: [], colors: {
            'editor.background': '#1b121a', 'editorLineNumber.foreground': '#a68f9e',
            'editorLineNumber.activeForeground': '#ffb1d1', 'editor.selectionBackground': '#704362',
            'editorCursor.foreground': '#ff9fc7', 'editorGutter.background': '#1b121a'
          }
        });
        window.require(['vs/platform/keybinding/common/keybindingsRegistry', 'vs/base/browser/keyboardEvent'],
          (registry, keyboard) => {
            try {
              initializeEditorShortcuts(registry.KeybindingsRegistry, keyboard.StandardKeyboardEvent);
              resolve();
            } catch (error) { reject(error); }
          }, reject);
      }, reject);
    }).catch(error => {
      editorReady = undefined;
      throw error;
    });
  }
  return editorReady;
}

function configureEditor(session) {
  const { view } = session;
  const root = view.filesPanel = view.root.querySelector('[data-panel="files"]');
  const projectRoot = root.querySelector('.file-location');
  projectRoot.title = 'Drop files here to place them in the project root';
  configureFileDrop(session, projectRoot, () => '');
  const list = root.querySelector('.file-list');
  configureExternalDrop(root, files => importDroppedFiles(session, '', files));
  const filesTab = view.root.querySelector('[data-view="files"]');
  configureExternalDrop(filesTab, files => importDroppedFiles(session, '', files));
  list.addEventListener('contextmenu', event => showContextMenu(event, [
    ['New file', () => openFileAction(session, 'file')],
    ['New folder', () => openFileAction(session, 'directory')],
    ['Refresh', () => refreshFiles(session)]
  ], root.querySelector('.file-refresh')));
  view.files = new Map();
  view.expandedFolders = new Set();
  view.fileEditor = root.querySelector('.file-editor');
  view.fileSave = root.querySelector('.file-save');
  view.fileSave.addEventListener('click', () => saveEditor(session));
  root.querySelector('.file-reload').addEventListener('click', () => loadPreview(session, view.file.relative, true));
  root.querySelector('.new-file').addEventListener('click', () => openFileAction(session, 'file'));
  root.querySelector('.new-directory').addEventListener('click', () => openFileAction(session, 'directory'));
}

function hasUnsavedFile(view) {
  return view.files ? [...view.files.values()].some(file => file.model && file.model.getValue() !== file.text) : false;
}

function dirty(file) {
  return Boolean(file?.model && file.model.getValue() !== file.text);
}

function updateEditor(view, status = '') {
  const { file } = view;
  const unsaved = dirty(file);
  view.fileSave.disabled = !unsaved || file.conflict || view.fileBusy;
  view.editor?.updateOptions({ readOnly: Boolean(view.fileBusy) });
  view.filesPanel.querySelector('.file-reload').disabled = Boolean(view.fileBusy);
  view.filesPanel.querySelector('.file-refresh').disabled = Boolean(view.fileBusy);
  const message = view.filesPanel.querySelector('.editor-status');
  const position = view.editor?.getPosition();
  const caret = file?.model && position ? 'Ln ' + position.lineNumber + ', Col ' + position.column : '';
  const detail = status || file?.refreshError || (file?.conflict ? 'Changed on disk. Copy your edits before reloading.'
    : unsaved ? (file.mixedEndings ? 'Unsaved · mixed line endings will normalize' : 'Unsaved')
    : file?.model ? 'Ctrl+S to save' : '');
  message.textContent = [detail, caret].filter(Boolean).join('  ·  ');
  message.hidden = !message.textContent;
  for (const tab of view.filesPanel.querySelectorAll('.file-tab')) {
    const entry = view.files.get(tab.dataset.path);
    tab.querySelector('.file-tab-dirty').hidden = !dirty(entry);
  }
}

function showEditorFile(session, file) {
  const { view } = session;
  if (view.file?.model && view.editor.getModel() === view.file.model) {
    view.file.position = view.editor.saveViewState();
  }
  view.file = file;
  const root = view.filesPanel;
  const heading = root.querySelector('.preview-heading');
  const content = root.querySelector('.file-content');
  root.querySelector('.editor-toolbar').hidden = !file;
  heading.textContent = heading.title = file?.relative || '';
  view.fileEditor.hidden = !file?.model;
  content.hidden = Boolean(file?.model);
  if (file?.model) {
    view.editor.setModel(file.model);
    if (file.position) view.editor.restoreViewState(file.position);
    view.editor.layout();
  } else {
    view.editor?.setModel(null);
    content.textContent = file ? file.preview : 'Select a text or code file to edit it.';
    if (file?.truncated) heading.textContent += ' · Read-only preview';
  }
  renderFileTabs(session);
  updateEditor(view, file?.truncated ? 'Files larger than 2 MB are read-only here.' : '');
}

const fileFormatColors = {
  js: '#f7da70', jsx: '#7de0e5', ts: '#8ec5ff', tsx: '#a7aaff',
  cjs: '#efd28c', mjs: '#f7bb76', html: '#ff9c7e', css: '#d4a5ff',
  scss: '#f59dc4', php: '#aca0ed', py: '#f5dd8d', json: '#c6df85',
  yaml: '#f9ab8e', yml: '#ffd0a2', md: '#a8ccff', txt: '#d3c6d0',
  svg: '#f4c390', png: '#91e2be', jpg: '#a4dea1', jpeg: '#abe3b5',
  webp: '#8dddd7', gif: '#f6a5d3', ico: '#d8b5eb', pdf: '#ff9ba7',
  sql: '#f6abbd', xml: '#ffbd98', csv: '#aada9c', zip: '#c5b5df',
  env: '#e6d0a0', docker: '#8fcfea', git: '#f6ab8a', lock: '#c9acc2'
};

function fileFormatBadge(name) {
  const filename = name.toLowerCase();
  const extension = filename === 'dockerfile' ? 'docker'
    : /^\.env(?:\.|$)/.test(filename) ? 'env'
    : /^\.git(?:ignore|attributes|modules)$/.test(filename) ? 'git'
    : filename.match(/\.([a-z0-9][a-z0-9_+-]*)$/)?.[1];
  const badge = node('span', extension?.slice(0, 6).toUpperCase() || 'FILE', 'file-format');
  badge.setAttribute('aria-hidden', 'true');
  if (extension) {
    const hue = Array.from(extension).reduce((hash, letter) => (hash * 31 + letter.charCodeAt(0)) % 360, 0);
    badge.style.setProperty('--file-format', Object.hasOwn(fileFormatColors, extension)
      ? fileFormatColors[extension] : 'hsl(' + hue + ' 65% 76%)');
  }
  return badge;
}

function renderFileTabs(session) {
  const { view } = session;
  const tabs = view.filesPanel.querySelector('.file-tabs');
  tabs.hidden = !view.files.size;
  tabs.replaceChildren(...[...view.files.values()].map(file => {
    const row = node('div', '', 'file-tab');
    row.dataset.path = file.relative;
    const name = file.relative.split('/').at(-1);
    const open = node('button', '', 'file-tab-select');
    open.append(fileFormatBadge(name), node('span', name, 'file-name'));
    open.type = 'button';
    open.title = file.relative;
    open.setAttribute('aria-pressed', String(file === view.file));
    open.append(node('span', '●', 'file-tab-dirty'));
    open.addEventListener('click', () => {
      if (!view.fileBusy && file !== view.file) showEditorFile(session, file);
    });
    const close = node('button', '×', 'file-tab-close');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close ' + file.relative);
    row.addEventListener('contextmenu', event => showContextMenu(event, [
      ['Rename', () => openFileAction(session, 'rename', file.relative)],
      ['Move to path…', () => openFileAction(session, 'move', file.relative)],
      ['Remove', () => removeFileEntry(session, file.relative, false)],
      ['Close tab', () => close.click()]
    ], open));
    close.addEventListener('click', async () => {
      if (view.fileBusy || (dirty(file) && !await confirmAction(
        'Close file?', 'Unsaved edits to ' + file.relative + ' will be lost.', 'Discard and close'))
        || view.fileBusy || view.files.get(file.relative) !== file) return;
      view.files.delete(file.relative);
      if (file === view.file) showEditorFile(session, [...view.files.values()].at(-1));
      else renderFileTabs(session);
      file.model?.dispose();
      updateEditor(view);
    });
    row.append(open, close);
    return row;
  }));
}

async function loadPreview(session, relative, reload = false) {
  const { view } = session;
  if (view.fileBusy) return;
  const cached = view.files.get(relative);
  if (cached && !reload) {
    if (cached !== view.file) showEditorFile(session, cached);
    return;
  }
  if (dirty(cached) && !await confirmAction(
    'Reload file?', 'Unsaved edits to ' + relative + ' will be lost.', 'Discard and reload')) return;
  if (view.fileBusy || view.editorDisposed || view.files.get(relative) !== cached) return;
  view.fileBusy = true;
  updateEditor(view, 'Opening file…');
  let issue;
  try {
    const result = await window.desk.preview(session.id, relative);
    const file = await cacheFilePreview(session, relative, result);
    if (file) showEditorFile(session, file);
  } catch (error) {
    issue = readableError(error);
  } finally {
    view.fileBusy = false;
    if (!view.editorDisposed) updateEditor(view, issue);
  }
}

async function cacheFilePreview(session, relative, result) {
  const { view } = session;
  const cached = view.files.get(relative);
  if (view.editorDisposed) return;
  const text = (result.text ?? '').replace(/\r\n|\r/g, '\n');
  const position = cached?.model && cached === view.file ? view.editor.saveViewState() : cached?.position;
  const file = { relative, revision: result.revision, text, mixedEndings: result.mixedEndings,
    truncated: result.truncated, position,
    preview: result.binary ? 'This file needs a binary or encoding-specific editor.' : result.text };
  if (result.revision) {
    await monacoReady();
    if (view.editorDisposed) return;
    if (!view.editor) {
      view.editor = monaco.editor.create(view.fileEditor, {
        model: null, theme: 'perona', automaticLayout: true,
        scrollBeyondLastLine: false, lineNumbers: 'on', ...editorDisplayOptions()
      });
      view.editor.onDidChangeModelContent(() => {
        updateEditor(view);
        if (!view.fileBusy && dirty(view.file)) reportPetActivity('edit', view.fileEditor);
      });
      view.editor.onDidChangeCursorPosition(() => updateEditor(view));
    }
    const uri = monaco.Uri.from({ scheme: 'perona-file', authority: session.id, path: '/' + relative });
    file.model = cached?.model ?? monaco.editor.createModel(text, undefined, uri);
    if (file.model.getValue() !== text) file.model.setValue(text);
    file.model.updateOptions({ tabSize: appPreferences.tabWidth, indentSize: 'tabSize' });
  }
  view.files.set(relative, file);
  if (cached?.model && !file.model) {
    if (cached === view.file) view.editor.setModel(null);
    cached.model.dispose();
  }
  return file;
}

async function refreshFiles(session) {
  const { view } = session;
  if (view.fileBusy) return;
  view.fileBusy = true;
  updateEditor(view, 'Refreshing files…');
  try {
    await loadFiles(session);
    const active = view.file;
    let refreshedActive;
    for (const [relative, file] of view.files) {
      if (view.editorDisposed) return;
      try {
        const result = await window.desk.preview(session.id, relative);
        if (view.editorDisposed) return;
        if (dirty(file)) {
          file.conflict = file.revision !== result.revision;
          file.refreshError = undefined;
        } else {
          const refreshed = await cacheFilePreview(session, relative, result);
          if (refreshed && file === active) refreshedActive = refreshed;
        }
      } catch (error) {
        if (view.editorDisposed) return;
        file.conflict = true;
        file.refreshError = 'Could not refresh ' + relative + ': ' + readableError(error);
      }
    }
    if (view.editorDisposed) return;
    if (refreshedActive) showEditorFile(session, refreshedActive);
    else renderFileTabs(session);
  } finally {
    view.fileBusy = false;
    if (!view.editorDisposed) updateEditor(view);
  }
}

async function saveEditor(session) {
  const { view } = session;
  if (view.fileSave.disabled || view.fileBusy) return;
  const file = view.file;
  const text = file.model.getValue();
  view.fileBusy = true;
  updateEditor(view, 'Saving…');
  let status;
  try {
    const result = await window.desk.save(session.id, file.relative, file.revision, text);
    if (result.conflict) file.conflict = true;
    else {
      file.text = text;
      file.revision = result.revision;
      file.mixedEndings = false;
      status = 'Saved';
      if (file.relative.split('/').at(-1) === '.gitignore') loadFiles(session);
    }
  } catch (error) {
    status = readableError(error);
  } finally {
    view.fileBusy = false;
    updateEditor(view, status);
  }
}

function openFileAction(session, type, relative) {
  if (session.view.fileBusy || fileDialog.open) return;
  fileAction = { session, type, relative };
  fileDialog.returnValue = '';
  fileDialog.querySelector('h2').textContent = { file: 'New file', directory: 'New folder',
    rename: 'Rename', move: 'Move to path' }[type];
  fileDialog.querySelector('label').textContent = type === 'rename' ? 'New name' : 'Path relative to project folder';
  filePathInput.value = type === 'rename' ? relative.split('/').at(-1)
    : relative ?? '';
  window.desk.previewHide().catch(setError);
  fileDialog.showModal();
  if (type === 'rename' || type === 'move') {
    const value = filePathInput.value;
    const start = value.lastIndexOf('/') + 1;
    const extension = value.lastIndexOf('.');
    filePathInput.setSelectionRange(start, extension > start ? extension : value.length);
  }
}

function parentDirectory(relative) {
  return relative.split('/').slice(0, -1).join('/');
}

function revealFileDirectory(view, directory) {
  for (let path = directory; path; path = parentDirectory(path)) view.expandedFolders.add(path);
}

function configureFileDrop(session, target, directory) {
  const { view } = session;
  configureExternalDrop(target, files => importDroppedFiles(session, directory(), files));
  const destination = () => {
    if (!view.fileDrag || view.fileBusy || target.disabled) return;
    const from = view.fileDrag;
    const folder = directory();
    const key = folder.toLowerCase();
    if (key === parentDirectory(from).toLowerCase()
        || key === from.toLowerCase() || key.startsWith(from.toLowerCase() + '/')) return;
    return [folder, from.split('/').at(-1)].filter(Boolean).join('/');
  };
  target.addEventListener('dragover', event => {
    if (!destination()) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    target.classList.add('file-directory-target');
  });
  target.addEventListener('dragleave', event => {
    if (!target.contains(event.relatedTarget)) target.classList.remove('file-directory-target');
  });
  target.addEventListener('drop', event => {
    const path = destination();
    target.classList.remove('file-directory-target');
    if (!path) return;
    event.preventDefault();
    event.stopPropagation();
    const source = view.fileDrag;
    view.fileDrag = undefined;
    moveFileEntry(session, source, path);
  });
}

async function importDroppedFiles(session, folder, files) {
  const { view } = session;
  if (view.fileBusy || !files.length) return;
  view.fileBusy = true;
  setError();
  try {
    const result = await window.desk.importProjectFiles(session.id, folder, files);
    if (sessions.get(session.id) !== session) return;
    showView(session, 'files');
    for (const conflict of result.conflicts) {
      const relative = [folder, conflict.name].filter(Boolean).join('/');
      const affected = openFilesUnder(view, relative);
      if (affected.some(dirty)) {
        result.skipped++;
        continue;
      }
      const message = relative + ' already exists. Replace ' +
        (conflict.directory ? 'the entire folder and everything inside it?' : 'the existing file?') +
        ' The original will be moved to the Recycle Bin when possible.';
      if (!await confirmAction('Replace ' + (conflict.directory ? 'folder?' : 'file?'), message, 'Replace', 'Skip')) continue;
      if (sessions.get(session.id) !== session) return;
      const replaced = await window.desk.importProjectFiles(session.id, folder,
        [files[conflict.index]], { name: conflict.name, revision: conflict.revision });
      if (replaced.copied) closeFileTabs(session, affected);
      result.skipped += replaced.skipped + replaced.conflicts.length;
      result.recovery.push(...replaced.recovery);
    }
    await loadFiles(session);
    if (result.skipped || result.recovery.length) {
      const details = [];
      if (result.skipped) details.push(result.skipped + ' item(s) could not be copied or replaced. Check for unsaved edits or changes at the destination.');
      if (result.recovery.length) details.push('Originals kept at: ' + result.recovery.join(', '));
      setError(new Error(details.join(' ')));
    }
  } catch (error) {
    setError(error);
  } finally {
    view.fileBusy = false;
  }
}

function openFilesUnder(view, relative) {
  const source = relative.toLowerCase();
  return [...view.files.values()].filter(file => {
    const filename = file.relative.toLowerCase();
    return filename === source || filename.startsWith(source + '/');
  });
}

function closeFileTabs(session, files) {
  if (!files.length) return;
  const { view } = session;
  for (const file of files) view.files.delete(file.relative);
  if (files.includes(view.file)) showEditorFile(session, [...view.files.values()].at(-1));
  else renderFileTabs(session);
  for (const file of files) file.model?.dispose();
}

async function removeFileEntry(session, relative, directory) {
  const { view } = session;
  if (view.fileBusy) return;
  const affected = openFilesUnder(view, relative);
  if (affected.some(dirty)) {
    setError(new Error('Save edits in this selection before removing it.'));
    return;
  }
  const message = relative + (directory ? ' and everything inside it' : '') + ' will move to the Recycle Bin.';
  if (!await confirmAction(directory ? 'Remove folder?' : 'Remove file?', message, 'Move to Recycle Bin')) return;
  view.fileBusy = true;
  try {
    await window.desk.removeEntry(session.id, relative, directory);
    closeFileTabs(session, affected);
    await loadFiles(session);
    if (isViewVisible(view, 'changes')) loadChanges(session);
    if (isViewVisible(view, 'git')) refreshGit(session);
  } catch (error) {
    setError(new Error(readableError(error)));
  } finally {
    view.fileBusy = false;
    updateEditor(view);
  }
}

async function moveFileEntry(session, relative, target) {
  const { view } = session;
  if (view.fileBusy || !target || target === relative) return;
  const affected = openFilesUnder(view, relative);
  if (affected.some(dirty)) {
    setError(new Error('Save edits in the file or folder before moving it.'));
    return;
  }
  view.fileBusy = true;
  updateEditor(view, 'Updating project files…');
  try {
    await window.desk.moveEntry(session.id, relative, target);
    closeFileTabs(session, affected);
    revealFileDirectory(view, parentDirectory(target));
    await loadFiles(session);
    view.fileBusy = false;
    if (affected.some(file => file.relative === relative)) await loadPreview(session, target);
    if (isViewVisible(view, 'changes')) loadChanges(session);
    if (isViewVisible(view, 'git')) refreshGit(session);
  } catch (error) {
    setError(new Error(readableError(error)));
  } finally {
    view.fileBusy = false;
    updateEditor(view);
  }
}

fileDialog.addEventListener('close', async () => {
  const action = fileAction;
  fileAction = undefined;
  if (fileDialog.returnValue !== 'apply' || !action) return;
  const { session, type, relative } = action;
  const { view } = session;
  const value = filePathInput.value.trim().replaceAll('\\', '/');
  if (!value || view.fileBusy) return;
  if (type === 'rename' || type === 'move') {
    if (type === 'rename' && value.includes('/')) {
      setError(new Error('Enter a name without folder separators.'));
      return;
    }
    const target = type === 'rename' ? [parentDirectory(relative), value].filter(Boolean).join('/') : value;
    await moveFileEntry(session, relative, target);
    return;
  }
  view.fileBusy = true;
  updateEditor(view, 'Updating project files…');
  try {
    await window.desk.createEntry(session.id, value, type);
    revealFileDirectory(view, parentDirectory(value));
    await loadFiles(session);
    view.fileBusy = false;
    if (type === 'file') await loadPreview(session, value);
  } catch (error) {
    setError(new Error(readableError(error)));
  } finally {
    view.fileBusy = false;
    updateEditor(view);
  }
});

function disposeEditor(view) {
  view.editorDisposed = true;
  view.editor?.dispose();
  for (const file of view.files.values()) file.model?.dispose();
}
