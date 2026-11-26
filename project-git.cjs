const { execFile } = require('node:child_process');
const { realpath } = require('node:fs/promises');
const { isAbsolute, relative } = require('node:path');
const { promisify } = require('node:util');

const run = promisify(execFile);
const busy = new Set();
const conflictCodes = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

async function runGit(folder, args, { readOnly = true, network = false, input, literalPaths = true } = {}) {
  const operation = run('git.exe', [
    ...(readOnly ? ['--no-optional-locks'] : []),
    ...(literalPaths ? ['--literal-pathspecs'] : []),
    '-c', 'core.fsmonitor=false', '-c', 'color.ui=false',
    '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always',
    '-c', 'protocol.ssh.allow=always', ...args
  ], {
    cwd: folder, encoding: 'utf8', windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'false' },
    timeout: network ? 180000 : readOnly ? 10000 : 60000, maxBuffer: 512 * 1024
  });
  if (input !== undefined) {
    const stdin = operation.child.stdin;
    stdin.on('error', () => {});
    stdin.end(input);
  }
  return (await operation).stdout;
}

function hideCredentials(value) {
  return value.replace(/(https?:\/\/)[^\s/]+@/gi, '$1[redacted]@');
}

async function optionalGit(folder, args, missing) {
  try {
    return (await runGit(folder, args)).trim();
  } catch (error) {
    if (missing(error)) return '';
    throw error;
  }
}

async function gitStatus(folder) {
  try {
    const root = await optionalGit(folder, ['rev-parse', '--show-toplevel'],
      error => /not a git repository/i.test(error.stderr || ''));
    if (!root) return { kind: 'uninitialized' };
    if (relative(await realpath(root), await realpath(folder))) return { kind: 'nested', root };

    const [branch, head, upstream, origin, push, status, name, email] = await Promise.all([
      optionalGit(folder, ['symbolic-ref', '--quiet', 'HEAD'], error => error.code === 1),
      optionalGit(folder, ['rev-parse', '--verify', '--quiet', 'HEAD'], error => error.code === 1),
      optionalGit(folder, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
        error => /no upstream|no such branch|HEAD does not point|ambiguous argument|unknown revision/i.test(error.stderr || '')),
      optionalGit(folder, ['remote', 'get-url', 'origin'], error => /No such remote/i.test(error.stderr || '')),
      optionalGit(folder, ['remote', 'get-url', '--push', '--all', 'origin'], error => /No such remote/i.test(error.stderr || '')),
      runGit(folder, ['status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=all']),
      optionalGit(folder, ['config', '--get', 'user.name'], error => error.code === 1),
      optionalGit(folder, ['config', '--get', 'user.email'], error => error.code === 1)
    ]);
    const files = status.split('\0').filter(Boolean).map(entry => ({
      code: entry.slice(0, 2), path: entry.slice(3)
    }));
    return {
      kind: 'ready', root, branch: branch.slice('refs/heads/'.length), head, upstream, origin: hideCredentials(origin),
      push: hideCredentials(push), files, name, email,
      conflicts: files.some(file => conflictCodes.has(file.code))
    };
  } catch (error) {
    if (error.code === 'ENOENT') return { kind: 'missing' };
    throw gitError(error);
  }
}

function gitError(error) {
  if (error.killed) return new Error('Git timed out. Refresh to check the current repository state.');
  if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return new Error('Git returned too much output to display.');
  const message = hideCredentials((error.stderr || error.message).trim());
  if (/\[rejected\].*\((?:non-fast-forward|fetch first)\)/i.test(message)) {
    return new Error('The remote branch has commits missing locally. Click Pull, resolve any conflicts, then push again.');
  }
  return new Error(message.slice(0, 3000));
}

function cleanText(value, label, limit) {
  if (typeof value !== 'string' || !value.trim() || value.length > limit || /[\r\n\0]/.test(value)) {
    throw new Error('Enter a valid ' + label + '.');
  }
  return value.trim();
}

