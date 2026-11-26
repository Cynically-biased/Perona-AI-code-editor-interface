const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');

// Keep the original window state in the helper. Closing its input restores the window.
const script = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Threading.Tasks;

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

    static bool SameWindow(IntPtr handle, uint pid) {
        uint current;
        return IsWindow(handle) && GetWindowThreadProcessId(handle, out current) != 0 && current == pid;
    }

    public static void Run(long childId, long parentId) {
        var child = new IntPtr(childId);
        var parent = new IntPtr(parentId);
        uint childPid, parentPid;
        GetWindowThreadProcessId(child, out childPid);
        GetWindowThreadProcessId(parent, out parentPid);
        if (childPid == 0 || parentPid == 0 || childPid == parentPid ||
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
                var input = Task.Run(() => Console.ReadLine());
                while (!input.Wait(250)) {
                    if (!SameWindow(child, childPid) || !SameWindow(parent, parentPid)) return;
                }
                var line = input.Result;
                if (line == null) break;
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
try { [PeronaDock]::Run($childId, $parentId) }
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
    start(id) {
      if (active) throw new Error('Wait for the previous window to undock.');
      const match = /^window:(-?\d+):\d+$/.exec(id);
      if (!match) throw new Error('The selected window cannot be docked.');
      const handle = window.getNativeWindowHandle().readBigInt64LE();
      const command = '$childId=' + BigInt(match[1]) + ';$parentId=' + handle + '\n' + script;
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

module.exports = { createNativeWindowDock };
