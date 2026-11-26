const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');

// Keep the original window state in the helper. Closing its input restores the window.
const script = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using System.Threading;

public static class PeronaDock {
    [StructLayout(LayoutKind.Sequential)]
    struct Rect { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint command);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] static extern IntPtr GetWindowDpiAwarenessContext(IntPtr h);
    [DllImport("user32.dll")] static extern bool AreDpiAwarenessContextsEqual(IntPtr a, IntPtr b);
    [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out Rect rect);
    [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr h, out Rect rect);
    [DllImport("user32.dll", EntryPoint="GetWindowLongW")] static extern int GetStyle(IntPtr h, int index);
    [DllImport("user32.dll", EntryPoint="SetWindowLongW", SetLastError=true)]
    static extern int SetStyle(IntPtr h, int index, int value);
    [DllImport("user32.dll", SetLastError=true)] static extern IntPtr SetParent(IntPtr child, IntPtr parent);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr order, int x, int y, int w, int height, uint flags);
    [DllImport("user32.dll")] static extern bool ShowWindowAsync(IntPtr h, int command);
    delegate bool WindowVisitor(IntPtr handle, IntPtr state);
    [DllImport("user32.dll")] static extern bool EnumWindows(WindowVisitor visitor, IntPtr state);

    public static long FindWindow(uint pid, int waitSeconds, Task<string> input) {
        for (int attempt = 0; attempt < waitSeconds * 10 && !input.IsCompleted; attempt++) {
            IntPtr found = IntPtr.Zero;
            EnumWindows((handle, state) => {
                if (!SameWindow(handle, pid) || !IsWindowVisible(handle) || GetWindow(handle, 4) != IntPtr.Zero) return true;
                Rect area;
                if (!GetClientRect(handle, out area) || area.Right < 100 || area.Bottom < 100) return true;
                found = handle;
                return false;
            }, IntPtr.Zero);
            if (found != IntPtr.Zero) return found.ToInt64();
            Thread.Sleep(100);
        }
        throw new InvalidOperationException("The game did not open a compatible window. Select the game executable directly and run it in windowed mode.");
    }

    static bool SameWindow(IntPtr handle, uint pid) {
        uint current;
        return IsWindow(handle) && GetWindowThreadProcessId(handle, out current) != 0 && current == pid;
    }

    public static void Run(uint gamePid, long parentId, int waitSeconds) {
        var input = Task.Run(() => Console.ReadLine());
        var child = new IntPtr(FindWindow(gamePid, waitSeconds, input));
        var parent = new IntPtr(parentId);
        uint childPid, parentPid;
        GetWindowThreadProcessId(child, out childPid);
        GetWindowThreadProcessId(parent, out parentPid);
        if (childPid != gamePid || parentPid == 0 || childPid == parentPid ||
            GetAncestor(child, 2) != child || GetWindow(child, 4) != IntPtr.Zero ||
            !IsWindowVisible(child) || IsIconic(child) || IsZoomed(child))
            throw new InvalidOperationException("Choose a visible, restored app or game window.");
        var dpi = GetWindowDpiAwarenessContext(parent);
        if (!AreDpiAwarenessContextsEqual(dpi, GetWindowDpiAwarenessContext(child)))
            throw new InvalidOperationException("This window uses a different Windows DPI mode and cannot be docked safely.");
        SetThreadDpiAwarenessContext(dpi);
        Rect original;
        if (!GetWindowRect(child, out original)) throw new InvalidOperationException("The selected window is unavailable.");
        const int index = -16, childStyle = 0x40000000;
        const uint noActivate = 0x0010, frameChanged = 0x0020, noZOrder = 0x0004;
        int style = GetStyle(child, index);
        bool docked = false;
        try {
            int embedded = (style & ~unchecked((int)0x80CF0000)) | childStyle;
            if (SetStyle(child, index, embedded) == 0 || GetStyle(child, index) != embedded)
                throw new InvalidOperationException("Windows denied access to move this application.");
            SetParent(child, parent);
            docked = GetAncestor(child, 1) == parent;
            if (!docked) throw new InvalidOperationException("Windows could not dock this application.");
            ShowWindowAsync(child, 0);
            Console.WriteLine("READY");
            while (SameWindow(child, childPid) && SameWindow(parent, parentPid)) {
                while (!input.Wait(250)) {
                    if (!SameWindow(child, childPid) || !SameWindow(parent, parentPid)) return;
                }
                var line = input.Result;
                if (line == null) break;
                input = Task.Run(() => Console.ReadLine());
                if (line == "hide") {
                    ShowWindowAsync(child, 0);
                    continue;
                }
                var fields = line.Split(' ');
                Rect area;
                if (fields.Length != 4 || !GetClientRect(parent, out area)) continue;
                int x = (int)((long)int.Parse(fields[0]) * area.Right / 100000);
                int y = (int)((long)int.Parse(fields[1]) * area.Bottom / 100000);
                int w = (int)((long)int.Parse(fields[2]) * area.Right / 100000);
                int h = (int)((long)int.Parse(fields[3]) * area.Bottom / 100000);
                SetWindowPos(child, IntPtr.Zero, x, y, Math.Max(1, w), Math.Max(1, h),
                    noActivate | frameChanged | 0x0040);
            }
        } finally {
            if (SameWindow(child, childPid)) {
                if (docked) SetParent(child, IntPtr.Zero);
                if (GetStyle(child, index) != style) SetStyle(child, index, style);
                SetWindowPos(child, IntPtr.Zero, original.Left, original.Top,
                    original.Right - original.Left, original.Bottom - original.Top,
                    noActivate | frameChanged | noZOrder | 0x0040);
            }
        }
    }
}
'@
try { [PeronaDock]::Run($gamePid, $parentId, $waitSeconds) }
catch { [Console]::WriteLine('ERROR ' + $_.Exception.GetBaseException().Message); exit 1 }
`;

function createNativeWindowDock(window, notify) {
  let active;
  async function stop() {
    const dock = active;
    if (!dock) return;
    dock.stopping = true;
    dock.child.stdin.end();
    await dock.closed;
  }
  return {
    get active() { return Boolean(active); },
    stop,
    start(pid, waitSeconds) {
      if (active) throw new Error('Wait for the previous window to undock.');
      if (!Number.isInteger(pid) || pid <= 0) throw new Error('The game process could not be started.');
      const handle = window.getNativeWindowHandle().readBigInt64LE();
      const command = '$gamePid=' + pid + ';$parentId=' + handle + ';$waitSeconds=' + waitSeconds + '\n' + script;
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
        Buffer.from(command, 'utf16le').toString('base64')], { windowsHide: true });
      const dock = { child, stopping: false };
      active = dock;
      child.stdin.on('error', () => {});
      child.stderr.resume();
      dock.closed = new Promise(resolve => child.once('close', () => {
        active = undefined;
        if (dock.ready && !dock.stopping) notify();
        resolve();
      }));
      return new Promise((resolve, reject) => {
        const lines = createInterface({ input: child.stdout });
        lines.on('line', line => {
          if (line === 'READY') {
            dock.ready = true;
            resolve();
          } else if (line.startsWith('ERROR ')) reject(new Error(line.slice(6)));
        });
        child.once('error', reject);
        dock.closed.then(() => reject(new Error('The native window could not be docked.')));
      });
    },
    layout(bounds) {
      if (!active?.ready || active.stopping) return;
      if (bounds !== null && (!Array.isArray(bounds) || bounds.length !== 4 ||
          !bounds.every(value => Number.isInteger(value) && value >= 0 && value <= 100000))) return;
      const line = bounds === null ? 'hide' : bounds.join(' ');
      if (active.lastLayout === line) return;
      active.lastLayout = line;
      active.child.stdin.write(line + '\n');
    }
  };
}

function createNativePlaytest(window, notify) {
  let active;
  const dock = createNativeWindowDock(window, () => finish(active, 'The game window closed.'));

  function finish(run, message) {
    if (!run || active !== run) return;
    if (!run.stopping) {
      run.stopping = (async () => {
        try {
          await dock.stop();
        } finally {
          if (run.game.exitCode === null && !run.game.signalCode) run.game.kill();
          await run.closed;
          if (active === run) active = undefined;
          if (message) notify(run.id, message);
        }
      })();
    }
    return run.stopping;
  }

  return {
    get active() { return Boolean(active); },
    async start(id, executable, cwd, waitSeconds = 12, args = [], docked = true) {
      if (active) throw new Error('Stop the current desktop playtest first.');
      const game = spawn(executable, args, { cwd, stdio: 'ignore', windowsHide: false });
      const run = { id, game, closed: new Promise(resolve => game.once('close', resolve)) };
      active = run;
      game.on('error', () => {});
      game.once('exit', () => { if (run.ready) finish(run, 'The game exited.'); });
      try {
        if (!game.pid) await new Promise((resolve, reject) => {
          game.once('spawn', resolve);
          game.once('error', reject);
        });
        if (run.stopping) return;
        if (docked) await dock.start(game.pid, waitSeconds);
        if (run.stopping) return;
        if (game.exitCode !== null || game.signalCode) throw new Error('The game exited before preview was ready.');
        run.ready = true;
      } catch (error) {
        await finish(run);
        throw error;
      }
    },
    layout(id, bounds) {
      if (active?.id === id) dock.layout(bounds);
    },
    stop(id) {
      if (id === undefined || active?.id === id) return finish(active);
    }
  };
}

module.exports = { createNativePlaytest };
