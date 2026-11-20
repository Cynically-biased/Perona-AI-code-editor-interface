# Perona

Perona is a Windows desktop workspace for **Codex CLI** and **Claude Code**. Run multiple agent chats in the same project, edit files, review changes, and preview your local site from one window.

[Download the latest Windows release](https://github.com/Cynically-biased/Perona-AI-code-editor-interface/releases/latest)

## Install and open your first project

1. Download and run the Windows x64 installer named `Perona.Setup.<version>.x64.exe`.
2. Install [Codex CLI](https://developers.openai.com/codex/cli/) or [Claude Code](https://code.claude.com/docs/en/setup) and make sure the Windows executable is on your PATH. Sign in through the agent CLI with your own account.
3. Install the native Windows build of [tmux](https://tmux.app/).

   ```powershell
   winget install --id arndawg.tmux-windows --exact
   ```

4. Open Perona and click **+ New** under Codex or Claude. New projects start in Documents. Use **Change folder** to select your project directory.

You can also drop a folder from File Explorer onto the **Codex** or **Claude** section to start a project there.

You only need the CLI for the agent you plan to use. Git for Windows is required for the Git tools. XAMPP is optional.

## Work in a project

Use **+ Codex** or **+ Claude** to open another agent chat in the same project folder. Each chat has its own **Chat**, **Workflow**, and **Terminal** tabs. Switching projects or tabs keeps background sessions running while Perona is open. Since agents in the same project share files, coordinate edits if two chats are working in the same area.

Drag tabs or a tab bar to another pane or to one of its edges to split the workspace. Drag a divider to resize a split. Perona saves the layout, project folders, and chat list locally. It can reopen conversations saved by the CLI. Quitting Perona ends live jobs.

| Tab | What you can do |
| --- | --- |
| **Chat** | Use the agent's native CLI for prompts, approvals, sign-in, and commands such as `/model`. Perona checks for CLI updates when opening the first chat for each agent. **Update agent** runs the CLI updater and reopens the conversation. |
| **Workflow** | See recorded commands, tool calls, file changes, and progress. |
| **Files** | Browse folders, edit code in Monaco, and create, rename, move, or delete entries. Git-ignored items appear muted. Drag files between folders. The editor supports UTF-8 and BOM-marked UTF-16 text files up to 2 MB. |
| **Changes** | Review local Git status and diffs. |
| **Git** | Initialize Git, stage and commit changes, add a remote, fetch, pull, and push. To publish a new project, create the repository on GitHub or GitLab and paste its clone URL into Perona. |
| **Preview** | Open a localhost page or a local hosts-file alias. **Use project URL** detects supported XAMPP project URLs. |
| **Terminal** | Run shell commands in the project folder. Perona uses fish through Git Bash when available, or through MSYS2. Select **Install fish** if fish is missing. |

### Chat shortcuts

| Shortcut | Action |
| --- | --- |
| **Enter** | Send the prompt. |
| **Shift+Enter** or **Ctrl+Enter** | Insert a line break. |
| **Ctrl+C** | Copy selected text. |
| **Ctrl+V** | Paste text. |
| **Mouse wheel** | Read earlier terminal output while keeping the live prompt available. Scroll all the way down or select **Scroll to bottom** above the prompt to return to live output. |

Use **Ctrl+S** to save an open file in the editor.

In **Git → Remove from Git**, choose a tracked path to stage its removal while keeping its local copy. Commit and push to remove it from the current remote branch. Add the path to `.gitignore` if it should stay untracked.

Drop files or folders from File Explorer onto the **Files** tab to copy them into the project root, or onto a folder in the tree to copy them there. If the destination already contains an item with that name, choose **Replace** or **Skip**. Replacing a folder replaces all its contents.

### Sidebar and extras

- **Agent usage** shows provider-reported account limits and charts for the last 24 hours and seven days. Click either agent's name to collapse its section. The charts collect readings while Perona is open. Claude refreshes usage after a supported reply in Perona.
- **Agents** in the title bar lists open conversations and lets you jump to a session.
- **Services** manages Apache, MariaDB/MySQL, FileZilla, Mercury, and Tomcat for XAMPP installed at `C:\xampp`. Service controls use your Windows permissions. Tomcat requires Java.
- **Chibi Perona** reacts to activity and can be dragged around the interface, including over the Preview. Right-click her and choose **Stay here** to pause roaming while keeping her idle animations and reactions.

## Update Perona

The installed app checks GitHub Releases at startup. You can also select **Check for updates** in the title bar. When the download is ready, choose **Restart to update**. If you’re on a build without the updater, install the latest release once to enable it.

To roll back, select **Versions** next to the update button, choose an earlier version, and select **Download**. Choose **Restart to downgrade** when it’s ready. The picker lists releases that include the Windows installer and in-app update metadata.

## Develop locally

On Windows, install Node.js and npm, then run these commands from the repository folder.

```powershell
npm ci
npm start
```

Build the Windows installer locally without publishing it.

```powershell
npm run build:win -- --publish never
```

Build output goes to `dist/`. The unpacked app is at `dist/win-unpacked/Perona.exe` and needs the files alongside it. The repository excludes generated builds, local shortcuts, and installed dependencies.

For a release, bump the version, build once, and publish the matching `v<version>` tag. Attach the installer, its `.blockmap` file, and `latest.yml` from that same build so installed copies can update.

## Artwork

The app portrait is cropped from the official ONE PIECE CARD GAME [Perona EB05-043 parallel card](https://www.onepiece-cardgame.com/images/cardlist/card/EB05-043_p1.png).
