const { createHash, randomUUID } = require('node:crypto');
const { constants } = require('node:fs');
const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const { promisify } = require('node:util');
const { runGit } = require('./project-git.cjs');

const run = promisify(execFile);
const previewLimit = 160 * 1024;
const editLimit = 2 * 1024 * 1024;
const imageLimit = 20 * 1024 * 1024;
const imageTypes = new Map([
  ['.png', 'image/png'], ['.apng', 'image/apng'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'], ['.webp', 'image/webp'], ['.avif', 'image/avif'], ['.bmp', 'image/bmp'],
  ['.ico', 'image/x-icon'], ['.svg', 'image/svg+xml']
]);
const saving = new Set();
const removing = new Set();
const directoryLimit = 1500;

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep);
}

async function projectPath(folder, relative) {
  if (typeof relative !== 'string' || path.isAbsolute(relative) || /[:\0]/.test(relative)
      || relative.split(/[\\/]/).some(part => part === '..' || part.toLowerCase() === '.git')) {
    throw new Error('Select an item inside the project folder.');
  }
  const root = await fs.realpath(folder);
  const candidate = await fs.realpath(path.resolve(root, relative));
  if (!inside(root, candidate) || path.relative(root, candidate).toLowerCase().split(path.sep).includes('.git')) {
    throw new Error('This item resolves outside the browsable project.');
  }
  return candidate;
}

async function listFolder(folder, relative) {
  const target = await projectPath(folder, relative);
  const entries = await fs.readdir(target, { withFileTypes: true });
  const visible = entries
    .filter(entry => entry.name.toLowerCase() !== '.git'
      && (entry.isDirectory() || entry.isFile()))
    .map(entry => ({ name: entry.name, directory: entry.isDirectory() }))
    .sort((a, b) => Number(b.directory) - Number(a.directory)
      || a.name.localeCompare(b.name, undefined, { numeric: true }));
  const listed = visible.slice(0, directoryLimit);
  if (listed.length) {
    const names = listed.map(entry => './' + entry.name + (entry.directory ? '/' : ''));
    const output = await runGit(target, ['check-ignore', '-z', '--stdin'], {
      input: names.join('\0') + '\0', literalPaths: false
    }).catch(() => '');
    const ignored = new Set(output.split('\0'));
    for (const [index, entry] of listed.entries()) entry.ignored = ignored.has(names[index]);
  }
  return { entries: listed, truncated: visible.length > directoryLimit };
}

function importRevision(stat) {
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
}

async function copyImport(source, destination, directory) {
  if (!directory) {
    await fs.copyFile(source, destination, constants.COPYFILE_EXCL);
    return;
  }
  await fs.cp(source, destination, {
    recursive: true, force: false, errorOnExist: true,
    async filter(item) {
      entryPath(path.basename(item));
      const stat = await fs.lstat(item);
      if (!stat.isFile() && !stat.isDirectory()) throw new Error('Folder contains an unsupported item.');
      return true;
    }
  });
}

async function importFiles(folder, relative, sources, replacement, trash) {
  if (!Array.isArray(sources) || !sources.length || sources.length > directoryLimit) {
    throw new Error('Drop up to ' + directoryLimit + ' files at a time.');
  }
  const target = await projectPath(folder, relative);
  if (!(await fs.stat(target)).isDirectory()) throw new Error('Drop files onto a project folder.');
  const result = { copied: 0, conflicts: [], skipped: 0, recovery: [] };
  for (const [index, source] of sources.entries()) {
    if (typeof source !== 'string' || !path.isAbsolute(source) || /\0/.test(source)) {
      result.skipped++;
      continue;
    }
    const name = path.basename(source);
    try {
      entryPath(name);
      const sourceStat = await fs.lstat(source);
      if (!sourceStat.isFile() && !sourceStat.isDirectory()) {
        result.skipped++;
        continue;
      }
      const directory = sourceStat.isDirectory();
      const destination = path.join(target, name);
      const original = await fs.realpath(source);
      if (path.relative(original, destination) === '' || (directory && inside(original, target))) {
        result.skipped++;
        continue;
      }
      const existing = await fs.lstat(destination).catch(error => {
        if (error.code !== 'ENOENT') throw error;
        return null;
      });
      if (existing && !existing.isFile() && !existing.isDirectory()) {
        result.skipped++;
        continue;
      }
      if (existing && (!replacement || replacement.name !== name || replacement.revision !== importRevision(existing))) {
        result.conflicts.push({ index, name, directory: existing.isDirectory(), revision: importRevision(existing) });
        continue;
      }
      if (!directory && !existing) {
        await copyImport(source, destination, false);
      } else {
        const staging = await fs.mkdtemp(path.join(target, '.perona-import-'));
        const staged = path.join(staging, 'incoming');
        const previous = path.join(staging, 'previous', name);
        let backedUp = false;
        try {
          await copyImport(source, staged, directory);
          if (existing) {
            if (importRevision(await fs.lstat(destination)) !== replacement.revision) {
              throw new Error('The destination changed before replacement.');
            }
            await fs.mkdir(path.dirname(previous));
            await fs.rename(destination, previous);
            backedUp = true;
          }
          try {
            if (directory) await fs.rename(staged, destination);
            else await fs.copyFile(staged, destination, constants.COPYFILE_EXCL);
          } catch (error) {
            if (backedUp && !(await fs.lstat(destination).catch(() => null))) {
              await fs.rename(previous, destination);
              backedUp = false;
            }
            throw error;
          }
          if (backedUp) {
            await trash(previous).then(() => { backedUp = false; }).catch(() => {});
          }
        } finally {
          if (backedUp) result.recovery.push(previous);
          else await fs.rm(staging, { recursive: true, force: true });
        }
      }
      result.copied++;
    } catch (error) {
      result.skipped++;
    }
  }
  return result;
}

