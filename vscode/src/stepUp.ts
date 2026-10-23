// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 crossVault GmbH
// Asking for one more permission: when the key lacks a scope (or the server answers 403 with
// `required_scope`), offer a new browser sign-in that names the scope. The current key stays in use
// until the new one arrives. A server that doesn't offer the scope gets a short "needs a newer
// server" message instead.
import * as vscode from "vscode";
import { ApiError, MESSAGES, SCOPE_ORGANIZE, SCOPE_PROFILES_READ, SCOPE_PROFILES_WRITE } from "./api";
import { LoginCancelled, Stored } from "./auth";

export interface ScopedAuth {
  current(): Promise<Stored | undefined>;
  stepUp(scope: string): Promise<string>;
}

const PURPOSE: Record<string, string> = {
  [SCOPE_PROFILES_READ]: "Showing your launch profiles",
  [SCOPE_PROFILES_WRITE]: "Changing launch profiles",
  [SCOPE_ORGANIZE]: "Moving sessions between folders",
};

export const STEP_UP = {
  prompt: (scope: string) => `${PURPOSE[scope] ?? "This"} needs the a4sx permission ${scope}. Sign in again in your browser to allow it.`,
  signIn: "Sign in",
  signInFirst: "Sign in to a4sx first.",
};

export function errorText(e: unknown): string {
  return e instanceof Error && e.message ? e.message : "Something went wrong. Try again.";
}

export function notSupportedFor(scope: string): string {
  return scope.startsWith("profiles:") ? MESSAGES.profilesNotSupported : MESSAGES.foldersNotSupported;
}

/**
 * Runs the new sign-in for `scope` (after a modal that names it, unless `ask` is false) and returns
 * the new key, or undefined when the user declined, cancelled, or the server can't grant it.
 */
export async function offerStepUp(auth: ScopedAuth, scope: string, ask = true): Promise<string | undefined> {
  if (ask) {
    const choice = await vscode.window.showInformationMessage(STEP_UP.prompt(scope), { modal: true }, STEP_UP.signIn);
    if (choice !== STEP_UP.signIn) {
      return undefined;
    }
  }
  try {
    return await auth.stepUp(scope);
  } catch (e) {
    if (e instanceof LoginCancelled) {
      return undefined;
    }
    if (e instanceof ApiError && e.code === "bad-scopes") {
      await vscode.window.showErrorMessage(notSupportedFor(scope));
      return undefined;
    }
    await vscode.window.showErrorMessage(errorText(e));
    return undefined;
  }
}

/** A key holding `scope`: the current one, or a new one from the step-up sign-in. */
export async function ensureScope(auth: ScopedAuth, scope: string): Promise<string | undefined> {
  const cur = await auth.current();
  if (!cur) {
    await vscode.window.showErrorMessage(STEP_UP.signInFirst);
    return undefined;
  }
  return cur.scopes.includes(scope) ? cur.token : offerStepUp(auth, scope);
}

/**
 * Runs `call` with `token`. If the server answers that the key lacks a scope, offers the step-up
 * sign-in for that scope and runs `call` once more with the new key. Other errors are thrown.
 * Resolves to undefined when the user declined the new sign-in.
 */
export async function callWithScope<T>(auth: ScopedAuth, token: string, call: (token: string) => Promise<T>): Promise<{ value: T } | undefined> {
  try {
    return { value: await call(token) };
  } catch (e) {
    if (!(e instanceof ApiError && e.code === "insufficient-scope" && e.requiredScope)) {
      throw e;
    }
    const again = await offerStepUp(auth, e.requiredScope);
    if (!again) {
      return undefined;
    }
    return { value: await call(again) };
  }
}
