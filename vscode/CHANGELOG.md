# Changelog

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