function remoteUrl(value) {
  const url = cleanText(value, 'repository URL', 2048);
  if (/^git@[\w.-]+:[\w./~%-]+$/.test(url)) return url;
  const parsed = URL.parse(url);
  if (!parsed || !['https:', 'ssh:'].includes(parsed.protocol) || parsed.password
      || (parsed.protocol === 'https:' && parsed.username) || parsed.search || parsed.hash
      || parsed.pathname.length < 2) {
    throw new Error('Use the HTTPS or SSH clone URL without embedded credentials.');
  }
  return url;
}

function untrackPath(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096 || isAbsolute(value)
      || /[:\r\n\0]/.test(value)) throw new Error('Enter a file or folder path relative to this repository.');
  const target = value.replaceAll('\\', '/').replace(/\/$/, '');
  if (target.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')) {
    throw new Error('Choose a file or folder inside the repository.');
  }
  return target;
}

function hasLocalStagedRemovals(files) {
  const untracked = new Set(files.filter(file => file.code === '??').map(file => file.path));
  return files.some(file => file.code[0] === 'D' && untracked.has(file.path));
}

async function trackedGitPaths(folder) {
  const root = await runGit(folder, ['rev-parse', '--show-toplevel']);
  if (relative(await realpath(root.trim()), await realpath(folder))) return [];
  const result = new Set();
  for (const file of (await runGit(folder, ['ls-files', '-z', '--cached'])).split('\0')) {
    if (!file) continue;
    const parts = file.split('/');
    for (let index = 1; index < parts.length && result.size < 1500; index++) {
      result.add(parts.slice(0, index).join('/') + '/');
    }
    if (result.size >= 1500) break;
    result.add(file);
  }
  return [...result];
}