function revision(data) {
  return createHash('sha256').update(data).digest('hex');
}

async function readFileBytes(target, limit = editLimit) {
  const file = await fs.open(target, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error('Select a regular file.');
    const buffer = Buffer.alloc(Math.min(stat.size + 1, limit + 1));
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    return { bytes: buffer.subarray(0, length), mode: stat.mode };
  } finally {
    await file.close();
  }
}

function decodeFile(bytes, truncated = false) {
  const utf16le = bytes[0] === 0xff && bytes[1] === 0xfe;
  const utf16be = bytes[0] === 0xfe && bytes[1] === 0xff;
  const utf8Bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const encoding = utf16le ? 'utf-16le' : utf16be ? 'utf-16be' : 'utf-8';
  const bomLength = utf16le || utf16be ? 2 : utf8Bom ? 3 : 0;
  try {
    const text = new TextDecoder(encoding, { fatal: true, ignoreBOM: true }).decode(bytes.subarray(bomLength), { stream: truncated });
    if (text.includes('\0')) return;
    const endings = [...new Set(text.match(/\r\n|\r|\n/g))];
    return { text, encoding, bomLength, endings };
  } catch {
    return;
  }
}

async function previewFile(folder, relative, { images = false } = {}) {
  const target = await projectPath(folder, relative);
  const imageType = images && imageTypes.get(path.extname(relative).toLowerCase());
  const { bytes } = await readFileBytes(target, imageType ? imageLimit : editLimit);
  let image;
  if (imageType) {
    if (bytes.length > imageLimit) return { notice: 'Images larger than 20 MB cannot be previewed.' };
    image = { type: imageType, base64: bytes.toString('base64') };
    if (imageType !== 'image/svg+xml') return { image };
  }
  const truncated = bytes.length > editLimit;
  const data = truncated ? bytes.subarray(0, previewLimit) : bytes;
  const decoded = decodeFile(data, truncated);
  if (!decoded) return image ? { image } : { binary: true };
  return { text: decoded.text, truncated, revision: truncated ? null : revision(bytes),
    mixedEndings: decoded.endings.length > 1, image };
}

async function saveFile(folder, relative, expected, text) {
  if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected)
      || typeof text !== 'string' || text.length > editLimit || text.includes('\0')) {
    throw new Error('The edited file is too large or contains unsupported text.');
  }
  const target = await projectPath(folder, relative);
  const key = target.toLowerCase();
  if (saving.has(key)) throw new Error('This file is already being saved. Try again.');
  if ([...removing].some(item => inside(item, key))) throw new Error('This file is being removed.');
  saving.add(key);
  let temporary;
  try {
    const conflict = () => ({ conflict: true });
    const { bytes, mode } = await readFileBytes(target);
    if (bytes.length > editLimit || revision(bytes) !== expected) return conflict();
    const original = decodeFile(bytes);
    if (!original) throw new Error('Only supported text files can be edited.');
    const eol = original.endings[0] ?? '\n';
    const normalized = text.replace(/\r\n|\r/g, '\n');
    if (normalized === original.text.replace(/\r\n|\r/g, '\n')) return { revision: expected };
    const updated = normalized.replace(/\n/g, eol);
    const content = Buffer.from(updated, original.encoding === 'utf-8' ? 'utf8' : 'utf16le');
    if (original.encoding === 'utf-16be') content.swap16();
    const data = Buffer.concat([bytes.subarray(0, original.bomLength), content]);
    if (data.length > editLimit) throw new Error('Edited files must be 2 MB or smaller.');
    temporary = path.join(path.dirname(target), '.perona-save-' + randomUUID() + '.tmp');
    const file = await fs.open(temporary, 'wx', mode);
    try {
      await file.writeFile(data);
      await file.sync();
    } finally {
      await file.close();
    }
    const current = await projectPath(folder, relative);
    if (current !== target || revision((await readFileBytes(target)).bytes) !== expected) return conflict();
    await fs.rename(temporary, target);
    temporary = undefined;
    return { revision: revision(data) };
  } finally {
    saving.delete(key);
    if (temporary) await fs.unlink(temporary).catch(() => {});
  }
}

