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
  progress: { title: string; messages: string[] }[];
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
  private constructor(private readonly value: string) {}
  static parse(value: string): Uri {
    return new Uri(value);
  }
  toString(): string {
    return this.value;
  }
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
  description?: string;
  tooltip?: string;
  contextValue?: string;
  iconPath?: unknown;
  command?: { command: string; title: string; arguments?: unknown[] };
  constructor(public label: string, public collapsibleState: TreeItemCollapsibleState = TreeItemCollapsibleState.None) {}
}

class ThemeIcon {
  constructor(public id: string) {}
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
  ProgressLocation: { Notification: 15 },
  commands: {
    registerCommand(id: string, fn: (...args: unknown[]) => unknown) {
      calls.commands.set(id, fn);
      return { dispose: () => calls.commands.delete(id) };
    },
    async executeCommand(id: string, ...args: unknown[]) {
      if (id === "setContext") {
        calls.context[args[0] as string] = args[1];
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
      const t = { options, shown: false, show() { this.shown = true; }, sendText() { throw new Error("sendText must not be used"); } };
      calls.terminals.push(t);
      return t;
    },
    async showErrorMessage(message: string, ...items: string[]) {
      calls.errors.push({ message, items });
      return calls.nextErrorChoice;
    },
    async showInformationMessage(message: string) {
      calls.infos.push(message);
      return undefined;
    },
    async showWarningMessage(message: string) {
      calls.warnings.push(message);
      return undefined;
    },
    async showInputBox(options: unknown) {
      calls.inputs.push(options);
      return calls.nextInput;
    },
    registerTreeDataProvider(id: string, provider: unknown) {
      calls.treeProviders.set(id, provider);
      return { dispose: () => calls.treeProviders.delete(id) };
    },
    async withProgress(options: { title: string }, task: (p: unknown, c: unknown) => Promise<unknown>) {
      const rec = { title: options.title, messages: [] as string[] };
      calls.progress.push(rec);
      return task({ report: (v: { message: string }) => rec.messages.push(v.message) }, { isCancellationRequested: false });
    },
  },
  env: {
    async openExternal(uri: Uri) {
      calls.opened.push(uri.toString());
      return true;
    },
    clipboard: {
      async writeText(text: string) {
        calls.clipboard = text;
      },
    },
  },
  workspace: {
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
