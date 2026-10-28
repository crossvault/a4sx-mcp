// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 crossVault GmbH
// A minimal stand-in for the `vscode` module, so unit tests run under plain mocha (no editor needed).
// Loaded with `mocha --require`; it answers `require("vscode")` and records every call the extension makes.
// eslint-disable-next-line @typescript-eslint/no-require-imports
import Module = require("module");

export interface Calls {
  commands: Map<string, (...args: unknown[]) => unknown>;
  mcpProviders: Map<string, any>;
  terminals: any[];
  errors: { message: string; items: string[] }[];
  opened: string[];
  config: Record<string, unknown>;
  /** What the next showErrorMessage resolves to (a button label, or undefined = dismissed). */
  nextErrorChoice: string | undefined;
  infos: string[];
  warnings: string[];
  /** What the next showInputBox resolves to (undefined = Esc). */
  nextInput: string | undefined;
  inputs: any[];
  clipboard: string | undefined;
  context: Record<string, unknown>;
  authProviders: Map<string, { label: string; provider: any; options: any }>;
  treeProviders: Map<string, any>;
  progress: { title: string; messages: string[]; options: any }[];
  /** Commands run through executeCommand (other than setContext). */
  executed: { id: string; args: unknown[] }[];
  /** Extension ids getExtension finds. */
  extensions: Set<string>;
  workspaceFolders: { name: string; uri: { scheme: string; fsPath: string } }[] | undefined;
  /** What the next showQuickPick resolves to: an index into its items (undefined = Esc). */
  nextPick: number | undefined;
  quickPicks: { items: any[]; options: any }[];
  uriScheme: string;
  /** What the next openExternal resolves to. */
  openResult: boolean;
  /** Set true to make withProgress's cancellation token fire right away. */
  cancelProgress: boolean;
  /** vscode.env.remoteName: undefined in a local window, e.g. "ssh-remote" in a remote one. */
  remoteName: string | undefined;
  /** This extension's extensionKind (1 = UI, 2 = Workspace), as getExtension reports it. */
  extensionKind: number;
  /** How many cancellation listeners were disposed. */
  cancelDisposed: number;
  /** Modal information/warning messages (`{ modal: true }`), in order. */
  modals: { kind: "info" | "warning" | "error"; message: string; items: string[]; detail?: string }[];
  /** What the next modals resolve to, in order (a button label, or undefined = Cancel). Empty = Cancel. */
  modalChoices: (string | undefined)[];
  /** What the next input boxes resolve to, in order; when empty, `nextInput` answers. */
  inputQueue: (string | undefined)[];
  /** What the next quick picks resolve to (indexes), in order; when empty, `nextPick` answers. */
  pickQueue: (number | undefined)[];
  /** vscode.env.shell: the default shell of the terminals (undefined = unknown). */
  shell: string | undefined;
  /** Non-modal information messages that offered buttons, and what the next one resolves to. */
  infoPrompts: { message: string; items: string[] }[];
  nextInfoChoice: string | undefined;
  /** What the next showOpenDialog resolves to (undefined = Cancel). */
  nextOpenDialog: unknown[] | undefined;
  openDialogs: any[];
  /** Tree views made with createTreeView, by view id. */
  treeViews: Map<string, { message?: string; description?: string; visible: boolean; setVisible(v: boolean): void }>;
  /** Whether views made with createTreeView start out visible. */
  viewsVisible: boolean;
}

export const calls: Calls = {
  commands: new Map(),
  mcpProviders: new Map(),
  terminals: [],
  errors: [],
  opened: [],
  config: {},
  nextErrorChoice: undefined,
  infos: [],
  warnings: [],
  nextInput: undefined,
  inputs: [],
  clipboard: undefined,
  context: {},
  authProviders: new Map(),
  treeProviders: new Map(),
  progress: [],
  executed: [],
  extensions: new Set(),
  workspaceFolders: undefined,
  nextPick: undefined,
  quickPicks: [],
  uriScheme: "vscode",
  openResult: true,
  cancelProgress: false,
  cancelDisposed: 0,
  remoteName: undefined,
  extensionKind: 1,
  modals: [],
  modalChoices: [],
  inputQueue: [],
  pickQueue: [],
  treeViews: new Map(),
  nextOpenDialog: undefined,
  openDialogs: [],
  infoPrompts: [],
  nextInfoChoice: undefined,
  shell: "/bin/bash",
  viewsVisible: false,
};

