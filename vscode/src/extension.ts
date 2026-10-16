// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 crossVault GmbH
// a4sx for VS Code: registers the a4sx remote MCP servers for agent mode and adds two commands.
// The extension itself makes no network calls and stores no tokens. VS Code connects to the MCP
// servers when chat uses them, and runs any sign-in flow itself (MCP authorization spec).
import * as vscode from "vscode";
import { CLI_NAME, findCli, CliLookup } from "./cli";

export const SITE = "https://session-exchange.com";
export const MCP_URL = `${SITE}/mcp`;
export const MCP_LIBRARY_URL = `${SITE}/mcp/library`;
export const LIBRARY_URL = `${SITE}/library`;
export const INSTALL_URL = `${SITE}/guide/cli`;

export const MCP_PROVIDER_ID = "a4sx.mcpServers";
export const CMD_SAVE = "a4sx.saveSession";
export const CMD_OPEN_LIBRARY = "a4sx.openLibrary";
export const TERMINAL_NAME = "a4sx: save session";
/** `a4sx push --latest`: saves the most recently modified local Claude Code session. */
export const SAVE_ARGS = ["push", "--latest"];

export function mcpServerDefinitions(): vscode.McpServerDefinition[] {
  return [
    // Anonymous: search and summaries of the public marketplace.
    new vscode.McpHttpServerDefinition("a4sx", vscode.Uri.parse(MCP_URL)),
    // Your library: answers 401 until you sign in; VS Code then runs the OAuth sign-in itself.
    new vscode.McpHttpServerDefinition("a4sx library", vscode.Uri.parse(MCP_LIBRARY_URL)),
  ];
}

function lookupCli(lookup: (configured: string | undefined) => CliLookup): CliLookup {
  const configured = vscode.workspace.getConfiguration("a4sx").get<string>("cliPath");
  return lookup(configured);
}

export async function reportMissingCli(result: Exclude<CliLookup, { found: true }>): Promise<void> {
  const message =
    result.reason === "configured-path-invalid"
      ? `The a4sx.cliPath setting points to "${result.configured}", which is not an executable file. Fix the setting, or clear it to use ${CLI_NAME} from your PATH.`
      : `The ${CLI_NAME} command was not found on your PATH. Install the ${CLI_NAME} CLI to save sessions from VS Code.`;
  const install = "How to install";
  const choice = await vscode.window.showErrorMessage(message, install);
  if (choice === install) {
    await vscode.env.openExternal(vscode.Uri.parse(INSTALL_URL));
  }
}

export async function saveSession(lookup: (configured: string | undefined) => CliLookup = findCli): Promise<vscode.Terminal | undefined> {
  const result = lookupCli(lookup);
  if (!result.found) {
    await reportMissingCli(result);
    return undefined;
  }
  // Run the CLI directly (no shell), in a visible terminal, so the user sees every step and prompt.
  const terminal = vscode.window.createTerminal({
    name: TERMINAL_NAME,
    shellPath: result.path,
    shellArgs: SAVE_ARGS,
  });
  terminal.show();
  return terminal;
}

export async function openLibrary(): Promise<void> {
  await vscode.env.openExternal(vscode.Uri.parse(LIBRARY_URL));
}

/** Editors built on VS Code (installed from Open VSX) may lack the MCP provider API; the commands still work there. */
export function hasMcpProviderApi(): boolean {
  return typeof vscode.lm?.registerMcpServerDefinitionProvider === "function" && typeof vscode.McpHttpServerDefinition === "function";
}

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(CMD_SAVE, () => saveSession()),
    vscode.commands.registerCommand(CMD_OPEN_LIBRARY, () => openLibrary()),
  );
  if (hasMcpProviderApi()) {
    const changed = new vscode.EventEmitter<void>();
    context.subscriptions.push(
      changed,
      vscode.lm.registerMcpServerDefinitionProvider(MCP_PROVIDER_ID, {
        onDidChangeMcpServerDefinitions: changed.event,
        provideMcpServerDefinitions: () => mcpServerDefinitions(),
        resolveMcpServerDefinition: (server) => server,
      }),
    );
  }
}

export function deactivate(): void {
  // Nothing to clean up beyond context.subscriptions.
}
