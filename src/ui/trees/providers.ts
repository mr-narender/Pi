import * as vscode from 'vscode';
import type { RecentSessionService } from '../../sessions/recentSessionService';
import type { ChatTabManager } from '../../editorTabs/tabManager';
import { createOpenChatListModel, type SidebarNode, type OpenChatEntry } from './sessionSidebarModel';

function nodeToTreeItem(node: SidebarNode): vscode.TreeItem {
  const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
  item.description = node.description;
  item.tooltip = node.tooltip ?? node.detail ?? node.description;
  item.contextValue = node.contextValue ?? `piRpc.${node.kind}`;
  if (node.command) {
    item.command = node.command;
  }
  if (node.icon) {
    item.iconPath = new vscode.ThemeIcon(node.icon);
  }
  item.accessibilityInformation = {
    label: node.accessibilityLabel ?? [node.label, node.description].filter(Boolean).join('. '),
    role: 'treeitem',
  };
  return item;
}

/** Agentic Mode's "Open Chat List" — ONE consolidated view (Open + Recent
 * sections, deduped against each other) replacing an earlier attempt that
 * shipped two separate, near-duplicate views (see sessionSidebarModel.ts's
 * comment for the real root cause: both drew from the same recent-sessions
 * array, there was never a distinct "currently open" data source behind
 * them). This one uses ChatTabManager.listOpenChats() for the real thing. */
export class OpenChatListTreeProvider
  implements vscode.TreeDataProvider<SidebarNode>, vscode.Disposable
{
  private readonly emitter = new vscode.EventEmitter<void>();
  private readonly subscriptions: vscode.Disposable[] = [];
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  /** Last content actually shown, so refresh() can skip firing when nothing
   * really changed — e.g. clicking an already-known chat still fires the
   * open-chats/recentSessions events, but if the resulting list is
   * byte-identical to what's already on screen there's nothing to redraw. */
  private lastRenderedKey: string | undefined;

  public constructor(
    private readonly chatTabs: ChatTabManager,
    private readonly recentSessions: RecentSessionService
  ) {
    this.subscriptions.push(
      this.chatTabs.onDidChangeOpenChats(() => this.refresh()),
      this.recentSessions.onDidChange(() => this.refresh())
    );
  }

  public get onDidChangeTreeData(): vscode.Event<void> {
    return this.emitter.event;
  }

  /** Debounced AND diffed against STABLE IDENTITY, not rendered text.
   * Debounce: one user action can fire multiple underlying events (opening
   * a chat fires onDidChangeOpenChats, and recentSessions itself fires
   * twice per refresh — loading, then settled) — collapse into one check.
   * Diff: rendered SidebarNode descriptions include "5m ago"-style relative
   * timestamps that drift with real wall-clock time even when NOTHING about
   * the underlying data changed — comparing the full rendered nodes was
   * itself a source of spurious "changed" detections. Comparing a reduced,
   * time-independent identity (which resources are open + which is active +
   * which session ids are listed) avoids that while still catching every
   * real change (chat opened/closed, active chat switched). */
  public refresh(): void {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      const { identityKey } = this.computeModel();
      if (identityKey === this.lastRenderedKey) {
        return;
      }
      this.lastRenderedKey = identityKey;
      this.emitter.fire();
    }, 120);
  }

  public getTreeItem(element: SidebarNode): vscode.TreeItem {
    return nodeToTreeItem(element);
  }

  public async getChildren(element?: SidebarNode): Promise<SidebarNode[]> {
    if (element) {
      return [];
    }
    const { nodes, identityKey } = this.computeModel();
    this.lastRenderedKey = identityKey;
    return nodes;
  }

  private computeModel(): { nodes: SidebarNode[]; identityKey: string } {
    const rawOpenChats = this.chatTabs.listOpenChats();
    const openChats: OpenChatEntry[] = rawOpenChats.map((chat) => ({
      resource: chat.resource.toString(),
      title: chat.title,
      sessionFile:
        typeof chat.controller.snapshot.state.sessionFile === 'string'
          ? chat.controller.snapshot.state.sessionFile
          : undefined,
      active: chat.visible,
    }));
    const folder = rawOpenChats[0]?.controller.folder ?? vscode.workspace.workspaceFolders?.[0];
    // NOT calling recentSessions.refresh(folder) here on purpose. getState()
    // already refreshes ONCE, internally, the first time a folder has no
    // cached state (see recentSessionService.ts). An explicit unconditional
    // refresh() call here — which was the actual bug — combined with the
    // onDidChange listener re-triggering getChildren(), created a
    // self-sustaining loop: refresh fires `loading:true` synchronously ->
    // listener re-fetches -> refresh again -> forever. getState() alone is
    // the same pattern this tree's predecessor code always used.
    const recent = folder
      ? this.recentSessions.getState(folder)
      : { loading: false, filterText: '', items: [] };
    const nodes = createOpenChatListModel({ openChats, recent });
    const identityKey = JSON.stringify({
      open: openChats.map((c) => [c.resource, c.sessionFile, c.active]),
      recentLoading: recent.loading,
      recentError: recent.error,
      // Session identity + modifiedAt (a real change), NOT any rendered
      // "X ago" text (which changes with wall-clock time alone).
      recentIds: recent.items.map((s) => [s.id, s.path, s.modifiedAt]),
    });
    return { nodes, identityKey };
  }

  public dispose(): void {
    clearTimeout(this.refreshTimer);
    for (const disposable of this.subscriptions) {
      disposable.dispose();
    }
    this.emitter.dispose();
  }
}