export function resetCalls(): void {
  calls.commands.clear();
  calls.mcpProviders.clear();
  calls.terminals.length = 0;
  calls.errors.length = 0;
  calls.opened.length = 0;
  calls.config = {};
  calls.nextErrorChoice = undefined;
  calls.infos.length = 0;
  calls.warnings.length = 0;
  calls.nextInput = undefined;
  calls.inputs.length = 0;
  calls.clipboard = undefined;
  calls.context = {};
  calls.authProviders.clear();
  calls.treeProviders.clear();
  calls.progress.length = 0;
  calls.executed.length = 0;
  calls.extensions.clear();
  calls.workspaceFolders = undefined;
  calls.nextPick = undefined;
  calls.quickPicks.length = 0;
  calls.uriScheme = "vscode";
  calls.openResult = true;
  calls.cancelProgress = false;
  calls.cancelDisposed = 0;
  calls.remoteName = undefined;
  calls.extensionKind = 1;
  calls.modals.length = 0;
  calls.modalChoices.length = 0;
  calls.inputQueue.length = 0;
  calls.pickQueue.length = 0;
  calls.treeViews.clear();
  calls.nextOpenDialog = undefined;
  calls.openDialogs.length = 0;
  calls.infoPrompts.length = 0;
  calls.nextInfoChoice = undefined;
  calls.shell = "/bin/bash";
  calls.viewsVisible = false;
}

function isModal(options: unknown): boolean {
  return typeof options === "object" && options !== null && (options as { modal?: boolean }).modal === true;
}

/** An in-memory `context.secrets` that records what was stored. */
export function fakeSecrets() {
  const store = new Map<string, string>();
  const changed = new EventEmitter<{ key: string }>();
  return {
    store_: store,
    async get(key: string) { return store.get(key); },
    async store(key: string, value: string) { store.set(key, value); changed.fire({ key }); },
    async delete(key: string) { store.delete(key); changed.fire({ key }); },
    onDidChange: changed.event,
  };
}

class Uri {
  private constructor(private readonly value: string, public readonly fsPath: string = "") {}
  get scheme(): string {
    return this.value.split(":")[0];
  }
  static parse(value: string): Uri {
    const m = /^(?:file|vscode-remote):\/\/[^/]*(\/.*)$/.exec(value);
    return new Uri(value, m ? decodeURIComponent(m[1]) : "");
  }
  static file(p: string): Uri {
    return new Uri(`file://${p}`, p);
  }
  toString(): string {
    return this.value;
  }
}

/** An in-memory `context.globalState` (vscode.Memento). */
export function fakeMemento(initial: Record<string, unknown> = {}) {
  const data = new Map<string, unknown>(Object.entries(initial));
  return {
    data_: data,
    get<T>(key: string, fallback?: T): T | undefined { return data.has(key) ? (data.get(key) as T) : fallback; },
    async update(key: string, value: unknown) { if (value === undefined) { data.delete(key); } else { data.set(key, value); } },
    keys() { return [...data.keys()]; },
  };
}

class EventEmitter<T> {
  private listeners: ((e: T) => void)[] = [];
  event = (listener: (e: T) => void) => {
    this.listeners.push(listener);
    return { dispose: () => undefined };
  };
  fire(e: T): void {
    this.listeners.forEach((l) => l(e));
  }
  dispose(): void {
    this.listeners = [];
  }
}

enum TreeItemCollapsibleState { None = 0, Collapsed = 1, Expanded = 2 }

class TreeItem {
  id?: string;
  description?: string;
  tooltip?: string;
  contextValue?: string;
  iconPath?: unknown;
  command?: { command: string; title: string; arguments?: unknown[] };
  constructor(public label: string, public collapsibleState: TreeItemCollapsibleState = TreeItemCollapsibleState.None) {}
}

class ThemeColor {
  constructor(public id: string) {}
}

class ThemeIcon {
  constructor(public id: string, public color?: ThemeColor) {}
}

class McpHttpServerDefinition {
  constructor(public label: string, public uri: Uri, public headers: Record<string, string> = {}, public version?: string) {}
}