function entryPath(relative) {
  if (typeof relative !== 'string' || !relative || relative.length > 1000 || path.isAbsolute(relative)) {
    throw new Error('Enter a path relative to the project folder.');
  }
  const parts = relative.split(/[\\/]/);
  if (parts.some(part => !part || /[<>:"|?*\x00-\x1f]|[. ]$/.test(part) || /^\.git$/i.test(part)
      || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part))) {
    throw new Error('Use valid Windows file and folder names.');
  }
  return parts;
}

async function destinationPath(folder, relative) {
  const parts = entryPath(relative);
  const name = parts.pop();
  return path.join(await projectPath(folder, parts.join('/')), name);
}

async function createEntry(folder, relative, type) {
  const target = await destinationPath(folder, relative);
  if (type === 'directory') await fs.mkdir(target);
  else if (type === 'file') await fs.writeFile(target, '', { flag: 'wx' });
  else throw new Error('Choose a file or folder.');
}

async function regularEntry(folder, relative) {
  const rawSource = await destinationPath(folder, relative);
  const source = await projectPath(folder, relative);
  const info = await fs.lstat(rawSource);
  if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) {
    throw new Error('Select a regular file or folder.');
  }
  return { source, directory: info.isDirectory() };
}

async function moveEntry(folder, relative, destination) {
  const { source, directory } = await regularEntry(folder, relative);
  const target = await destinationPath(folder, destination);
  if (source === target) return;
  if ([...saving].some(file => inside(source.toLowerCase(), file))) {
    throw new Error('A file in this selection is being saved. Try again.');
  }
  const quote = value => "'" + value.replaceAll("'", "''") + "'";
  const type = directory ? 'Directory' : 'File';
  const script = "$ErrorActionPreference = 'Stop'; [IO." + type + ']::Move(' +
    quote(source) + ', ' + quote(target) + ')';
  await run('powershell.exe', ['-NoProfile', '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 10000 });
}

async function removeEntry(folder, relative, directory, trash) {
  const entry = await regularEntry(folder, relative);
  if (entry.directory !== directory) throw new Error('This item changed. Refresh the Files tab and try again.');
  const key = entry.source.toLowerCase();
  if ([...saving].some(file => inside(key, file))
      || [...removing].some(item => inside(key, item) || inside(item, key))) {
    throw new Error('A file operation is already running for this selection. Try again.');
  }
  removing.add(key);
  try {
    await trash(entry.source);
  } finally {
    removing.delete(key);
  }
}

async function projectChanges(folder) {
  const git = args => runGit(folder, args);
  try {
    await git(['rev-parse', '--is-inside-work-tree']);
  } catch (error) {
    if (error.code === 'ENOENT') return { notice: 'Git is unavailable.' };
    if (/not a git repository/i.test(error.stderr || '')) return { notice: 'This folder is outside a Git repository.' };
    throw error;
  }
  const status = await git(['status', '--short', '--untracked-files=normal', '--', '.']);
  if (!status.trim()) return { status, diff: '' };
  try {
    const diff = await git(['diff', '--no-ext-diff', '--no-textconv', '--relative', 'HEAD', '--', '.']);
    return { status, diff };
  } catch (error) {
    if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return { status, notice: 'The diff is too large to preview.' };
    if (/unknown revision|bad revision|ambiguous argument/i.test(error.stderr || '')) {
      const diff = await git(['diff', '--cached', '--no-ext-diff', '--no-textconv', '--relative', '--', '.']);
      return { status, diff };
    }
    throw error;
  }
}

module.exports = { listFolder, previewFile, saveFile, createEntry, importFiles, moveEntry, removeEntry, projectChanges };
