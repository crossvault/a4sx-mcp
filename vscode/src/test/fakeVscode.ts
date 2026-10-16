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
}

export const calls: Calls = {
  commands: new Map(),
  mcpProviders: new Map(),
  terminals: [],
  errors: [],
  opened: [],
  config: {},
  nextErrorChoice: undefined,
};

export function resetCalls(): void {
  calls.commands.clear();
  calls.mcpProviders.clear();
  calls.terminals.length = 0;
  calls.errors.length = 0;
  calls.opened.length = 0;
  calls.config = {};
  calls.nextErrorChoice = undefined;
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

class McpHttpServerDefinition {
  constructor(public label: string, public uri: Uri, public headers: Record<string, string> = {}, public version?: string) {}
}

const fake = {
  Uri,
  EventEmitter,
  McpHttpServerDefinition,
  commands: {
    registerCommand(id: string, fn: (...args: unknown[]) => unknown) {
      calls.commands.set(id, fn);
      return { dispose: () => calls.commands.delete(id) };
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
  },
  env: {
    async openExternal(uri: Uri) {
      calls.opened.push(uri.toString());
      return true;
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
