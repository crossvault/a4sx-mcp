// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 crossVault GmbH
// a4sx for VS Code: registers the a4sx remote MCP servers for agent mode, adds the a4sx sidebar
// (sign-in, "My sessions", "Marketplace") and the save/resume commands. The sidebar is the only part
// that calls the a4sx server itself; its scoped, read-only token lives only in VS Code's secret storage.
// VS Code connects to the MCP servers when chat uses them, and runs their sign-in itself.
import * as vscode from "vscode";
import { Client, FetchLike, listingWebUrl, normalizeServerUrl, sessionWebUrl } from "./api";
import { A4sxAuthProvider, AUTH_ID, AUTH_LABEL, LoginCancelled, SECRET_KEY, vscodeLogin } from "./auth";
import { CLI_NAME, findCli, CliLookup } from "./cli";
import { CMD_OPEN_LISTING, ListingItem, MarketplaceProvider } from "./marketplaceView";
import { launchName, SessionItem, SessionsProvider, ViewState } from "./sessionsView";

export const SITE = "https://session-exchange.com";
export const MCP_URL = `${SITE}/mcp`;
export const MCP_LIBRARY_URL = `${SITE}/mcp/library`;
export const LIBRARY_URL = `${SITE}/library`;
export const INSTALL_URL = `${SITE}/guide/cli`;

export const MCP_PROVIDER_ID = "a4sx.mcpServers";
export const CMD_SAVE = "a4sx.saveSession";
export const CMD_OPEN_LIBRARY = "a4sx.openLibrary";
export const CMD_SIGN_IN = "a4sx.signIn";
export const CMD_SIGN_OUT = "a4sx.signOut";
export const CMD_REFRESH = "a4sx.refreshSessions";
export const CMD_RESUME = "a4sx.resumeSession";
export const CMD_OPEN_SESSION = "a4sx.openSessionOnWeb";
export const CMD_COPY_ID = "a4sx.copySessionId";
export const CMD_SEARCH = "a4sx.searchMarketplace";
export { CMD_OPEN_LISTING };
export const VIEW_SESSIONS = "a4sx.sessions";
export const VIEW_MARKETPLACE = "a4sx.marketplace";
export const TERMINAL_NAME = "a4sx: save session";
export const RESUME_TERMINAL_NAME = "a4sx: resume session";
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
      : `The ${CLI_NAME} command was not found on your PATH. Install the ${CLI_NAME} CLI to save and resume sessions from VS Code.`;
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

/** Swappable in unit tests: the network and the interactive login. */
export const runtime: { fetch: FetchLike; login: (client: Client) => ReturnType<typeof vscodeLogin> } = {
  fetch: (url, init) => fetch(url, init),
  login: vscodeLogin,
};

export function client(): Client {
  return {
    base: normalizeServerUrl(vscode.workspace.getConfiguration("a4sx").get<string>("serverUrl")),
    fetch: runtime.fetch,
    userAgent: "a4sx-vscode",
  };
}

function errorText(e: unknown): string {
  return e instanceof Error && e.message ? e.message : "Something went wrong. Try again.";
}

export async function signIn(auth: A4sxAuthProvider): Promise<void> {
  try {
    await auth.createSession();
  } catch (e) {
    if (!(e instanceof LoginCancelled)) {
      await vscode.window.showErrorMessage(errorText(e));
    }
  }
}

export const SIGNED_OUT_INFO =
  "Signed out of a4sx on this computer. The key stays valid until it expires or you revoke it on the a4sx website under Account › Agent keys.";

export async function signOut(auth: A4sxAuthProvider): Promise<void> {
  await auth.clear();
  await vscode.window.showInformationMessage(SIGNED_OUT_INFO);
}

export async function resumeSession(item: SessionItem | undefined, lookup: (configured: string | undefined) => CliLookup = findCli): Promise<vscode.Terminal | undefined> {
  if (!item) {
    return undefined;
  }
  const result = lookupCli(lookup);
  if (!result.found) {
    await reportMissingCli(result);
    return undefined;
  }
  // `a4sx launch` starts Claude Code on a copy of the saved session; run directly, no shell.
  const terminal = vscode.window.createTerminal({
    name: RESUME_TERMINAL_NAME,
    shellPath: result.path,
    shellArgs: ["launch", `--a4sx-session=${launchName(item.row)}`],
  });
  terminal.show();
  return terminal;
}

