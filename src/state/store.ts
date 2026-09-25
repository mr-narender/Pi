import type * as vscode from 'vscode';

// #6 (hardening review): ONE versioned accessor for extension persistence
// instead of raw memento keys scattered across the codebase. Every key lives
// under the `piRpc.` namespace; `storeVersion` gives future migrations a hook
// (bump STORE_VERSION and translate inside the constructor).
const STORE_VERSION = 1;

export class VersionedStore {
  public constructor(
    private readonly memento: vscode.Memento,
    private readonly ns = 'piRpc'
  ) {
    const current = this.memento.get<number>(`${this.ns}.storeVersion`);
    if (current !== STORE_VERSION) {
      // v1: no migrations yet — existing raw keys are already in this shape.
      void this.memento.update(`${this.ns}.storeVersion`, STORE_VERSION);
    }
  }

  public get<T>(key: string, fallback: T): T {
    return this.memento.get<T>(`${this.ns}.${key}`, fallback);
  }

  public set<T>(key: string, value: T): void {
    void this.memento.update(`${this.ns}.${key}`, value);
  }
}