const fake = {
  Uri,
  EventEmitter,
  McpHttpServerDefinition,
  TreeItem,
  TreeItemCollapsibleState,
  ThemeIcon,
  ThemeColor,
  ProgressLocation: { Notification: 15, Window: 10 },
  ExtensionKind: { UI: 1, Workspace: 2 },
  commands: {
    registerCommand(id: string, fn: (...args: unknown[]) => unknown) {
      calls.commands.set(id, fn);
      return { dispose: () => calls.commands.delete(id) };
    },
    async executeCommand(id: string, ...args: unknown[]) {
      if (id === "setContext") {
        calls.context[args[0] as string] = args[1];
      } else {
        calls.executed.push({ id, args });
      }
    },
  },
  authentication: {
    registerAuthenticationProvider(id: string, label: string, provider: unknown, options: unknown) {
      calls.authProviders.set(id, { label, provider, options });
      return { dispose: () => calls.authProviders.delete(id) };
    },
  },
  lm: {
    registerMcpServerDefinitionProvider(id: string, provider: unknown) {
      calls.mcpProviders.set(id, provider);
      return { dispose: () => calls.mcpProviders.delete(id) };
    },
  },
  window: {
    createTerminal(options: unknown) {
      const t = { options, shown: false, sent: [] as string[], show() { this.shown = true; }, sendText(text: string, addNewLine?: boolean) { this.sent.push(addNewLine === false ? text : `${text}\n`); } };
      calls.terminals.push(t);
      return t;
    },
    async showErrorMessage(message: string, ...rest: unknown[]) {
      if (isModal(rest[0])) {
        const items = rest.slice(1) as string[];
        calls.modals.push({ kind: "error", message, items, detail: (rest[0] as { detail?: string }).detail });
        return calls.modalChoices.shift();
      }
      calls.errors.push({ message, items: rest as string[] });
      return calls.nextErrorChoice;
    },
    async showInformationMessage(message: string, options?: unknown, ...items: string[]) {
      if (isModal(options)) {
        calls.modals.push({ kind: "info", message, items });
        return calls.modalChoices.shift();
      }
      calls.infos.push(message);
      const buttons = [typeof options === "string" ? options : undefined, ...items].filter((x): x is string => typeof x === "string");
      if (buttons.length) {
        calls.infoPrompts.push({ message, items: buttons });
        const choice = calls.nextInfoChoice;
        calls.nextInfoChoice = undefined;
        return choice;
      }
      return undefined;
    },
    async showWarningMessage(message: string, options?: unknown, ...items: string[]) {
      if (isModal(options)) {
        calls.modals.push({ kind: "warning", message, items, detail: (options as { detail?: string }).detail });
        return calls.modalChoices.shift();
      }
      calls.warnings.push(message);
      return undefined;
    },
    async showInputBox(options: unknown) {
      calls.inputs.push(options);
      return calls.inputQueue.length ? calls.inputQueue.shift() : calls.nextInput;
    },
    registerTreeDataProvider(id: string, provider: unknown) {
      calls.treeProviders.set(id, provider);
      return { dispose: () => calls.treeProviders.delete(id) };
    },
    createTreeView(id: string, options: { treeDataProvider: unknown }) {
      calls.treeProviders.set(id, options.treeDataProvider);
      const visibility = new EventEmitter<{ visible: boolean }>();
      const view = {
        message: undefined as string | undefined,
        description: undefined as string | undefined,
        visible: calls.viewsVisible,
        onDidChangeVisibility: visibility.event,
        /** Test helper: what VS Code does when the view is shown or hidden. */
        setVisible(v: boolean) { view.visible = v; visibility.fire({ visible: v }); },
        dispose: () => { calls.treeProviders.delete(id); calls.treeViews.delete(id); },
      };
      calls.treeViews.set(id, view);
      return view;
    },
    async withProgress(options: { title: string }, task: (p: unknown, c: unknown) => Promise<unknown>) {
      const rec = { title: options.title, messages: [] as string[], options };
      calls.progress.push(rec);
      const token = {
        isCancellationRequested: calls.cancelProgress,
        onCancellationRequested(listener: () => void) {
          if (calls.cancelProgress) {
            listener();
          }
          return { dispose: () => { calls.cancelDisposed++; } };
        },
      };
      return task({ report: (v: { message?: string }) => { if (v.message !== undefined) { rec.messages.push(v.message); } } }, token);
    },
    async showOpenDialog(options: unknown) {
      calls.openDialogs.push(options);
      return calls.nextOpenDialog;
    },
    async showQuickPick(items: any[], options: unknown) {
      calls.quickPicks.push({ items, options });
      const pick = calls.pickQueue.length ? calls.pickQueue.shift() : calls.nextPick;
      return pick === undefined ? undefined : items[pick];
    },
  },
  env: {
    async openExternal(uri: Uri) {
      calls.opened.push(uri.toString());
      return calls.openResult;
    },
    get uriScheme() {
      return calls.uriScheme;
    },
    get remoteName() {
      return calls.remoteName;
    },
    get shell() {
      return calls.shell;
    },
    clipboard: {
      async writeText(text: string) {
        calls.clipboard = text;
      },
    },
  },
  extensions: {
    getExtension(id: string) {
      if (id.toLowerCase() === "crossvaultgmbh.a4sx") {
        return { id, extensionKind: calls.extensionKind };
      }
      return calls.extensions.has(id) ? { id } : undefined;
    },
  },
  workspace: {
    get workspaceFolders() {
      return calls.workspaceFolders;
    },
    getConfiguration(section: string) {
      return {
        get<T>(key: string): T | undefined {
          return calls.config[`${section}.${key}`] as T | undefined;
        },
      };
    },
    onDidChangeConfiguration(_listener: unknown) {
      return { dispose: () => undefined };
    },
  },
};

const mod = Module as unknown as { _load: (request: string, ...rest: unknown[]) => unknown };
const origLoad = mod._load;
mod._load = function (request: string, ...rest: unknown[]) {
  if (request === "vscode") {
    return fake;
  }
  return origLoad.call(this, request, ...rest);
};
