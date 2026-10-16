import type * as vscode from 'vscode';
import { parseChatUri } from './uri';
import { chatTargetSessionKey, type ChatTabTarget } from './uriContract';
import type { SessionController } from '../sessions/sessionController';
import { VersionedStore } from '../state/store';

type SavedBinding = { source: 'live' | 'legacy'; target: ChatTabTarget } | { source: 'ambiguous' };

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
  private readonly legacyStore?: VersionedStore;

  public constructor(memento: vscode.Memento, legacyWorkspaceState?: vscode.Memento) {
    this.store = new VersionedStore(memento);
    if (legacyWorkspaceState) this.legacyStore = new VersionedStore(legacyWorkspaceState);
  }

  private load(): void {
    if (this.loaded) {
      return;
    }
    this.loaded = true;
    const raw = {
      ...this.legacyStore?.get<Record<string, ChatTabTarget>>('draftBindings', {}),
      ...this.store.get<Record<string, ChatTabTarget>>('draftBindings', {}),
    };
    for (const [uri, original] of Object.entries(raw)) {
      const target =
        this.legacyStore?.get<ChatTabTarget>(`draftBinding:${uri}`, original) ?? original;
      this.bindings.set(uri, target);
      this.legacyStore?.set(`draftBinding:${uri}`, target);
      const saved = this.store.get<SavedBinding | undefined>(`draftBinding:${uri}`, undefined);
      if (!saved) {
        this.store.set<SavedBinding>(`draftBinding:${uri}`, { source: 'legacy', target });
      } else if (
        saved.source === 'legacy' &&
        chatTargetSessionKey(saved.target) !== chatTargetSessionKey(target)
      ) {
        this.store.set<SavedBinding>(`draftBinding:${uri}`, { source: 'ambiguous' });
      }
    }
  }

  /** The EFFECTIVE target for a resource: a bound draft resolves to its session. */
  public resolveTarget(resource: vscode.Uri): ChatTabTarget | undefined {
    const parsed = parseChatUri(resource);
    if (!parsed) {
      return undefined;
    }
    if (parsed.kind === 'workspaceDraft') {
      this.load();
      // Counter-based legacy drafts can mean different chats in different workspaces.
      if (!parsed.draftId || /^d\d+$/.test(parsed.draftId)) {
        const local =
          this.legacyStore?.get<ChatTabTarget | undefined>(
            `draftBinding:${resource.toString()}`,
            this.bindings.get(resource.toString())
          ) ?? this.bindings.get(resource.toString());
        if (local) return local;
      }
      const saved = this.store.get<SavedBinding | undefined>(
        `draftBinding:${resource.toString()}`,
        undefined
      );
      if (saved?.source === 'live') return saved.target;
      const local = this.bindings.get(resource.toString());
      if (local) return local;
      if (saved?.source === 'legacy') return saved.target;
      if (saved?.source === 'ambiguous') return undefined;
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
    const parsed = parseChatUri(resource);
    if (parsed?.kind === 'workspaceDraft' && (!parsed.draftId || /^d\d+$/.test(parsed.draftId))) {
      const key = `draftBinding:${resource.toString()}`;
      this.legacyStore?.set(key, target);
      const saved = this.store.get<SavedBinding | undefined>(key, undefined);
      this.store.set<SavedBinding>(
        key,
        !saved ||
          (saved.source !== 'ambiguous' &&
            chatTargetSessionKey(saved.target) === chatTargetSessionKey(target))
          ? { source: 'legacy', target }
          : { source: 'ambiguous' }
      );
      return;
    }
    this.store.set<SavedBinding>(`draftBinding:${resource.toString()}`, { source: 'live', target });
  }

  /** @returns true when a binding existed and was removed. */
  public unbind(resourceKey: string): boolean {
    this.load();
    const had = this.bindings.delete(resourceKey);
    // Closing a tab drops live ownership, not its saved restore identity.
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
