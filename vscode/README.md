# a4sx for VS Code

[a4sx](https://session-exchange.com) is an exchange for AI coding-agent sessions. You can save your sessions to your a4sx library and find sessions that others publish on the a4sx marketplace.

This extension connects VS Code to a4sx. It adds:

- **The a4sx sidebar.** Click the a4sx icon in the activity bar.
  - **Sign in to a4sx.** Your browser opens the a4sx sign-in page. Check that it shows the same code as VS Code, then confirm. VS Code keeps the resulting key in its secret storage. The key can only read your library.
  - **My sessions** lists the sessions in your library, newest first, with their date and size. For each session you can:
    - **Resume in terminal**, which runs `a4sx launch --a4sx-session=NAME` and continues the session in Claude Code.
    - **Resume in Claude Code**, which copies the session into Claude Code's local history for the open folder and opens it in the Claude Code extension's panel. If more than one folder is open, VS Code asks which one.
    - **Open on the web**.
    - **Copy session id**.
  - **Marketplace** searches the sessions that others publish. A result opens on session-exchange.com. You don't need to sign in to search.
- **The a4sx MCP servers for agent mode.** The a4sx tools show up in the tools list of agent mode in VS Code chat.
  - **a4sx** works without an account. You can search sessions and read their summaries.
  - **a4sx library** works with your a4sx account. VS Code asks you to sign in the first time it connects, and VS Code handles that sign-in itself.
- **a4sx: Save this session.** This command runs `a4sx push --latest` in a terminal. It saves your most recently changed local Claude Code session to your a4sx library. The CLI's output and questions appear in the terminal.
- **a4sx: Open my library.** This command opens your library on session-exchange.com in your browser.

To sign out, run **a4sx: Sign out**. This removes the key from VS Code. The key stays valid until it expires or you revoke it on session-exchange.com under Account › Agent keys.

## Requirements

- VS Code 1.101 or later. The MCP servers are used by agent mode in VS Code chat.
- For **Save this session** and **Resume in terminal**: the a4sx command-line tool, installed and signed in with `a4sx login`. See the [install guide](https://session-exchange.com/guide/cli). The extension does not install it for you. It looks for `a4sx` on your `PATH`, then in `~/.local/bin`, `/usr/local/bin` and `/opt/homebrew/bin`. If it can't find `a4sx`, it tells you and links to the guide.
- For **Resume in Claude Code**: the Claude Code extension, and the a4sx command-line tool 0.10.77 or later (run `a4sx update`). The resumed session runs on the Claude Code extension's own sign-in, not on your a4sx launch profile or router.

Saving and resuming work for Claude Code sessions.

## Settings

| Setting | Description |
|---|---|
| `a4sx.cliPath` | Full path to the `a4sx` command, if the extension can't find it. Can only be set in your user settings. |
| `a4sx.serverUrl` | The a4sx server the sidebar signs in to. The default is session-exchange.com. Can only be set in your user settings. |

## Network use

The sidebar connects to session-exchange.com (or your `a4sx.serverUrl`) to sign you in, list your sessions and search the marketplace. It sends no telemetry. VS Code connects to session-exchange.com when agent mode uses the a4sx MCP servers. **Save this session**, **Resume in terminal** and **Resume in Claude Code** run the a4sx command-line tool, which uses its own sign-in.
