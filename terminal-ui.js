function terminalFontSize() {
  const size = Number(localStorage.getItem('perona-terminal-font'));
  return Number.isInteger(size) && size >= 10 && size <= 24 ? size : 13;
}

function updateTerminalFont(terminal, body, fit, size) {
  terminal.options.fontSize = size;
  fitTerminal(body, fit);
}

function createTerminal({ cursorBlink = true, readOnly = false, allowInterrupt = true } = {}) {
  const terminal = new Terminal({
    cursorBlink, fontFamily: 'Cascadia Mono, Consolas, monospace',
    fontSize: terminalFontSize(), scrollback: 5000,
    disableStdin: readOnly,
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
    if (!event.ctrlKey || event.altKey || event.metaKey || event.isComposing
        || !['KeyC', 'KeyV'].includes(event.code)) return true;
    const copy = event.code === 'KeyC';
    if (copy && allowInterrupt && !readOnly && !event.shiftKey && !terminal.hasSelection()) return true;
    event.preventDefault();
    if (event.type === 'keydown') {
      if (copy) copyTerminalSelection(terminal);
      else if (!readOnly) pasteIntoTerminal(terminal);
    }
    return false;
  });
  return { terminal, fit };
}

function copyTerminalSelection(terminal) {
  const selection = terminal.getSelection();
  if (selection) window.desk.copyTerminalText(selection).catch(setError);
}

function pasteIntoTerminal(terminal) {
  window.desk.readTerminalClipboard().then(text => {
    if (text && terminal.element?.isConnected) terminal.paste(text);
  }).catch(setError);
}