export async function openSessionOnWeb(item: SessionItem | undefined): Promise<void> {
  if (!item) {
    return;
  }
  try {
    await vscode.env.openExternal(vscode.Uri.parse(sessionWebUrl(client().base, item.row.id)));
  } catch (e) {
    await vscode.window.showErrorMessage(errorText(e));
  }
}

export const COPIED_INFO = "Copied the session id.";

export async function copySessionId(item: SessionItem | undefined): Promise<void> {
  if (!item) {
    return;
  }
  await vscode.env.clipboard.writeText(item.row.id);
  await vscode.window.showInformationMessage(COPIED_INFO);
}

export async function openListing(item: ListingItem | undefined): Promise<void> {
  if (!item) {
    return;
  }
  try {
    await vscode.env.openExternal(vscode.Uri.parse(listingWebUrl(client().base, item.row)));
  } catch (e) {
    await vscode.window.showErrorMessage(errorText(e));
  }
}

export async function searchMarketplace(market: MarketplaceProvider): Promise<void> {
  const q = await vscode.window.showInputBox({
    title: "Search the a4sx marketplace",
    prompt: "Search public sessions by topic, tool or task.",
    placeHolder: "for example: terraform upgrade",
    value: market.query ?? "",
  });
  if (q === undefined) {
    return;
  }
  market.search(q);
}

function setViewContext(state: ViewState): void {
  void vscode.commands.executeCommand("setContext", "a4sx.signedIn", state !== "signed-out");
  void vscode.commands.executeCommand("setContext", "a4sx.sessionsEmpty", state === "empty");
}

/** Editors built on VS Code (installed from Open VSX) may lack the MCP provider API; the commands still work there. */
export function hasMcpProviderApi(): boolean {
  return typeof vscode.lm?.registerMcpServerDefinitionProvider === "function" && typeof vscode.McpHttpServerDefinition === "function";
}

export interface Sidebar {
  auth: A4sxAuthProvider;
  sessions: SessionsProvider;
  market: MarketplaceProvider;
}

/** For tests only. Never returned from activate(): that value is readable by every other extension. */
export let sidebar: Sidebar | undefined;

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(CMD_SAVE, () => saveSession()),
    vscode.commands.registerCommand(CMD_OPEN_LIBRARY, () => openLibrary()),
  );

  const auth = new A4sxAuthProvider(context.secrets, client, (c) => runtime.login(c));
  const sessions = new SessionsProvider(auth, client, setViewContext);
  const market = new MarketplaceProvider(client);
  const syncSignedIn = () => void auth.current().then((s) => vscode.commands.executeCommand("setContext", "a4sx.signedIn", !!s));
  syncSignedIn();
  context.subscriptions.push(
    auth,
    sessions,
    market,
    vscode.authentication.registerAuthenticationProvider(AUTH_ID, AUTH_LABEL, auth, { supportsMultipleAccounts: false }),
    vscode.window.registerTreeDataProvider(VIEW_SESSIONS, sessions),
    vscode.window.registerTreeDataProvider(VIEW_MARKETPLACE, market),
    auth.onDidChangeSessions(() => {
      syncSignedIn();
      sessions.refresh();
    }),
    context.secrets.onDidChange((e) => {
      if (e.key === SECRET_KEY) {
        auth.notifyExternalChange();
      }
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("a4sx.serverUrl")) {
        syncSignedIn();
        sessions.refresh();
        market.search(market.query);
      }
    }),
    vscode.commands.registerCommand(CMD_SIGN_IN, () => signIn(auth)),
    vscode.commands.registerCommand(CMD_SIGN_OUT, () => signOut(auth)),
    vscode.commands.registerCommand(CMD_REFRESH, () => sessions.refresh()),
    vscode.commands.registerCommand(CMD_RESUME, (item?: SessionItem) => resumeSession(item)),
    vscode.commands.registerCommand(CMD_OPEN_SESSION, (item?: SessionItem) => openSessionOnWeb(item)),
    vscode.commands.registerCommand(CMD_COPY_ID, (item?: SessionItem) => copySessionId(item)),
    vscode.commands.registerCommand(CMD_SEARCH, () => searchMarketplace(market)),
    vscode.commands.registerCommand(CMD_OPEN_LISTING, (item?: ListingItem) => openListing(item)),
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
  sidebar = { auth, sessions, market };
}

export function deactivate(): void {
  // Nothing to clean up beyond context.subscriptions.
}
