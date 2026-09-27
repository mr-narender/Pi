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

  /** Debounced on purpose: opening one new chat fires BOTH
   * onDidChangeOpenChats and recentSessions.onDidChange (twice — loading,
   * then settled) — three real events for one user action. Without this,
   * the tree visibly re-renders 2-3 times per click ("why does it keep
   * reloading"). Collapsing rapid-fire events into one settled update is
   * the same pattern already used for the webview's own render coalescing. */
  public refresh(): void {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => this.emitter.fire(), 120);
  }

  public getTreeItem(element: SidebarNode): vscode.TreeItem {
    return nodeToTreeItem(element);
  }

  public async getChildren(element?: SidebarNode): Promise<SidebarNode[]> {
    if (element) {
      return [];
    }
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
    if (!folder) {
      return createOpenChatListModel({ openChats, recent: { loading: false, filterText: '', items: [] } });
    }
    // NOT calling recentSessions.refresh(folder) here on purpose. getState()
    // already refreshes ONCE, internally, the first time a folder has no
    // cached state (see recentSessionService.ts). An explicit unconditional
    // refresh() call here — which was the actual bug — combined with the
    // onDidChange listener re-triggering getChildren(), created a
    // self-sustaining loop: refresh fires `loading:true` synchronously ->
    // listener re-fetches -> refresh again -> forever. getState() alone is
    // the same pattern this tree's predecessor code always used.
    return createOpenChatListModel({ openChats, recent: this.recentSessions.getState(folder) });
  }

  public dispose(): void {
    clearTimeout(this.refreshTimer);
    for (const disposable of this.subscriptions) {
      disposable.dispose();
    }
    this.emitter.dispose();
  }
}
