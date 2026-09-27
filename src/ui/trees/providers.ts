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

  /** Debounced AND diffed. Debounce: one user action can fire multiple
   * underlying events (opening a chat fires onDidChangeOpenChats, and
   * recentSessions itself fires twice per refresh — loading, then
   * settled) — collapse those into one check. Diff: even after collapsing,
   * clicking a chat that's already known to the list changes nothing about
   * WHAT the list should show, so don't tell VS Code to redraw when the
   * computed content is identical to what's already rendered — that's what
   * was still visibly "reloading" the list on every click. */
  public refresh(): void {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      const nodes = this.computeModel();
      const key = JSON.stringify(nodes);
      if (key === this.lastRenderedKey) {
        return;
      }
      this.lastRenderedKey = key;
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
    const nodes = this.computeModel();
    this.lastRenderedKey = JSON.stringify(nodes);
    return nodes;
  }

  private computeModel(): SidebarNode[] {
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
