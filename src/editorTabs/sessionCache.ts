import * as vscode from 'vscode';
import type { ChatTabTarget } from './uri';
import { type PersistedChatSnapshot, toPersistedChatSnapshot } from './persistedSnapshot';

const TAB_STATE_KEY = 'piRpc.editorTabs.tabState.v1';
const OPEN_RESOURCES_KEY = 'piRpc.editorTabs.openResources.v1';

export { toPersistedChatSnapshot };

export interface ChatTabState {
  target: ChatTabTarget;
  resource: string;
  lastKnownTitle: string;
  lastSnapshot?: PersistedChatSnapshot;
  lastViewedAt: number;
  isLiveBound: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export class ChatTabStateCache implements vscode.Disposable {
  private readonly states = new Map<string, ChatTabState>();
  private readonly openResources = new Set<string>();
  private dirty = false;
  private persistTimer: ReturnType<typeof setTimeout> | undefined;
  private persisting: Promise<void> | undefined;
  private disposed = false;

  public constructor(private readonly context: vscode.ExtensionContext) {
    const savedStates = this.context.workspaceState.get<Record<string, ChatTabState>>(
      TAB_STATE_KEY,
      {}
    );
    const savedResources = this.context.workspaceState.get<string[]>(OPEN_RESOURCES_KEY, []);
    for (const [resource, value] of Object.entries(savedStates)) {
      const state = asRecord(value);
      if (!state) {
        continue;
      }
      this.states.set(resource, value);
    }
    for (const resource of savedResources) {
      if (typeof resource === 'string') {
        this.openResources.add(resource);
      }
    }
  }

  public async dispose(): Promise<void> {
    this.disposed = true;
    try {
      await this.persist();
    } catch {
      // Session files remain authoritative when VS Code storage is unavailable at shutdown.
    } finally {
      this.states.clear();
      this.openResources.clear();
    }
  }

  public get(resource: vscode.Uri | string): ChatTabState | undefined {
    return this.states.get(typeof resource === 'string' ? resource : resource.toString());
  }

  public list(): ChatTabState[] {
    return [...this.states.values()].sort((left, right) => right.lastViewedAt - left.lastViewedAt);
  }

  public getOpenResources(): string[] {
    return [...this.openResources.values()];
  }

  public async set(state: ChatTabState, options?: { defer?: boolean }): Promise<void> {
    if (this.disposed) return;
    this.states.set(state.resource, state);
    this.dirty = true;
    if (options?.defer) this.schedulePersist();
    else await this.persist();
  }

  public async delete(resource: vscode.Uri | string): Promise<void> {
    if (this.disposed) return;
    const key = typeof resource === 'string' ? resource : resource.toString();
    this.states.delete(key);
    this.openResources.delete(key);
    this.dirty = true;
    await this.persist();
  }

  public async markOpen(resource: vscode.Uri | string): Promise<void> {
    if (this.disposed) return;
    this.openResources.add(typeof resource === 'string' ? resource : resource.toString());
    this.dirty = true;
    await this.persist();
  }

  public async markClosed(resource: vscode.Uri | string): Promise<void> {
    if (this.disposed) return;
    this.openResources.delete(typeof resource === 'string' ? resource : resource.toString());
    this.dirty = true;
    await this.persist();
  }

  private schedulePersist(): void {
    if (this.persistTimer || this.persisting || this.disposed) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      void this.persist().catch(() => {});
    }, 500);
    this.persistTimer.unref?.();
  }

  private persist(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
    }
    if (this.persisting) return this.persisting.then(() => this.persist());
    if (!this.dirty) return Promise.resolve();
    this.dirty = false;
    let failed = false;
    const write = Promise.allSettled([
      this.context.workspaceState.update(TAB_STATE_KEY, Object.fromEntries(this.states.entries())),
      this.context.workspaceState.update(OPEN_RESOURCES_KEY, [...this.openResources.values()]),
    ])
      .then((results) => {
        const failed = results.find((result) => result.status === 'rejected');
        if (failed) throw failed.reason;
      })
      .catch((error: unknown) => {
        failed = true;
        this.dirty = true;
        throw error;
      })
      .finally(() => {
        this.persisting = undefined;
        if (this.dirty && !failed) this.schedulePersist();
      });
    this.persisting = write;
    return write;
  }
}
