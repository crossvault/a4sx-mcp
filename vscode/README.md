# a4sx for VS Code

[a4sx](https://session-exchange.com) is an exchange for AI coding-agent sessions. You can save your sessions to your a4sx library and find sessions that others publish on the a4sx marketplace.

This extension connects VS Code to a4sx. It adds:

- **The a4sx sidebar.** Click the a4sx icon in the activity bar.
  - **Sign in to a4sx.** Your browser opens the a4sx sign-in page. Check that it shows the same code as VS Code, then confirm. VS Code keeps the resulting key in its secret storage. The key can read your library and your launch profiles. It can also rename your saved sessions, change their tags and move them between folders.
  - **My sessions** lists the sessions in your library, newest first, with their date and size, in folders. For each session you can:
    - **Resume in terminal**. It opens a terminal with your default shell. With the a4sx command-line tool, it runs `a4sx launch` for the session there, and VS Code asks which launch profile to use if you have more than one. Without it, the extension copies the session into Claude Code's local history and runs `claude --resume` there.
    - **Resume in Claude Code**, which copies the session into Claude Code's local history for the open folder and opens it in the Claude Code extension's panel. It doesn't need the a4sx command-line tool. If more than one folder is open, VS Code asks which one. If no folder is open, you can use your home folder or choose one; the window then opens that folder and the session opens there.
    - **Run as cell in terminal**, which runs the session as one of this computer's mesh cells (see [Run as cell in terminal](#run-as-cell-in-terminal)).
    - **Open on the web**.
    - **Copy session id**.
    - **Move to folder…** and **Remove from folder**.
  - **Launch profiles** lists your launch profiles. The default one is marked. You can create, edit, duplicate and delete profiles, and set the default.
  - **Cells** lists the mesh cells stored on this computer by the a4sx command-line tool, grouped by mesh, and your cells in those meshes on other machines. You can start, stop, rename, copy the launch command of, make default or forget a cell here, or start a new one. If the tool isn't installed, the view installs it for you.
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

**With the a4sx CLI 0.25.0 or newer**, the view lists the profiles as the CLI sees them (`a4sx profiles --json`). Expand a profile to see its details: harness, model, base URL (`scheme://host[:port]`), router operator, header names, flags (keys and tokens shown as `••••`), env keys, and how many cells on this computer use it. Header values and env values are never shown; the only header value shown is the router operator (`X-Fleet-Operator`). On these profiles:

- **Edit** works as above.
- **Duplicate…** asks for the copy's id and, optionally, a new router operator, then runs `a4sx profile --copy <id> --name <new id> [--header X-Fleet-Operator=<operator>]`. If the new id is taken, it asks before it replaces that profile (`--force`).
- **Set as default** runs `a4sx profile --set-default <id>`.
- **Delete** asks first (and says how many cells use the profile), then runs `a4sx profile --delete <id>`.

With an older CLI, the view shows a line that offers the update, and lists the profiles from the a4sx server as before.

## Cells

A cell is an agent session that joins one of your meshes from this computer. The **Cells** view lists the cells the a4sx command-line tool has stored here (`a4sx mesh cells --json`), grouped by mesh. Each mesh shows its join policy ("policy: open", "own" or "closed", or "unknown"); cells that aren't in a mesh yet are under **Standalone (no mesh)**. For each cell, the view shows its launch profile, whether it is stored or running on this computer, its state in the mesh registry and how this computer reaches the mesh (path), and marks the default cell with a star. A cell that waits for a mesh admin says so. Under each mesh, your cells on other machines are listed too, read-only ("on another machine", from `a4sx mesh peers <mesh> --json`). The extension reads only these lists: it never reads the cells' keys.

- **Start in terminal** opens a new terminal in your workspace folder and runs `a4sx launch --cell <name> --mesh-reduced-isolation` there. If two stored cells share a name, `--mesh <mesh id>` picks the right one. Signing in, and anything else the CLI asks, happens in that terminal. If more than one folder is open, VS Code asks which one.
- **Stop** (on a cell running on this computer) runs `a4sx mesh cell stop <name>`, after you confirm.
- **Rename…** runs `a4sx mesh cell rename <name> <new name>`.
- **Copy launch command** copies the `a4sx launch --cell …` command, quoted for your default shell.
- **New cell** (in the view's title bar) runs `a4sx launch --new-cell --mesh-reduced-isolation` in a new terminal. The CLI opens your browser, where you approve the new cell, and then starts it in the terminal. The list updates when the cell is stored.
- **Set as default** runs `a4sx mesh cell default <name>`. A bare `a4sx launch --cell` starts the default cell.
- **Forget on this computer** runs `a4sx mesh cell forget <name>`, after you confirm. It removes the cell's key from this computer. The cell stays in your account until you remove it on the website.
- **Open mesh in browser** opens the cell's mesh on the website. A standalone cell isn't in a mesh yet, so it can't be started; add it to a mesh on the website first.

With an a4sx CLI older than 0.25.0, the view lists the cells with a line that offers **Update the a4sx CLI**; running state, registry state, path, other machines' cells, **Stop** and **Rename…** need the update.

**Reduced isolation.** Where this computer can't sandbox your agent, a cell runs as your own user. Your agent could then act as that cell in its mesh, skip the cell's outgoing checks, and read and use the a4sx sign-ins and keys saved on this computer. The first time you start a cell on a computer, a dialog explains this, and the cell starts only if you accept. The answer is remembered for that computer. Where the sandbox works, the cell runs in it and this doesn't apply.

**Claude Code.** If the Claude Code extension is installed, the terminals the view starts tell the a4sx CLI to use the `claude` that comes with that extension (through the `A4SX_CLAUDE` environment variable), unless you set `A4SX_CLAUDE` yourself.

The list is read when the view is first shown, on **Refresh cells**, after each action in the view, when a terminal the view started closes, and when the CLI's cell list changes.

### Run as cell in terminal

**Run as cell in terminal** (on a session in **My sessions**) runs that session as a cell:

1. Choose one of this computer's cells (name · mesh · launch profile), or **New cell…**.
2. Choose the options: **Keep my sign-in (reduced isolation)** (on by default) adds `--mesh-reduced-isolation`. **Deliver messages from mesh peers without asking** (off by default) adds `--auto-allow-ipc-messages`; turning it on shows a warning first.
3. A terminal runs `a4sx launch --cell <cell> [options] -- --resume <session id>` in the folder the session ran in. If the session isn't on this computer, only in your library, it runs `a4sx launch --cell <cell> [options] --a4sx-session=<id>` in your workspace folder instead, which fetches it. **New cell…** runs `a4sx launch --new-cell [options] …`; the browser approval picks the mesh and launch profile.

**Inside an a4sx session.** If VS Code itself was started inside an a4sx session (`A4SX_HARNESS=1` or `A4SX_MESH_SESSION=1` in its environment), the extension never runs the a4sx CLI: it would act as that session, not as you. The views and commands say so instead.

### Installing the a4sx CLI

If the a4sx command-line tool isn't found, the **Cells** view offers **Install a4sx CLI**. The same button appears wherever the extension needs the CLI. The extension then:

1. Looks for Python 3.10 or newer (on Windows: `py -3`, `python`, `python3`, then the per-user Python folders). On Windows, if there is none, it offers to run `winget install Python.Python.3.12` in a terminal. Run **Install a4sx CLI** again when that's done.
2. Downloads the CLI's files (`a4sx.py`, and `ipc_proxy.py` when the server has it) from session-exchange.com, or your `a4sx.serverUrl`. Each file must match the SHA-256 checksum the server sends with it. Otherwise nothing is installed.
3. Saves them in the extension's own storage folder, with a small launcher that runs them with that Python. It doesn't need admin rights, and it doesn't change your `PATH` or your shell profile. Nothing downloaded is run through a shell.

An `a4sx` on your `PATH`, or in `a4sx.cliPath`, is used first. The extension's own copy is used only when there is none. The extension updates its own copy once a day in the background (`a4sx update`). **Update a4sx CLI** runs the update in a terminal at any time. An `a4sx` you installed yourself is not updated automatically.

## Meshes

The **Meshes** view lists your meshes. Under each mesh are your cells in it: their status, presence, reach and when they were last seen (rounded to 5 minutes). If your cells in a mesh run on more than one machine, they are grouped by machine. A cell's tooltip shows its isolation tier (a, b or c), as the cell reports it itself. A Windows host on tier c appears as one machine per mesh; its tooltip says so. A cell waiting for approval shows "Waiting for approval". The cells are read when the view is shown or a mesh is expanded, then every 30 seconds while the view is visible. **Refresh meshes** refreshes it right away. The view lists only the meshes you're a member of. A mesh that isn't active (archived, merged or deleted) shows its status and offers only **Open in browser**. If your meshes don't fit in 20 pages, the view says so; the website shows all of them. If your a4sx server doesn't list cells yet, the view shows your meshes and the line "Cells appear here once your server supports it."

- **Start session in mesh** (on a mesh) asks for a name, then runs `a4sx launch --ipc-proxy --mesh <id> --as <name>` in a new terminal. It needs the a4sx command-line tool, which signs in on its own. First the extension asks the CLI how this host can isolate the mesh key (`a4sx launch --mesh <id> --preflight --json`). If the CLI says this host isn't ready (for example, reduced isolation without a key for just this mesh, or with other a4sx sign-ins saved), the start is refused, and the CLI's reason and the commands that fix it are shown. If the host can only run with reduced isolation, a warning explains the risk, and only **Start with reduced isolation** adds `--mesh-reduced-isolation` to that one start; nothing is remembered. Otherwise the session starts. The name may use 1-48 lowercase letters, digits and `-`, and must start and end with a letter or digit.
- **Open in browser** (on a mesh) opens the mesh's page on the website. Creating a mesh, redeeming an invite and every other change happen on the website: **Create a mesh in the browser** and **Redeem a mesh invite in the browser** are in the view's title bar.
- The view needs the permission `mesh:read`. If your key doesn't have it yet, the view shows **Allow mesh read**, which opens a new browser sign-in that asks for it. The extension never asks for any other mesh permission.
- If the website must be opened first, the view says so and offers **Open in browser**.

The view is hidden when you're signed out, or when your a4sx server has no meshes. If your sign-in is no longer valid, the extension signs you out, as **My sessions** does.

## Roadmap

- TODO (phase 2): start a cell inside the Claude Code panel, not only in a terminal. The plan is to use the Claude Code extension's `claudeCode.claudeProcessWrapper` setting (machine scope), so that the a4sx CLI starts the panel's `claude` as a cell. That needs new CLI support and your consent before the setting is changed.

## Signing out

To sign out, run **a4sx: Sign out**. The extension asks the a4sx server to revoke the key, then removes the key from VS Code. If the server can't be reached, the key is still removed from VS Code, and it stays valid until it expires or you revoke it on session-exchange.com under Account › Agent keys.

## Requirements

- VS Code 1.101 or later. The MCP servers are used by agent mode in VS Code chat.
- For **Save this session**, for launch profiles in **Resume in terminal**, and for the **Cells** view: the a4sx command-line tool, signed in with `a4sx login`. The extension looks for `a4sx` on your `PATH`, then in `~/.local/bin`, `/usr/local/bin` and `/opt/homebrew/bin`, then in its own storage. **Install a4sx CLI** installs it there (see [Installing the a4sx CLI](#installing-the-a4sx-cli)); it needs Python 3.10 or newer. You can also use the [install guide](https://session-exchange.com/guide/cli).
- For starting cells: Linux or Windows (native, WSL, Remote-SSH or a dev container), as the a4sx CLI requires.
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

The sidebar connects to session-exchange.com (or your `a4sx.serverUrl`) to sign you in, list and file your sessions, manage your launch profiles and search the marketplace. When you're signed in, it asks the server whether it has meshes: one request (`GET /meshes`) when a window opens, after each sign-in and when `a4sx.serverUrl` changes, retried at most 5 times over about 13 minutes if the server can't be reached. Your cells are read only when the **Meshes** view is shown or a mesh is expanded, then every 30 seconds while the view is visible; when the server is busy, the extension waits longer, as long as the server asks, up to 5 minutes. **Install a4sx CLI** downloads the CLI's files from session-exchange.com (or your `a4sx.serverUrl`), and the daily update of the extension's own copy downloads them again. These downloads send no key. It sends no telemetry. VS Code connects to session-exchange.com when agent mode uses the a4sx MCP servers. **Resume in Claude Code**, and **Resume in terminal** without the a4sx command-line tool, download the session from session-exchange.com with the sidebar's sign-in. **Save this session**, and **Resume in terminal** with the a4sx command-line tool, run that tool, which uses its own sign-in. When a window opens and your sign-in can't read launch profiles yet, the extension asks the server once whether it offers them, to know whether to ask for that permission.
