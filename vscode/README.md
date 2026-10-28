# a4sx for VS Code

[a4sx](https://session-exchange.com) is an exchange for AI coding-agent sessions. You can save your sessions to your a4sx library and find sessions that others publish on the a4sx marketplace.

This extension connects VS Code to a4sx. It adds:

- **The a4sx sidebar.** Click the a4sx icon in the activity bar.
  - **Sign in to a4sx.** Your browser opens the a4sx sign-in page. Check that it shows the same code as VS Code, then confirm. VS Code keeps the resulting key in its secret storage. The key can read your library and your launch profiles. It can also rename your saved sessions, change their tags and move them between folders.
  - **My sessions** lists the sessions in your library, newest first, with their date and size, in folders. For each session you can:
    - **Resume in terminal**. It opens a terminal with your default shell. With the a4sx command-line tool, it runs `a4sx launch` for the session there, and VS Code asks which launch profile to use if you have more than one. Without it, the extension copies the session into Claude Code's local history and runs `claude --resume` there.
    - **Resume in Claude Code**, which copies the session into Claude Code's local history for the open folder and opens it in the Claude Code extension's panel. It doesn't need the a4sx command-line tool. If more than one folder is open, VS Code asks which one. If no folder is open, you can use your home folder or choose one; the window then opens that folder and the session opens there.
    - **Open on the web**.
    - **Copy session id**.
    - **Move to folder…** and **Remove from folder**.
  - **Launch profiles** lists your launch profiles. The default one is marked. You can create, edit and delete profiles.
  - **Meshes** lists the a4sx meshes you're in and your cells in each one. It appears only when your a4sx server has meshes.
  - **Marketplace** searches the sessions that others publish. A result opens on session-exchange.com. You don't need to sign in to search.
- **The a4sx MCP servers for agent mode.** The a4sx tools show up in the tools list of agent mode in VS Code chat.
  - **a4sx** works without an account. You can search sessions and read their summaries.
  - **a4sx library** works with your a4sx account. VS Code asks you to sign in the first time it connects, and VS Code handles that sign-in itself.
- **a4sx: Save this session.** This command runs `a4sx push --latest` in a terminal. It saves your most recently changed local Claude Code session to your a4sx library. The CLI's output and questions appear in the terminal.
- **a4sx: Open my library.** This command opens your library on session-exchange.com in your browser.

## Folders and the filter

In **My sessions**, sessions that are in a folder appear under that folder. Folders can have sub-folders, up to 4 levels, for example `work/a4sx`. Sessions without a folder appear at the top level.

- **Move to folder…** puts a session in a folder. Pick an existing folder, or choose **New folder…** and type a path.
- **Remove from folder** moves the session back to the top level.
- **Filter** (in the view's title bar) shows only the sessions whose title, name, id, tags or folder contain the text you type. Upper and lower case don't matter. The results are a flat list, and each session shows its folder. **Clear filter** shows all sessions again.

Folders need a newer a4sx server. On an older server, all sessions appear at the top level and the folder actions are hidden.

## Launch profiles

A launch profile says how `a4sx launch` starts a session: the model, the server address (`base_url`), the harness and extra flags. The extension never shows or stores an API key; keep keys out of profile flags and headers. In the list and in **Edit**, flags that look like a key or token are shown as `••••`. Newer a4sx servers show only a few known settings here. The tooltip and **Edit** say how many other settings are hidden; they stay as they are, and you change them with the a4sx CLI or on the website. If a4sx refuses a change, **Edit** stays open with the server's message.

- **Create launch profile** (the + button) asks for an id, a name and a model. The new profile has no flags.
- **Edit** can change the name and the model. The flags, the server address (shown as `scheme://host[:port]`), harness, router and headers are shown but can't be changed here. Choose one of them to run `a4sx profile` in a terminal or open the launch profiles page on the website. Header names and values are not shown, only how many there are.
- The default can only be changed with the a4sx CLI or on the website. **Change default with the a4sx CLI or on the website** offers both.
- **Delete** asks you to confirm first. It is offered only for a profile that holds nothing but a name and a model and isn't the default. Other profiles can only be deleted with the a4sx CLI or on the website; their tooltip says so.
- If a4sx refuses a change, the extension shows the server's message and changes nothing.

The first time you change a profile, the extension asks for one more permission (`profiles:write`). Your browser opens a new sign-in that names it. The extension keeps using your current key until the new one arrives. Then it replaces the old key and asks the a4sx server to revoke it.

On an older a4sx server, the view shows "Launch profiles need a newer a4sx server." and the profile actions are hidden.

## Meshes

The **Meshes** view lists your meshes. Under each mesh are your cells in it: their status, presence, reach and when they were last seen (rounded to 5 minutes). If your cells in a mesh run on more than one machine, they are grouped by machine. A cell's tooltip shows its isolation tier (a, b or c), as the cell reports it itself. A Windows host on tier c appears as one machine per mesh; its tooltip says so. A cell waiting for approval shows "Waiting for approval". The cells are read when the view is shown or a mesh is expanded, then every 30 seconds while the view is visible. **Refresh meshes** refreshes it right away. The view lists only the meshes you're a member of. A mesh that isn't active (archived, merged or deleted) shows its status and offers only **Open in browser**. If your meshes don't fit in 20 pages, the view says so; the website shows all of them. If your a4sx server doesn't list cells yet, the view shows your meshes and the line "Cells appear here once your server supports it."

- **Start session in mesh** (on a mesh) asks for a name, then runs `a4sx launch --ipc-proxy --mesh <id> --as <name>` in a new terminal. It needs the a4sx command-line tool, which signs in on its own. First the extension asks the CLI how this host can isolate the mesh key (`a4sx launch --mesh <id> --preflight --json`). With the sandbox or a separate proxy user, the session starts. With reduced isolation, a warning explains the risk, and only **Start with reduced isolation** adds `--mesh-reduced-isolation` to that one start; nothing is remembered. With no isolation available, the start is refused and the setup guide is offered. The name may use 1-48 lowercase letters, digits and `-`, and must start and end with a letter or digit.
- **Open in browser** (on a mesh) opens the mesh's page on the website. Creating a mesh, redeeming an invite and every other change happen on the website: **Create a mesh in the browser** and **Redeem a mesh invite in the browser** are in the view's title bar.
- The view needs the permission `mesh:read`. If your key doesn't have it yet, the view shows **Allow mesh read**, which opens a new browser sign-in that asks for it. The extension never asks for any other mesh permission.
- If the website must be opened first, the view says so and offers **Open in browser**.

The view is hidden when you're signed out, or when your a4sx server has no meshes. If your sign-in is no longer valid, the extension signs you out, as **My sessions** does.

## Signing out

To sign out, run **a4sx: Sign out**. The extension asks the a4sx server to revoke the key, then removes the key from VS Code. If the server can't be reached, the key is still removed from VS Code, and it stays valid until it expires or you revoke it on session-exchange.com under Account › Agent keys.

## Requirements

- VS Code 1.101 or later. The MCP servers are used by agent mode in VS Code chat.
- For **Save this session** and for launch profiles in **Resume in terminal**: the a4sx command-line tool, installed and signed in with `a4sx login`. See the [install guide](https://session-exchange.com/guide/cli). The extension looks for `a4sx` on your `PATH`, then in `~/.local/bin`, `/usr/local/bin` and `/opt/homebrew/bin`. The first time you resume in a terminal without it, the extension offers to install it.
- For **Resume in terminal** without the a4sx command-line tool: Claude Code's `claude` command. The extension looks for it on your `PATH`, then in the same folders and in `~/.claude/local`.
- For **Resume in Claude Code**: the Claude Code extension. The resumed session runs on the Claude Code extension's own sign-in, not on your a4sx launch profile or router.
- For resuming without the a4sx command-line tool: sign in to a4sx in the sidebar. The extension copies the session with that sign-in.

Saving and resuming work for Claude Code sessions.

In a remote window (SSH, WSL, dev containers, Codespaces), the a4sx extension usually runs on the remote machine. Resuming copies the session into Claude Code's history on that machine, and **Resume in terminal** runs `claude` there. **Save this session** and launch profiles need the a4sx command-line tool installed and signed in on that machine too.

## Settings

| Setting | Description |
|---|---|
| `a4sx.cliPath` | Full path to the `a4sx` command, if the extension can't find it. Can only be set in your user settings. |
| `a4sx.serverUrl` | The a4sx server the sidebar signs in to. The default is session-exchange.com. Can only be set in your user settings. |

## Network use

The sidebar connects to session-exchange.com (or your `a4sx.serverUrl`) to sign you in, list and file your sessions, manage your launch profiles and search the marketplace. When you're signed in, it asks the server whether it has meshes: one request (`GET /meshes`) when a window opens, after each sign-in and when `a4sx.serverUrl` changes, retried at most 5 times over about 13 minutes if the server can't be reached. Your cells are read only when the **Meshes** view is shown or a mesh is expanded, then every 30 seconds while the view is visible; when the server is busy, the extension waits longer, as long as the server asks, up to 5 minutes. It sends no telemetry. VS Code connects to session-exchange.com when agent mode uses the a4sx MCP servers. **Resume in Claude Code**, and **Resume in terminal** without the a4sx command-line tool, download the session from session-exchange.com with the sidebar's sign-in. **Save this session**, and **Resume in terminal** with the a4sx command-line tool, run that tool, which uses its own sign-in. When a window opens and your sign-in can't read launch profiles yet, the extension asks the server once whether it offers them, to know whether to ask for that permission.
