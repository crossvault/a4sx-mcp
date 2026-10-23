# a4sx for VS Code

[a4sx](https://session-exchange.com) is an exchange for AI coding-agent sessions. You can save your sessions to your a4sx library and find sessions that others publish on the a4sx marketplace.

This extension connects VS Code to a4sx. It adds:

- **The a4sx sidebar.** Click the a4sx icon in the activity bar.
  - **Sign in to a4sx.** Your browser opens the a4sx sign-in page. Check that it shows the same code as VS Code, then confirm. VS Code keeps the resulting key in its secret storage. The key can read your library and your launch profiles. It can also rename your saved sessions, change their tags and move them between folders.
  - **My sessions** lists the sessions in your library, newest first, with their date and size, in folders. For each session you can:
    - **Resume in terminal**, which runs `a4sx launch --a4sx-session=NAME` and continues the session in Claude Code. If you have more than one launch profile, VS Code asks which one to use.
    - **Resume in Claude Code**, which copies the session into Claude Code's local history for the open folder and opens it in the Claude Code extension's panel. If more than one folder is open, VS Code asks which one.
    - **Open on the web**.
    - **Copy session id**.
    - **Move to folder…** and **Remove from folder**.
  - **Launch profiles** lists your launch profiles. The default one is marked. You can create, edit and delete profiles, and set the default.
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

A launch profile says how `a4sx launch` starts a session: the model, the server address (`base_url`), the harness and extra flags. The extension never shows or stores an API key; keep keys out of profile flags and headers. In the list and in **Edit**, flags that look like a key or token are shown as `••••`, and **Edit** keeps them as they are. Newer a4sx servers show only a few known settings here. The tooltip and **Edit** say how many other settings are hidden; they stay as they are, and you change them with the a4sx CLI or on the website. While a profile has hidden settings, its server address can't be moved to another host, scheme or port from here. If a4sx refuses a change, **Edit** stays open with the server's message.

- **Create launch profile** (the + button) asks for an id, a model and a server address.
- **Edit** asks which field to change.
- **Set as default** and changing a server address ask you to confirm first. The message names the address that launches will send their requests to.
- **Delete** asks you to confirm first.

The first time you change a profile, the extension asks for one more permission (`profiles:write`). Your browser opens a new sign-in that names it. The extension keeps using your current key until the new one arrives. Then it replaces the old key and asks the a4sx server to revoke it.

On an older a4sx server, the view shows "Launch profiles need a newer a4sx server." and the profile actions are hidden.

## Signing out

To sign out, run **a4sx: Sign out**. The extension asks the a4sx server to revoke the key, then removes the key from VS Code. If the server can't be reached, the key is still removed from VS Code, and it stays valid until it expires or you revoke it on session-exchange.com under Account › Agent keys.

## Requirements

- VS Code 1.101 or later. The MCP servers are used by agent mode in VS Code chat.
- For **Save this session** and **Resume in terminal**: the a4sx command-line tool, installed and signed in with `a4sx login`. See the [install guide](https://session-exchange.com/guide/cli). The extension does not install it for you. It looks for `a4sx` on your `PATH`, then in `~/.local/bin`, `/usr/local/bin` and `/opt/homebrew/bin`. If it can't find `a4sx`, it tells you and links to the guide.
- For **Resume in Claude Code**: the Claude Code extension, and the a4sx command-line tool 0.10.77 or later (run `a4sx update`). The resumed session runs on the Claude Code extension's own sign-in, not on your a4sx launch profile or router.

Saving and resuming work for Claude Code sessions.

In a remote window (SSH, WSL, dev containers, Codespaces), the a4sx extension usually runs on the remote machine. Then the a4sx command-line tool must be installed and signed in on that machine too.

## Settings

| Setting | Description |
|---|---|
| `a4sx.cliPath` | Full path to the `a4sx` command, if the extension can't find it. Can only be set in your user settings. |
| `a4sx.serverUrl` | The a4sx server the sidebar signs in to. The default is session-exchange.com. Can only be set in your user settings. |

## Network use

The sidebar connects to session-exchange.com (or your `a4sx.serverUrl`) to sign you in, list and file your sessions, manage your launch profiles and search the marketplace. It sends no telemetry. VS Code connects to session-exchange.com when agent mode uses the a4sx MCP servers. **Save this session**, **Resume in terminal** and **Resume in Claude Code** run the a4sx command-line tool, which uses its own sign-in.
