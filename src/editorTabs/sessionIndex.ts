import type * as vscode from 'vscode';
import { parseChatUri } from './uri';
import { chatTargetSessionKey, type ChatTabTarget } from './uriContract';
import type { SessionController } from '../sessions/sessionController';
import { VersionedStore } from '../state/store';

/**
 * #2 (hardening review): the ONE owner of tab↔session identity. Previously this
 * lived in five coordinated mechanisms spread through ChatTabManager
 * (controllerResource map, draftBindings + persistence, resolveTarget, keyFor,
 * rekey call sites) — the source of a whole class of drift bugs. All identity
 * questions now route through this class:
 *
 *   resolveTarget(uri)  — the EFFECTIVE target (a bound draft → its session)
 *   keyFor(uri)         — the registry/controller key for a resource
 *   bind/unbind         — draft-tab → session binding (persisted, reload-safe)
 *   setOwner/ownerOf    — which tab a controller repaints
 */
export class SessionIndex {
  // WeakMap: a disposed controller must not be pinned by its owner entry.
  private readonly owners = new WeakMap<SessionController, vscode.Uri>();
  private readonly bindings = new Map<string, ChatTabTarget>();
  private loaded = false;
  private readonly store: VersionedStore;

  public constructor(memento: vscode.Memento) {
    this.store = new VersionedStore(memento);
  }

  private load(): void {
    if (this.loaded) {
      return;
    }
    this.loaded = true;
    const raw = this.store.get<Record<string, ChatTabTarget>>('draftBindings', {});
    for (const [uri, target] of Object.entries(raw)) {
      this.bindings.set(uri, target);
    }
  }

  private persist(): void {
    const raw: Record<string, ChatTabTarget> = {};
    for (const [uri, target] of this.bindings) {
      raw[uri] = target;
    }
    this.store.set('draftBindings', raw);
  }

  /** The EFFECTIVE target for a resource: a bound draft resolves to its session. */
  public resolveTarget(resource: vscode.Uri): ChatTabTarget | undefined {
    const parsed = parseChatUri(resource);
    if (!parsed) {
      return undefined;
    }
    if (parsed.kind === 'workspaceDraft') {
      this.load();
      const bound = this.bindings.get(resource.toString());
      if (bound) {
        return bound;
      }
    }
    return parsed;
  }

  public keyFor(resource: vscode.Uri): string {
    const target = this.resolveTarget(resource);
    return target ? chatTargetSessionKey(target) : resource.toString();
  }

  /** Bind a draft tab to its real session (persisted across reloads). */
  public bind(resource: vscode.Uri, target: ChatTabTarget): void {
    this.load();
    this.bindings.set(resource.toString(), target);
    this.persist();
  }

  /** @returns true when a binding existed and was removed. */
  public unbind(resourceKey: string): boolean {
    this.load();
    const had = this.bindings.delete(resourceKey);
    if (had) {
      this.persist();
    }
    return had;
  }

  /** Remember which tab this controller repaints (per-tab dedicated model). */
  public setOwner(controller: SessionController, resource: vscode.Uri): void {
    this.owners.set(controller, resource);
  }

  public ownerOf(controller: SessionController): vscode.Uri | undefined {
    return this.owners.get(controller);
  }
}