async function gitAction(folder, action, data) {
  const key = (await realpath(folder)).toLowerCase();
  if (busy.has(key)) throw new Error('A Git operation is already running for this project.');
  busy.add(key);
  try {
    const status = await gitStatus(folder);
    const git = (args, network = false) => runGit(folder, args, { readOnly: false, network });
    if (action === 'init' && status.kind === 'uninitialized') return await git(['init', '--initial-branch=main']);
    if (status.kind !== 'ready') throw new Error('Select the repository root to manage Git.');

    switch (action) {
      case 'origin':
        if (status.origin) throw new Error('This repository already has an origin.');
        return await git(['remote', 'add', 'origin', remoteUrl(data)]);
      case 'stage':
      case 'unstage': {
        const file = status.files.find(entry => entry.path === data);
        if (!file) throw new Error('This file has no changes. Refresh Git status.');
        if (action === 'stage') return await git(['add', '--', file.path]);
        return await git(status.head ? ['reset', '-q', 'HEAD', '--', file.path]
          : ['rm', '--cached', '-q', '--', file.path]);
      }
      case 'unstage-all':
        if (status.conflicts) throw new Error('Resolve Git conflicts before unstaging all changes.');
        return await git(status.head ? ['reset', '-q', 'HEAD', '--', '.'] : ['read-tree', '--empty']);
      case 'stage-all':
        if (status.conflicts) throw new Error('Resolve and stage conflicted files individually.');
        if (hasLocalStagedRemovals(status.files)) {
          throw new Error('Commit the staged removals or ignore their local copies before using Stage all. Stage all would add those copies back.');
        }
        return await git(['add', '--all']);
      case 'untrack':
        if (status.conflicts) throw new Error('Resolve Git conflicts before removing tracked files.');
        return await git(['rm', '-r', '--cached', '--', untrackPath(data)]);
      case 'commit':
        if (status.conflicts || !status.files.some(file => ![' ', '?'].includes(file.code[0]))) {
          throw new Error('Stage your changes and resolve any conflicts before committing.');
        }
        return await git(['commit', '-m', cleanText(data, 'commit message', 1000)]);
      case 'identity': {
        const name = cleanText(data?.name, 'author name', 200);
        const email = cleanText(data?.email, 'author email', 320);
        if (!/^[^\s<>@]+@[^\s<>@]+$/.test(email) || /[<>]/.test(name)) {
          throw new Error('Enter a valid author name and email.');
        }
        await git(['config', '--local', 'user.name', name]);
        return await git(['config', '--local', 'user.email', email]);
      }
      case 'fetch':
        if (status.origin) return await git(['fetch', '--no-recurse-submodules', 'origin'], true);
        break;
      case 'compare-merge': {
        const source = status.upstream || (status.origin && status.branch ? 'origin/' + status.branch : '');
        if (!status.head || !status.branch || !source || source !== data) break;
        const [remote, ref] = status.upstream
          ? (await runGit(folder, ['for-each-ref', '--format=%(upstream:remotename)%00%(upstream:remoteref)',
            'refs/heads/' + status.branch])).trim().split('\0')
          : ['origin', 'refs/heads/' + status.branch];
        if (!remote || !ref) throw new Error('The upstream branch is unavailable.');
        await git(['fetch', '--no-recurse-submodules', '--', remote, ref], true);
        const incoming = (await runGit(folder, ['rev-parse', '--verify', 'FETCH_HEAD^{commit}'])).trim();
        const [conflicts, summary, counts, diff] = await Promise.all([
          mergeConflicts(folder, status.head, incoming),
          runGit(folder, ['diff', '--no-ext-diff', '--no-textconv', '--stat=80,48,50', status.head, incoming, '--']),
          runGit(folder, ['rev-list', '--left-right', '--count', status.head + '...' + incoming]),
          runGit(folder, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', status.head, incoming, '--'])
            .catch(error => {
              if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return null;
              throw error;
            })
        ]);
        const [localOnly, incomingOnly] = counts.trim().split(/\s+/).map(Number);
        return { head: status.head, branch: status.branch, incoming, conflicts, summary, diff, localOnly, incomingOnly };
      }
      case 'pull': {
        if (!status.head || status.head !== data?.head || status.branch !== data?.branch ||
            typeof data?.incoming !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(data.incoming)) {
          throw new Error('The current branch changed. Compare the merge again.');
        }
        if (status.files.length) throw new Error('Commit or stash your local changes before pulling.');
        const fetched = (await runGit(folder, ['rev-parse', '--verify', 'FETCH_HEAD^{commit}'])).trim();
        if (fetched !== data.incoming) throw new Error('The fetched commit changed. Compare the merge again.');
        if ((await mergeConflicts(folder, status.head, fetched)).length) {
          throw new Error('Git predicts merge conflicts. No files were merged.');
        }
        return await git(['merge', '-s', 'ort', '--ff', '--no-edit', '--no-autostash', '--allow-unrelated-histories', fetched]);
      }
        break;
      case 'push':
        if (status.origin && status.branch && status.head && status.push && !status.push.includes('\n')
            && status.branch === data?.branch && status.push === data?.push) {
          return await git(['push', '--no-follow-tags', '--recurse-submodules=no', '--set-upstream',
            'origin', 'HEAD:refs/heads/' + status.branch], true);
        }
        break;
    }
    throw new Error('This Git action is unavailable for the current repository state.');
  } catch (error) {
    throw gitError(error);
  } finally {
    busy.delete(key);
  }
}

async function mergeConflicts(folder, head, incoming) {
  try {
    await runGit(folder, ['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z',
      '--allow-unrelated-histories', head, incoming]);
    return [];
  } catch (error) {
    if (error.code !== 1) throw error;
    const paths = error.stdout.split('\0').slice(1).filter(Boolean);
    return paths.length ? paths : ['Git found a conflict.'];
  }
}

async function cloneRepository(folder, url) {
  try {
    await runGit(folder, ['clone', '--no-recurse-submodules', '--', remoteUrl(url), '.'],
      { readOnly: false, network: true });
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('Install Git for Windows to clone a repository.');
    throw gitError(error);
  }
}

module.exports = { runGit, gitStatus, gitAction, trackedGitPaths, cloneRepository };
