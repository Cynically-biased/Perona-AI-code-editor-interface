const mergeDialog = document.getElementById('merge-dialog');

function configureGit(session) {
  const panel = session.view.root.querySelector('[data-panel="git"]');
  const find = selector => panel.querySelector(selector);
  const git = session.view.git = {
    controls: find('.git-controls'),
    refresh: find('.git-refresh'),
    compare: find('.git-compare'),
    message: find('.git-message'),
    repository: find('.git-repository'),
    branch: find('.git-branch'),
    originLabel: find('.git-origin-label'),
    connect: find('.git-connect'),
    author: find('.git-author'),
    files: find('.git-files'),
    actions: Object.fromEntries(Array.from(panel.querySelectorAll('[data-git-action]'),
      button => [button.dataset.gitAction, button])),
    origin: find('.git-origin'),
    identity: find('.git-identity'),
    commit: find('.git-commit'),
    untrack: find('.git-untrack'),
    untrackPanel: find('.git-untrack-panel'),
    tracked: find('.git-tracked-paths')
  };

  git.refresh.addEventListener('click', () => refreshGit(session));
  git.compare.addEventListener('click', () => compareGitMerge(session));
  find('.git-clone').addEventListener('click', () => openCloneDialog(session.agent));
  for (const [action, button] of Object.entries(git.actions)) {
    button.addEventListener('click', async () => {
      let data;
      if (action === 'push') {
        const { branch, push } = git.status;
        if (!await confirmAction('Push ' + branch + '?', 'Destination: ' + push, 'Push')) return;
        data = { branch, push };
      }
      if (action === 'pull') {
        await compareGitMerge(session);
        return;
      }
      if (action === 'stage-all'
          && !await confirmAction('Stage all changes?',
            'This includes untracked files. Review the file list for secrets before publishing.', 'Stage all')) return;
      runGitAction(session, action, data);
    });
  }
  for (const button of panel.querySelectorAll('[data-git-provider]')) {
    button.addEventListener('click', () => window.desk.gitCreatePage(button.dataset.gitProvider)
      .catch(error => { git.message.textContent = readableError(error); }));
  }
  for (const [action, form] of [['origin', git.origin], ['identity', git.identity], ['commit', git.commit]]) {
    form.addEventListener('submit', event => {
      event.preventDefault();
      const input = form.querySelector('input');
      const data = action === 'identity'
        ? { name: input.value, email: form.elements.email.value } : input.value;
      runGitAction(session, action, data);
    });
  }
  const pathInput = git.untrack.querySelector('input');
  git.tracked.id = 'git-tracked-' + session.id;
  pathInput.setAttribute('list', git.tracked.id);
  git.untrackPanel.addEventListener('toggle', () => {
    if (git.untrackPanel.open) loadTrackedGitPaths(session);
  });
  git.untrack.addEventListener('submit', async event => {
    event.preventDefault();
    const target = pathInput.value;
    if (!target.trim() || git.busy) return;
    if (!await confirmAction('Remove from Git?',
      target + ' will be staged for removal. Your local copies stay. Commit and push to apply this to the remote branch.',
      'Stage removal')) return;
    await runGitAction(session, 'untrack', target);
  });
}

async function compareGitMerge(session) {
  const git = session.view.git;
  if (git.busy || !git.pullSource || document.querySelector('dialog[open]')) return;
  const status = mergeDialog.querySelector('#merge-status');
  const conflicts = mergeDialog.querySelector('#merge-conflicts');
  const summary = mergeDialog.querySelector('#merge-summary');
  const diffSection = mergeDialog.querySelector('#merge-diff-section');
  const diff = mergeDialog.querySelector('#merge-diff');
  const apply = mergeDialog.querySelector('#merge-apply');
  const source = git.pullSource;
  let plan;
  let closed = false;
  status.textContent = 'Fetching and comparing ' + source + '…';
  conflicts.hidden = summary.hidden = diffSection.hidden = true;
  diffSection.open = false;
  apply.disabled = true;
  mergeDialog.returnValue = '';
  mergeDialog.addEventListener('close', async () => {
    closed = true;
    if (mergeDialog.returnValue !== 'merge' || !plan || apply.disabled || sessions.get(session.id) !== session) return;
    if ([...sessions.values()].some(item => item.folder.toLowerCase() === session.folder.toLowerCase()
        && hasUnsavedFile(item.view))) {
      git.message.textContent = 'Save your editor changes before merging.';
      return;
    }
    await runGitAction(session, 'pull', plan);
  }, { once: true });
  mergeDialog.showModal();
  syncPreview();
  try {
    plan = await window.desk.gitAction(session.id, 'compare-merge', source);
    if (closed || !mergeDialog.open) return;
    const counts = plan.localOnly + ' local-only and ' + plan.incomingOnly + ' incoming commit(s). ';
    status.textContent = counts + (plan.conflicts.length ? 'Git predicts conflicts. Your files are unchanged.'
      : plan.incomingOnly ? 'Git found no merge conflicts.' : 'There are no incoming changes.');
    if (plan.diff === null) status.textContent += ' The full comparison is too large to display.';
    conflicts.replaceChildren(...plan.conflicts.map(path => node('li', path)));
    conflicts.hidden = !plan.conflicts.length;
    summary.textContent = plan.summary.trim();
    summary.hidden = !summary.textContent;
    diff.textContent = plan.diff || '';
    diffSection.hidden = !plan.diff;
    apply.disabled = Boolean(plan.conflicts.length || !plan.incomingOnly);
  } catch (error) {
    if (!closed && mergeDialog.open) status.textContent = readableError(error);
  }
}

