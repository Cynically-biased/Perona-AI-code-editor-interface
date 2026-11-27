const { createHash, randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { mkdir, readFile, readdir, realpath, rename, stat, unlink, writeFile } = require('node:fs/promises');
const path = require('node:path');

const actions = ['open', 'run', 'build'];
const isGodotProject = folder => stat(path.join(folder, 'project.godot'))
  .then(file => file.isFile()).catch(() => false);

function createGameEngines(profileFolder) {
  const approved = new Map();
  const jobs = new Map();
  const key = folder => path.resolve(folder).toLowerCase();
  const profilePath = folder => path.join(profileFolder, createHash('sha256').update(key(folder)).digest('hex') + '.json');
  const validateExe = async value => {
    const exe = await realpath(value);
    if (path.extname(exe).toLowerCase() !== '.exe' || !(await stat(exe)).isFile()) {
      throw new Error('Choose a Windows engine executable (.exe).');
    }
    return exe;
  };

  async function load(folder) {
    let profile;
    try { profile = JSON.parse(await readFile(profilePath(folder), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (profile) return profile;
    const isGodot = await isGodotProject(folder);
    if (isGodot) return { executable: '', open: ['--editor', '--path', '.'],
      run: ['--path', '.', '--windowed'], build: [] };
    const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
    const unreal = entries.filter(entry => entry.isFile() && path.extname(entry.name).toLowerCase() === '.uproject');
    if (unreal.length === 1) {
      const descriptor = path.join(folder, unreal[0].name);
      return { executable: '', open: [descriptor], run: [descriptor, '-game', '-windowed'], build: [] };
    }
    return { executable: '', open: [], run: [], build: [] };
  }

  async function detectPlaytest(folder, docked = true) {
    const profile = await load(folder);
    let executable = profile.executable;
    if (executable) {
      const resolved = await validateExe(executable);
      if (key(resolved) !== key(executable)) throw new Error('The engine executable moved. Choose it again in Configure engine.');
      return { executable: resolved, args: profile.run };
    } else {
      if (!await isGodotProject(folder)) {
        if (!profile.run.includes('-game')) return null;
        const descriptor = JSON.parse((await readFile(profile.run[0], 'utf8')).replace(/^\uFEFF/, ''));
        const association = descriptor.EngineAssociation;
        if (typeof association === 'string' && /^\d+\.\d+(?:\.\d+)?$/.test(association)
            && process.env.ProgramFiles) {
          const installed = path.join(process.env.ProgramFiles, 'Epic Games', 'UE_' + association,
            'Engine', 'Binaries', 'Win64', 'UnrealEditor.exe');
          executable = await validateExe(installed).catch(() => '');
        }
        if (executable) return { executable, args: docked ? profile.run : profile.run.slice(0, -1) };
        throw new Error('Unreal Engine was not found at its standard install location. Choose UnrealEditor.exe once in Games → Configure engine.');
      }
      // Search named executables on PATH without including the project working directory.
      const pathDirs = (process.env.PATH ?? '').split(path.delimiter)
        .map(entry => entry.trim().replace(/^"|"$/g, '')).filter(path.isAbsolute);
      const candidates = pathDirs.flatMap(dir => ['godot.exe', 'godot4.exe'].map(name => path.join(dir, name)));
      const local = process.env.LOCALAPPDATA;
      const installed = [
        process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Godot'),
        local && path.join(local, 'Programs', 'Godot'),
        local && path.join(local, 'Microsoft', 'WinGet', 'Links')
      ].filter(Boolean);
      for (const dir of installed) {
        const entries = await readdir(dir).catch(() => []);
        for (const name of entries.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))) {
          if (/^godot(?:_v4[\w.-]*|4)?\.exe$/i.test(name) && !/_console\.exe$/i.test(name)) {
            candidates.push(path.join(dir, name));
          }
        }
      }
      const root = await realpath(folder);
      for (const candidate of candidates) {
        executable = await validateExe(candidate).catch(() => '');
        if (!executable) continue;
        const relative = path.relative(root, executable);
        if (path.isAbsolute(relative) || relative.startsWith('..' + path.sep)) break;
        executable = '';
      }
    }
    if (!executable) throw new Error('Godot was not found. Add Godot 4 to PATH or select the installed Godot executable once in Games → Configure engine.');
    return { executable, args: ['--path', folder, ...(docked ? ['--windowed'] : [])] };
  }

  async function choose(folder, executable) {
    const resolved = await validateExe(executable);
    approved.set(key(folder), resolved);
    return resolved;
  }

  async function save(folder, profile) {
    const previous = await load(folder);
    if (!profile?.executable || ![previous.executable, approved.get(key(folder))].includes(profile.executable)) {
      throw new Error('Use Browse to choose the engine executable.');
    }
    const next = { executable: await validateExe(profile.executable) };
    for (const action of actions) {
      const args = profile[action];
      if (!Array.isArray(args) || args.length > 100 ||
          args.some(arg => typeof arg !== 'string' || arg.length > 2048 || arg.includes('\0'))) {
        throw new Error('Enter a JSON list of argument strings for each action.');
      }
      next[action] = args;
    }
    await mkdir(profileFolder, { recursive: true });
    const target = profilePath(folder);
    const temporary = target + '.' + randomUUID() + '.tmp';
    try {
      await writeFile(temporary, JSON.stringify(next), { flag: 'wx' });
      await rename(temporary, target);
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }

  async function launch(folder, action, onRunError = () => {}) {
    if (!actions.includes(action)) throw new Error('Unknown game engine action.');
    const profile = await load(folder);
    if (!profile.executable) throw new Error('Configure the game engine for this project first.');
    const args = profile[action];
    if (action === 'build' && !args.length) throw new Error('Set Build arguments in Configure engine first.');
    const executable = await validateExe(profile.executable);
    if (key(executable) !== key(profile.executable)) throw new Error('The engine executable moved. Choose it again in Configure engine.');
    const id = key(folder);
    if (action !== 'open' && jobs.has(id)) throw new Error('Stop the current engine task first.');
    const child = spawn(executable, args, {
      cwd: folder, shell: false, detached: action === 'open',
      stdio: action === 'open' ? 'ignore' : ['ignore', 'pipe', 'pipe'],
      windowsHide: action === 'build'
    });
    if (action === 'open') {
      await new Promise((resolve, reject) => {
        child.once('spawn', resolve);
        child.on('error', reject);
      });
      child.unref();
      return;
    }
    const job = { child, stopped: false };
    jobs.set(id, job);
    let output = '';
    for (const stream of [child.stdout, child.stderr]) {
      stream?.setEncoding('utf8');
      stream?.on('data', chunk => { output = (output + chunk).slice(-24000); });
    }
    const finished = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal, output }));
    }).finally(() => { if (jobs.get(id) === job) jobs.delete(id); });
    if (action === 'build') return finished;
    finished.then(({ code, signal, output }) => {
      if (job.stopped || code === 0) return;
      const reason = signal ? 'ended with signal ' + signal : 'exited with code ' + code;
      const details = output.trim().slice(-2000);
      onRunError('Run Project ' + reason + '.' + (details ? '\n' + details : ''));
    }, () => {}); // Startup errors are returned by launch below.
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
  }

  return {
    load, choose, save, launch, detectPlaytest,
    stop(folder) {
      const job = jobs.get(key(folder));
      if (!job || !job.child.kill()) return false;
      job.stopped = true;
      return true;
    },
    stopAll() {
      for (const job of jobs.values()) {
        job.stopped = true;
        job.child.kill();
      }
    }
  };
}

module.exports = { createGameEngines };
