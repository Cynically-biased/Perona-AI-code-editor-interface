function createTerminal(size = {}) {
  const terminal = new Terminal({
    ...size,
    cursorBlink: true, fontFamily: 'Cascadia Mono, Consolas, monospace',
    fontSize: 13, scrollback: 5000,
    theme: {
      background: '#1b121a', foreground: '#fff0e7', cursor: '#ff91c1',
      cursorAccent: '#1b121a', selectionBackground: '#f6aacb', selectionForeground: '#2a192b',
      black: '#1b121a', red: '#ff9da9', green: '#c2dda9', yellow: '#f6d0a8',
      blue: '#c6b5ef', magenta: '#ffa8d7', cyan: '#b9ded6', white: '#f3dce9',
      brightBlack: '#b9a1bd', brightRed: '#ffbdc6', brightGreen: '#d1efb9',
      brightYellow: '#ffe4c6', brightBlue: '#ded0ff', brightMagenta: '#ffcae6',
      brightCyan: '#d0f0e8', brightWhite: '#fff8f2',
      scrollbarSliderBackground: '#b96c9a55', scrollbarSliderHoverBackground: '#b96c9a99',
      scrollbarSliderActiveBackground: '#e995bd'
    }
  });
  const fit = new FitAddon.FitAddon();
  terminal.loadAddon(fit);
  terminal.attachCustomKeyEventHandler(event => {
    if (!event.ctrlKey || !event.shiftKey || !['KeyC', 'KeyV'].includes(event.code)) return true;
    if (event.type === 'keydown') {
      event.preventDefault();
      if (event.code === 'KeyC') {
        const selection = terminal.getSelection();
        if (selection) navigator.clipboard.writeText(selection).catch(setError);
      } else {
        navigator.clipboard.readText().then(text => terminal.paste(text)).catch(setError);
      }
    }
    return false;
  });
  return { terminal, fit };
}

function fitTerminal(body, fit) {
  if (body.clientWidth && body.clientHeight) fit.fit();
}

function configureProjectShell(session) {
  const panel = session.view.dockPanels.get('terminal');
  const body = panel.querySelector('.project-shell-body');
  const status = panel.querySelector('.project-shell-status');
  const start = panel.querySelector('.project-shell-start');
  const { terminal, fit } = createTerminal();
  const shell = { terminal, fit, body, start, status, state: 'new' };
  session.shell = shell;
  terminal.open(body);
  shell.observer = new ResizeObserver(() => fitTerminal(body, fit));
  shell.observer.observe(body);
  terminal.onData(data => {
    if (shell.state === 'running') window.desk.projectShellInput(session.id, data).catch(setError);
  });
  terminal.onResize(({ cols, rows }) => {
    if (shell.state === 'running') window.desk.projectShellResize(session.id, cols, rows).catch(setError);
  });
  start.addEventListener('click', () => startProjectShell(session, true));
}

function showProjectShell(session, focus = false) {
  if (!session.view.dockReady) return;
  if (!session.shell) configureProjectShell(session);
  const { shell } = session;
  if (shell.state === 'new') startProjectShell(session, focus);
  else if (shell.state === 'starting') shell.focusOnStart ||= focus;
  else if (focus && shell.state === 'running') shell.terminal.focus();
}

async function startProjectShell(session, focus = false) {
  const { shell } = session;
  if (shell.state === 'starting' || shell.state === 'running') return;
  shell.state = 'starting';
  shell.focusOnStart = focus;
  shell.start.hidden = true;
  shell.status.textContent = 'Starting…';
  shell.terminal.reset();
  fitTerminal(shell.body, shell.fit);
  const { cols, rows } = shell.terminal;
  try {
    await window.desk.startProjectShell(session.chat.id, session.id, session.agent, cols, rows);
    if (shell.state !== 'starting' || sessions.get(session.id) !== session) return;
    shell.state = 'running';
    shell.status.textContent = '';
    if (cols !== shell.terminal.cols || rows !== shell.terminal.rows) {
      await window.desk.projectShellResize(session.id, shell.terminal.cols, shell.terminal.rows);
    }
    if (shell.focusOnStart && activeChat?.current === session && isViewVisible(session.view, 'terminal')) shell.terminal.focus();
  } catch (error) {
    shell.state = 'ended';
    shell.status.textContent = readableError(error);
    shell.start.hidden = false;
  }
}

window.desk.onProjectShellData((id, data) => sessions.get(id)?.shell?.terminal.write(data));
window.desk.onProjectShellExit((id, code) => {
  const shell = sessions.get(id)?.shell;
  if (!shell) return;
  shell.state = 'ended';
  shell.status.textContent = code ? 'Shell exited with code ' + code : 'Shell exited';
  shell.start.hidden = false;
});
