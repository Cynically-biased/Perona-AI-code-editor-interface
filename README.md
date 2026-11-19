# Perona

Run **Perona.Setup.1.0.0.x64.exe** to install Perona on 64-bit Windows,
then open **Perona** from the Start menu or desktop. The installer bundles
Electron and the editor. Install your chosen agent CLI and tmux separately.
XAMPP is only needed for the Services panel and XAMPP-hosted projects.

For development, run `npm ci` and `npm start`. Run `npm run build:win` to
create the installer in `dist/`. The build also creates
`dist/win-unpacked/Perona.exe`, which runs with the resources in that folder.
Git excludes downloaded dependencies, build output, and local Windows shortcuts.

Use **+ New** under **Codex** or **Claude**. The Windows build starts new chats in Documents.
Use **Change folder** above the terminal to switch the chat to another project.
Each folder gets its own agent conversation. Returning to a previously used
folder shows its original session, and tasks there keep running while hidden.
Use **+ Codex** or **+ Claude** inside a project to open another agent chat
beside the main chat. Side chats have Chat, Workflow, and Terminal and share
the project's working folder. Close a side chat with its own **×**.

Drag a tab to the left, right, top, or bottom edge of any pane to split it
again. Drop it on another pane's tab bar to move or reorder it. Drag a tab
bar, or Shift-drag one of its tabs, to move the whole bar. Drag a chat title
to move all tabs belonging to that chat. Docking spans the whole project.
The **⋯**
menu offers splits in all four directions, moving the active tab, and
merging with an adjacent pane. Drag any divider, or focus it and use the
arrow keys to resize that split. Perona remembers the arrangement per project.

The tabs above each project session keep conversation and project information separate.

- **Chat** is the agent's interactive terminal styled for Perona. Enter
  prompts and slash commands, such as `/model`, directly in the CLI. Sign-in
  prompts and approvals appear here as well.
- **Workflow** shows recorded commands, tool calls, file changes, and progress.
- **Files** browses the session's project folder. Open a text or code file to edit
  it in Monaco with line numbers, syntax highlighting, folding, multiple tabs,
  undo, and search and replace. Use **Save** or Ctrl+S. Use **New file** and
  **New folder** for creation, or the item’s **…** button to rename or move it. Perona keeps your draft if the file changed on
  disk. Copy your edits before using **Reload** to get the latest version.
  Supported UTF-8 and BOM-marked UTF-16 files up to 2 MB are editable.
- **Changes** shows local Git status and diffs. Use **Refresh** after edits.
- **Git** initializes a repository, stages and commits changes, connects a
  remote, and offers fetch, pull, and push. Create a GitHub or GitLab repository
  in the provider's browser page, then paste its clone URL into Perona.
- **Preview** opens the local site for the selected project when its XAMPP
  Apache virtual host, alias, or document-root path can be found. Use **Use
  project URL** to detect it again, or enter a localhost address or
  loopback alias from the Windows hosts file.
- **Terminal** launches fish through Git Bash in the project folder. Install
  Git for Windows with fish available in its `usr/bin` directory.

Use **Agents** in the title bar to see the state of open conversations and jump
to a project session. **Services** opens the XAMPP Control Panel for the
installation at C:\xampp. Apache, MariaDB/MySQL, FileZilla, Mercury, and Tomcat
show status, PIDs, ports, and their Admin, Config, and Logs actions. The panel
also includes Netstat and shortcuts to the XAMPP shell, installation folder,
Windows Services, and XAMPP help.

Service registration and control use your Windows permissions. Tomcat needs
Java. For a standalone MariaDB shutdown, the panel uses XAMPP's configured
client account or the default local root account. Mercury is stopped through its
own window so it can shut down gracefully.

Use **Rename** to label a chat or **×** to close all its project sessions. The CLI
provides sign-in and model selection. Ctrl+Shift+C copies selected terminal text
and Ctrl+Shift+V pastes.

Perona saves its chat list, names, project folders, and selected views locally.
The last selected project resumes when Perona opens. Select another saved
chat or choose a folder from the project dropdown to resume it. Perona
reopens the original Codex or Claude conversation when the CLI has saved it.
Empty chats are kept too. Closing a chat with **×** removes it from Perona's
list. Quitting the app ends live jobs.

## Requirements

- 64-bit Windows. Node.js and npm are only needed to build from source.
- Claude Code and Codex CLI available as Windows executables on PATH.
- The native Windows tmux port. Install it with
  `winget install --id arndawg.tmux-windows --exact`.

## Artwork

The app portrait is cropped from the official ONE PIECE CARD GAME
[Perona EB05-043 parallel card](https://www.onepiece-cardgame.com/images/cardlist/card/EB05-043_p1.png).
