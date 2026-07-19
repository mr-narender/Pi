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

  public dispose(): void {
    this.states.clear();
    this.openResources.clear();
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

  public async set(state: ChatTabState): Promise<void> {
    this.states.set(state.resource, state);
    await this.persist();
  }

  public async delete(resource: vscode.Uri | string): Promise<void> {
    const key = typeof resource === 'string' ? resource : resource.toString();
    this.states.delete(key);
    this.openResources.delete(key);
    await this.persist();
  }

  public async markOpen(resource: vscode.Uri | string): Promise<void> {
    this.openResources.add(typeof resource === 'string' ? resource : resource.toString());
    await this.persist();
  }

  public async markClosed(resource: vscode.Uri | string): Promise<void> {
    this.openResources.delete(typeof resource === 'string' ? resource : resource.toString());
    await this.persist();
  }

  private async persist(): Promise<void> {
    await Promise.all([
      this.context.workspaceState.update(TAB_STATE_KEY, Object.fromEntries(this.states.entries())),
      this.context.workspaceState.update(OPEN_RESOURCES_KEY, [...this.openResources.values()]),
    ]);
  }
}
