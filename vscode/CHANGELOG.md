# Changelog

## 0.2.2

- Remote windows (SSH, WSL, dev containers, Codespaces): **Resume in Claude Code** uses the open folder on the remote host, also when VS Code hands it over as a `vscode-remote` folder. If the a4sx extension runs on this computer instead, the message says so.
- Remote windows: when the a4sx CLI is not found, the message says it must be installed on the remote host. **Copy install command** copies the install command, and **Open settings** opens `a4sx.cliPath`.
- Folders that are not on disk (for example virtual folders) get their own message.
- When the a4sx CLI needs a sign-in, **Resume in Claude Code** says so. **Run a4sx login** opens a terminal that runs `a4sx login`.

## 0.2.1

- Adds **Resume in Claude Code** to the sessions in **My sessions**. It copies the session into Claude Code's local history for the open folder and opens it in the Claude Code extension. It needs the Claude Code extension and the a4sx CLI 0.10.77 or later.
- Finds the a4sx CLI in `~/.local/bin`, `/usr/local/bin` and `/opt/homebrew/bin` when it isn't on the `PATH` that VS Code sees. This fixes "The a4sx command was not found on your PATH" when VS Code was started from the dock or a menu.

## 0.2.0

- Adds the a4sx sidebar to the activity bar.
  - **Sign in to a4sx** with your browser, the same way as `a4sx login`. VS Code keeps the key in its secret storage, and the key can only read your library. **a4sx: Sign out** removes it.
  - **My sessions** lists your library with each session's date and size. You can resume a session in a terminal, open it on the web, or copy its id.
  - **Marketplace** searches public sessions, and each result opens on the web.
- Adds the setting `a4sx.serverUrl`.
- The extension now connects to session-exchange.com itself, for the sidebar.

## 0.1.0

- First release.
- Adds the a4sx MCP servers (a4sx and a4sx library) for agent mode.
- Adds the commands **a4sx: Save this session** and **a4sx: Open my library**.
- Adds the setting `a4sx.cliPath`.
