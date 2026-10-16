# a4sx for VS Code

[a4sx](https://session-exchange.com) is an exchange for AI coding-agent sessions. You can save your sessions to your a4sx library and find sessions that others publish on the a4sx marketplace.

This extension connects VS Code to a4sx. It adds three things:

- **The a4sx MCP servers for agent mode.** The a4sx tools show up in the tools list of agent mode in VS Code chat.
  - **a4sx** works without an account. You can search sessions and read their summaries.
  - **a4sx library** works with your a4sx account. VS Code asks you to sign in the first time it connects, and VS Code handles the sign-in. The extension does not store any tokens.
- **a4sx: Save this session.** This command runs `a4sx push --latest` in a terminal. It saves your most recently changed local Claude Code session to your a4sx library. The CLI's output and questions appear in the terminal.
- **a4sx: Open my library.** This command opens your library on session-exchange.com in your browser.

## Requirements

- VS Code 1.101 or later. The MCP servers are used by agent mode in VS Code chat.
- For **Save this session**: the a4sx command-line tool, installed and signed in with `a4sx login`. See the [install guide](https://session-exchange.com/guide/cli). The extension does not install it for you. If it can't find `a4sx`, it tells you and links to the guide.

Saving works for Claude Code sessions. To continue a saved session, use Claude Code: `a4sx launch --a4sx-session=NAME`.

## Settings

| Setting | Description |
|---|---|
| `a4sx.cliPath` | Full path to the `a4sx` command, if it isn't on your `PATH`. Can only be set in your user settings. |

## Network use

The extension itself makes no network requests and sends no telemetry. VS Code connects to session-exchange.com when agent mode uses the a4sx MCP servers. **Save this session** runs the a4sx command-line tool, which uploads the session to your a4sx library.