async function loadTrackedGitPaths(session) {
  const git = session.view.git;
  try {
    const paths = await window.desk.gitTrackedPaths(session.id);
    git.tracked.replaceChildren(...paths.map(path => new Option(path, path)));
  } catch {
    git.tracked.replaceChildren();
  }
}

function renderGit(session, status) {
  const git = session.view.git;
  git.status = status;
  git.actions.init.hidden = status.kind !== 'uninitialized';
  git.repository.hidden = status.kind !== 'ready';
  if (status.kind !== 'ready') {
    return {
      missing: 'Install Git for Windows and restart Perona to use this tab.',
      uninitialized: 'Initialize Git in this project folder to start tracking changes.',
      nested: 'This folder is inside a repository. Select its root to manage Git. ' + status.root
    }[status.kind];
  }

  git.branch.textContent = (status.branch || 'Detached HEAD')
    + (status.upstream ? ' · Tracking ' + status.upstream : '');
  git.originLabel.textContent = status.origin ? 'Origin · ' + status.origin : '';
  git.connect.hidden = Boolean(status.origin);
  git.actions.fetch.disabled = !status.origin;
  git.pullSource = status.upstream || (status.origin && status.branch ? 'origin/' + status.branch : '');
  git.actions.pull.disabled = !status.head || !status.branch || !git.pullSource;
  git.compare.disabled = git.actions.pull.disabled;
  git.actions.push.disabled = !status.origin || !status.push || !status.branch
    || !status.head || status.push.includes('\n');
  git.actions['stage-all'].disabled = status.conflicts || !status.files.some(file => file.code[1] !== ' ');
  git.actions['unstage-all'].disabled = status.conflicts
    || !status.files.some(file => ![' ', '?'].includes(file.code[0]));
  git.commit.querySelector('button').disabled = status.conflicts || !status.name || !status.email
    || !status.files.some(file => ![' ', '?'].includes(file.code[0]));
  git.identity.elements.author.value = status.name;
  git.identity.elements.email.value = status.email;
  if (!status.name || !status.email) git.author.open = true;

  const entries = status.files.map(file => {
    const item = node('li');
    const staged = ![' ', '?'].includes(file.code[0]);
    const label = node('span', file.path);
    label.title = file.path;
    item.append(label, node('small', file.code[0] === 'D' ? 'Staged removal' : file.code === '??' ? 'Untracked'
      : staged && file.code[1] !== ' ' ? 'Staged + modified'
      : staged ? 'Staged' : 'Modified'));
    if (file.code[1] !== ' ') item.append(toolButton('Stage', () => runGitAction(session, 'stage', file.path)));
    if (staged) item.append(toolButton('Unstage', () => runGitAction(session, 'unstage', file.path)));
    return item;
  });
  git.files.replaceChildren(...entries);
  if (status.conflicts) return 'Resolve conflicts in the editor, then stage the resolved files.';
  return status.files.length ? '' : 'No uncommitted changes.';
}

const gitSuccess = {
  init: 'Git initialized.', origin: 'Origin connected.', identity: 'Commit author saved.',
  commit: 'Commit created.', fetch: 'Fetched from origin.', pull: 'Pulled remote changes.',
  push: 'Pushed to origin.', untrack: 'Removal staged. Local copies are still on disk.',
  'unstage-all': 'All changes unstaged. Your files are still on disk.'
};

async function refreshGit(session, action, data) {
  const git = session.view.git;
  if (git.busy) return;
  git.busy = true;
  git.controls.disabled = git.refresh.disabled = true;
  git.message.textContent = action ? 'Running Git…' : 'Checking Git…';
  let error = '';
  try {
    if (action) {
      try {
        await window.desk.gitAction(session.id, action, data);
        if (['commit', 'origin', 'untrack'].includes(action)) git[action].reset();
        if (isViewVisible(session.view, 'changes')) loadChanges(session);
      } catch (failure) {
        error = readableError(failure);
      }
    }
    const notice = renderGit(session, await window.desk.gitStatus(session.id));
    if (git.untrackPanel.open && git.status.kind === 'ready') loadTrackedGitPaths(session);
    git.message.textContent = error || gitSuccess[action] || notice;
    git.controls.disabled = false;
  } catch (failure) {
    git.message.textContent = [error, readableError(failure)].filter(Boolean).join(' ');
  } finally {
    git.busy = git.refresh.disabled = false;
  }
}

function runGitAction(session, action, data) {
  return refreshGit(session, action, data);
}
