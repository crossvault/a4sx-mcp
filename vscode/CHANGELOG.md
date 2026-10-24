# Changelog

## 0.3.2

- **Resume in terminal** now runs in a normal terminal with your default shell, so Claude Code gets your shell, `PATH` and profile. In 0.3.1, `claude --resume` could stop with exit code 1 on Claude Code's first run. The terminal also stays open after an error.

## 0.3.1

- **Resume in Claude Code** no longer needs the a4sx command-line tool. The extension copies the session into Claude Code's local history itself, with the sidebar's sign-in.
- **Resume in terminal** works without the a4sx command-line tool too: it copies the session, then runs `claude --resume` in a terminal. The first time, it offers to install a4sx, which launch profiles need.
- With no folder open, both resume commands offer **Use my home folder** or **Choose a folder…**. The window then opens that folder, and the session opens there.
- If your sign-in can't read launch profiles yet, the extension asks once for the extra permission. It asks at most once per window; **Not now** waits 7 days.
- The **Launch profiles** view is shown by default.

## 0.3.0

- **My sessions** shows folders. Sessions in a folder appear under it, and folders can be nested. Sessions without a folder stay at the top level.
- New actions on a session: **Move to folder…** and **Remove from folder**.
- **Filter** in the **My sessions** title bar shows only the sessions that match what you type (title, name, id, tags or folder). **Clear filter** shows all of them again.
- New view **Launch profiles**: lists your launch profiles and marks the default. You can create, edit and delete profiles. **Edit** changes the name and the model. The flags, server address, harness, router and headers are read-only here; **Edit** offers `a4sx profile` in a terminal or the website for them. The default, and deleting any profile that holds more than a name and a model (or is the default), are left to the a4sx CLI or the website. A refused change shows the server's message and changes nothing.
- In **Launch profiles**, flags that look like a key or token are shown as `••••`. With a newer a4sx server, the tooltip and **Edit** say how many other settings are hidden. If the server refuses a change, **Edit** stays open and shows the server's message.
- **Resume in terminal** asks which launch profile to use when you have more than one, and passes it to `a4sx launch` as `--profile`.
- **a4sx: Sign out** now asks the a4sx server to revoke the key before it removes the key from VS Code. If the server can't be reached, the key is still removed. After the extra sign-in for a new permission, the old key is revoked the same way.
- Sign-in now also asks for `profiles:read` and `library:organize`. The first change to a launch profile asks for `profiles:write` with a new browser sign-in. On an older a4sx server, sign-in asks for `library:read` only, and the folder and profile actions are hidden.

## 0.2.2

- Remote windows (SSH, WSL, dev containers, Codespaces): if the a4sx extension runs on this computer while the folder is on a remote machine, the resume and save commands now explain how to install a4sx in the remote window.
- Remote windows: if the a4sx CLI isn't installed on the remote machine, the message says so and offers **Copy install command** and **Open settings**.
- Folders that are not on disk (for example virtual folders) get their own message in **Resume in Claude Code**.
- If the a4sx CLI isn't signed in, **Resume in Claude Code** says so. **Run a4sx login** opens a terminal that runs `a4sx login`.

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