function configureChatInput(session) {
  const { body, terminal } = session;
  const jump = document.createElement('button');
  jump.type = 'button';
  jump.className = 'jump-to-present';
  jump.textContent = '↓ Scroll to bottom';
  jump.hidden = true;
  const history = document.createElement('div');
  history.className = 'chat-scrollback';
  history.setAttribute('aria-label', 'Earlier terminal output');
  history.hidden = true;
  body.append(history, jump);
  let request = 0;
  let pendingScroll = 0;
  let redraw;
  let viewer;
  let browsing = false;
  session.updateHistoryFont = size => {
    if (!viewer) return;
    viewer.terminal.options.fontSize = size;
    if (!history.hidden) layoutHistory();
  };

  function promptRow() {
    const buffer = terminal.buffer.active;
    // Look near the live footer so old prompts in the transcript do not anchor it.
    for (let row = terminal.rows - 1; row >= Math.max(0, terminal.rows - 16); row--) {
      const line = buffer.getLine(buffer.baseY + row)?.translateToString(true) ?? '';
      if (/^\s*[›❯](?:\s|$)/.test(line)) return Math.max(0, row - 1);
    }
    return Math.max(0, terminal.rows - 6);
  }

  function layoutHistory() {
    const screen = terminal.element?.querySelector('.xterm-screen');
    const height = screen?.getBoundingClientRect().height ?? 0;
    const boundary = Math.max(0, Math.min(terminal.rows - 2, promptRow())) * height / terminal.rows + 'px';
    history.style.height = jump.style.top = boundary;
    if (viewer) fitTerminal(history, viewer.fit);
  }

  function closeHistory() {
    request++;
    browsing = false;
    history.hidden = jump.hidden = true;
    pendingScroll = 0;
  }
  jump.addEventListener('click', () => {
    closeHistory();
    terminal.focus();
  });
  session.onChatOutput = () => {
    clearTimeout(redraw);
    redraw = setTimeout(() => {
      session.readyPrompt = promptReady(session);
      updateWorkspaceState(session);
      if (!history.hidden) layoutHistory();
    }, 160);
  };
  const resize = terminal.onResize(() => {
    if (!history.hidden) layoutHistory();
  });

  async function openHistory() {
    const current = ++request;
    try {
      const output = await window.desk.chatScrollback(session.id, promptRow() - 1);
      if (current !== request) return;
      history.style.visibility = 'hidden';
      history.hidden = false;
      layoutHistory();
      if (!viewer) {
        viewer = createTerminal({ cursorBlink: false, readOnly: true });
        viewer.terminal.open(history);
        viewer.terminal.onScroll(() => {
          if (browsing && viewer.terminal.buffer.active.viewportY >= viewer.terminal.buffer.active.baseY) closeHistory();
        });
      }
      fitTerminal(history, viewer.fit);
      viewer.terminal.reset();
      // A capture is display data. Replay only text, line breaks and SGR color/style codes.
      const printable = output.replace(/\x1b\[[0-9;:]*m|[\x00-\x1f\x7f-\x9f]/g,
        token => token.startsWith('\x1b[') || token === '\n' ? token : '');
      await new Promise(resolve => viewer.terminal.write(printable.trimEnd().replaceAll('\n', '\r\n') + '\x1b[0m\x1b[?25l', resolve));
      if (current !== request) return;
      viewer.terminal.scrollToBottom();
      viewer.terminal.scrollLines(-Math.max(1, Math.ceil(-pendingScroll / 16)));
      const buffer = viewer.terminal.buffer.active;
      if (buffer.viewportY >= buffer.baseY) closeHistory();
      else {
        browsing = true;
        history.style.visibility = '';
        jump.hidden = false;
      }
    } catch (error) {
      if (current === request) {
        closeHistory();
        if (session.running) setError(error);
      }
    } finally {
      if (current === request) pendingScroll = 0;
    }
  }
  const onWheel = event => {
    if (!event.deltaY) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? body.clientHeight : 1);
    if (browsing) {
      viewer.terminal.scrollLines(Math.sign(delta) * Math.max(1, Math.ceil(Math.abs(delta) / 16)));
      if (viewer.terminal.buffer.active.viewportY >= viewer.terminal.buffer.active.baseY) closeHistory();
    } else if (session.running && (pendingScroll || delta < 0)) {
      const opening = pendingScroll !== 0;
      pendingScroll = Math.min(0, pendingScroll + delta);
      if (!pendingScroll) closeHistory();
      else if (!opening) openHistory();
    }
  };
  const onKeyDown = event => {
    if (history.contains(event.target)) {
      if (event.key === 'Escape') jump.click();
      return;
    }
    if (event.altKey || event.metaKey || event.isComposing) return;
    if (event.key !== 'Enter' || (!event.shiftKey && !event.ctrlKey)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (session.running) window.desk.newlineChat(session.id).catch(setError);
  };
  session.body.addEventListener('wheel', onWheel, { capture: true, passive: false });
  session.body.addEventListener('keydown', onKeyDown, true);
  session.disposeChatInput = () => {
    clearTimeout(redraw);
    closeHistory();
    viewer?.terminal.dispose();
    resize.dispose();
    session.body.removeEventListener('wheel', onWheel, true);
    session.body.removeEventListener('keydown', onKeyDown, true);
  };
}

function fitTerminal(body, fit) {
  if (!body.clientWidth || !body.clientHeight) return;
  const dimensions = fit.proposeDimensions();
  if (dimensions?.rows >= 2 && dimensions.cols <= 1000 && dimensions.rows <= 1000) fit.fit();
}

function observeTerminalSize(body, fit) {
  let pending;
  const observer = new ResizeObserver(() => {
    clearTimeout(pending);
    // Let docking and window resize settle before reflowing terminal history.
    pending = setTimeout(() => fitTerminal(body, fit), 80);
  });
  observer.observe(body);
  return { disconnect() {
    clearTimeout(pending);
    observer.disconnect();
  } };
}

function configureProjectShell(session) {
  const panel = session.view.dockPanels.get('terminal');
  const body = panel.querySelector('.project-shell-body');
  const status = panel.querySelector('.project-shell-status');
  const backend = panel.querySelector('.project-shell-backend');
  const start = panel.querySelector('.project-shell-start');
  const { terminal, fit } = createTerminal();
  const shell = { terminal, fit, body, start, status, backend, state: 'new' };
  session.shell = shell;
  terminal.open(body);
  shell.observer = observeTerminalSize(body, fit);
  terminal.onData(data => {
    if (shell.state === 'running') window.desk.projectShellInput(session.id, data).catch(setError);
  });
  terminal.onResize(({ cols, rows }) => {
    if (shell.state === 'running') window.desk.projectShellResize(session.id, cols, rows).catch(setError);
  });
  start.addEventListener('click', () => {
    if (shell.state === 'missing') installProjectFish(session);
    else startProjectShell(session, true);
  });
}

async function installProjectFish(session) {
  const { shell } = session;
  shell.state = 'installing';
  shell.start.disabled = true;
  shell.status.textContent = 'Installing Fish, Fisher, and zoxide for Git Bash…';
  try {
    await window.desk.installFish();
    if (sessions.get(session.id) !== session) return;
    shell.state = 'new';
    await startProjectShell(session, true);
  } catch (error) {
    shell.state = 'missing';
    shell.status.textContent = readableError(error);
  } finally {
    shell.start.disabled = false;
  }
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
    const result = await window.desk.startProjectShell(session.chat.id, session.id, session.agent, cols, rows);
    if (shell.state !== 'starting' || sessions.get(session.id) !== session) return;
    if (result?.missingFish) {
      shell.state = 'missing';
      shell.status.textContent = 'Fish is missing. Install it for Git Bash.';
      shell.start.textContent = 'Install fish';
      shell.start.hidden = false;
      return;
    }
    shell.state = 'running';
    shell.backend.textContent = result?.backend ?? '';
    shell.start.textContent = 'Start shell';
    shell.status.textContent = '';
    if (cols !== shell.terminal.cols || rows !== shell.terminal.rows) {
      await window.desk.projectShellResize(session.id, shell.terminal.cols, shell.terminal.rows);
    }
    if (shell.focusOnStart && activeChat?.current === session && isViewVisible(session.view, 'terminal')) shell.terminal.focus();
  } catch (error) {
    shell.state = 'ended';
    shell.start.textContent = 'Start shell';
    shell.status.textContent = readableError(error);
    shell.start.hidden = false;
  }
}

window.desk.onProjectShellData((id, data) => sessions.get(id)?.shell?.terminal.write(data));
window.desk.onProjectShellExit((id, code) => {
  const shell = sessions.get(id)?.shell;
  if (!shell) return;
  shell.state = 'ended';
  shell.start.textContent = 'Start shell';
  shell.status.textContent = code ? 'Shell exited with code ' + code : 'Shell exited';
  shell.start.hidden = false;
});
