import * as vscode from 'vscode';
import * as path from 'node:path';
import type { ChatTabManager } from '../../editorTabs/tabManager';
import type { RecentSessionService } from '../../sessions/recentSessionService';
import { buildChatListModel } from '../../webview/chatListData';
import {
  applyPendingDeletions,
  decideSnapshotPush,
  type ChatListModel,
  type PendingDeletion,
  type SnapshotDecisionState,
} from '../../webview/chatListShared';
import { renderChatListWebviewHtml } from '../../webview/chatListHtml';

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Agentic Mode's chat list — the sidebar's only content in that mode. A
 * dedicated webview, not the native TreeView the first two attempts used:
 * a vscode.TreeDataProvider has no extension-facing API for row spacing,
 * font size, or custom (non-Codicon) icons/buttons — verified against
 * VS Code's own listView.ts (row height is set by the internal renderer,
 * never exposed to extensions) and the VS Code team's own admission that
 * list/tree isn't a good fit for chat UI (microsoft/vscode#268858).
 *
 * Reuses the SAME real data sources as the tree-view attempt
 * (ChatTabManager.listOpenChats() for "open", RecentSessionService for
 * "recent") and the SAME lesson learned there: diff on stable identity
 * (ids/paths/active flags), never on rendered text — comparing rendered
 * output caused a real "reloads on every click" bug there. */
const FAVORITES_KEY = 'piRpc.chatList.favorites';

export class AgenticChatListHost implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private view: vscode.WebviewView | undefined;
  private messageSub: vscode.Disposable | undefined;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private snapshotState: SnapshotDecisionState = { hasShownRealData: false };
  private pendingDeletions: PendingDeletion[] = [];

  public constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly chatTabs: ChatTabManager,
    private readonly recentSessions: RecentSessionService,
    private readonly folder: vscode.WorkspaceFolder,
    /** globalState (not workspaceState): a starred chat should stay starred
     * when the same session shows up under another window/workspace. */
    private readonly globalState: vscode.Memento
  ) {
    this.disposables.push(
      chatTabs.onDidChangeOpenChats(() => this.scheduleRefresh()),
      recentSessions.onDidChange(() => this.scheduleRefresh())
    );
  }

  public attach(view: vscode.WebviewView): void {
    this.messageSub?.dispose();
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri, vscode.Uri.joinPath(this.extensionUri, 'dist')],
    };
    view.webview.html = renderChatListWebviewHtml(this.extensionUri, view.webview, __PI_BUILD__);
    this.snapshotState = { hasShownRealData: false };
    // If the view was showing something ELSE just before (Chat mode's
    // SidebarChatHost took it over, then the user switched back), its own
    // message listener is still live — vscode.Event supports multiple
    // subscribers, it does NOT replace a previous one just because
    // onDidReceiveMessage is called again. Nothing here can dispose that
    // other listener (it isn't ours); the mode-switch caller in
    // extension.ts is responsible for tearing down whichever host owned
    // this view before switching to a different one.
    this.messageSub = view.webview.onDidReceiveMessage((message) => void this.onMessage(message));
    void this.recentSessions.refresh(this.folder);
    void this.pushSnapshot();
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    // Matches the tree-view attempt's debounce: a few event sources
    // (open-chats changed, recent-sessions changed) can fire together for
    // one user action; settle to a single re-render.
    this.refreshTimer = setTimeout(() => void this.pushSnapshot(), 120);
  }

  private favorites(): Set<string> {
    const stored = this.globalState.get<unknown>(FAVORITES_KEY);
    return new Set(
      Array.isArray(stored)
        ? stored.filter((entry): entry is string => typeof entry === 'string')
        : []
    );
  }

  private buildModel(): ChatListModel {
    const openChats = this.chatTabs.listOpenChats().map((chat) => ({
      resource: chat.resource.toString(),
      title: chat.title,
      sessionFile: asString(chat.controller.snapshot.state.sessionFile),
      active: chat.visible,
    }));
    const model = buildChatListModel({
      openChats,
      recent: this.recentSessions.getState(this.folder),
      favorites: this.favorites(),
    });
    if (this.pendingDeletions.length === 0) {
      return model;
    }
    const { rows, stillPending } = applyPendingDeletions(model, this.pendingDeletions, Date.now());
    this.pendingDeletions = stillPending;
    return { ...model, rows };
  }

  private async pushSnapshot(): Promise<void> {
    if (!this.view) {
      return;
    }
    const model = this.buildModel();
    const decision = decideSnapshotPush(model, this.snapshotState);
    this.snapshotState = {
      lastIdentity: decision.lastIdentity,
      hasShownRealData: decision.hasShownRealData,
    };
    if (!decision.push) {
      return;
    }
    await this.view.webview.postMessage({ type: 'listSnapshot', model });
  }

  private async showChatChanges(rowId: string): Promise<void> {
    // Resolve the folder from our own model, never from a webview-supplied path.
    const row = this.buildModel().rows.find((item) => item.id === rowId);
    if (!row) return;
    const open = row.isOpen
      ? this.chatTabs.listOpenChats().find((chat) => `open:${chat.resource.toString()}` === rowId)
      : undefined;
    const recent = row.sessionPath
      ? this.recentSessions
          .getState(this.folder)
          .items.find((item) => item.path === row.sessionPath)
      : undefined;
    const folderPath = open?.controller.folder.uri.fsPath || recent?.cwd || this.folder.uri.fsPath;
    type Change = { uri: vscode.Uri };
    type Repo = {
      rootUri: vscode.Uri;
      state: { workingTreeChanges: Change[]; indexChanges: Change[]; mergeChanges: Change[] };
    };
    const extension = vscode.extensions.getExtension('vscode.git');
    let repos: Repo[] = [];
    try {
      const git =
        extension &&
        ((await extension.activate()) as
          | {
              getAPI(version: 1): { repositories: Repo[] };
            }
          | undefined);
      repos = git?.getAPI(1).repositories ?? [];
    } catch {
      // Git extension unavailable: treat it like a folder without a repository.
    }
    const inside = (root: string, file: string): boolean => {
      const relative = path.relative(root, file);
      return (
        relative === '' ||
        (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
      );
    };
    const repo = repos
      .filter((candidate) => inside(candidate.rootUri.fsPath, folderPath))
      .sort((a, b) => b.rootUri.fsPath.length - a.rootUri.fsPath.length)[0];
    if (!repo) {
      void vscode.window.showInformationMessage('No Git repository found for this chat folder.');
      return;
    }
    const changes = new Map<string, vscode.Uri>();
    for (const change of [
      ...repo.state.workingTreeChanges,
      ...repo.state.indexChanges,
      ...repo.state.mergeChanges,
    ]) {
      if (inside(folderPath, change.uri.fsPath)) changes.set(change.uri.toString(), change.uri);
    }
    if (!changes.size) {
      void vscode.window.showInformationMessage('No Git changes in this chat folder.');
      return;
    }
    const picked = await vscode.window.showQuickPick(
      [...changes.values()].map((uri) => ({
        label: path.relative(folderPath, uri.fsPath),
        uri,
      })),
      { placeHolder: `Git changes · ${path.basename(repo.rootUri.fsPath)}` }
    );
    if (!picked) return;
    try {
      await vscode.commands.executeCommand('git.openChange', picked.uri);
    } catch {
      await vscode.commands.executeCommand('vscode.open', picked.uri);
    }
  }

  private async onMessage(message: unknown): Promise<void> {
    const record = asRecord(message);
    switch (record?.type) {
      case 'requestListSnapshot':
        this.snapshotState.lastIdentity = undefined;
        return this.pushSnapshot();
      case 'showChatChanges':
        if (typeof record.rowId === 'string') await this.showChatChanges(record.rowId);
        return;
      case 'openChat': {
        const resource = asString(record.resource);
        const sessionPath = asString(record.sessionPath);
        if (record.isOpen && resource) {
          await vscode.commands.executeCommand('piRpcInternal.revealOpenChat', { resource });
        } else if (sessionPath) {
          await vscode.commands.executeCommand('piRpc.switchSession', {
            sessionPath,
            label: asString(record.label),
          });
        }
        return;
      }
      case 'filterChats': {
        // Full-history search: RecentSessionService applies the filter over
        // name/preview/workspace/model/id BEFORE our 20-row cap, and fires
        // its change event → scheduleRefresh → push. Empty text clears.
        this.recentSessions.setFilter(this.folder, asString(record.text) ?? '');
        return;
      }
      case 'toggleFavoriteChat': {
        const sessionPath = asString(record.sessionPath);
        if (sessionPath) {
          const favorites = this.favorites();
          if (favorites.has(sessionPath)) {
            favorites.delete(sessionPath);
          } else {
            favorites.add(sessionPath);
          }
          await this.globalState.update(FAVORITES_KEY, [...favorites]);
          void this.pushSnapshot();
        }
        return;
      }
      case 'renameChat': {
        const sessionPath = asString(record.sessionPath);
        if (sessionPath) {
          await vscode.commands.executeCommand('piRpcInternal.renameSession', {
            sessionPath,
            sessionLabel: asString(record.label),
          });
        }
        return;
      }
      case 'deleteChat': {
        const sessionPath = asString(record.sessionPath);
        const resource = asString(record.resource);
        // Optimistic: piRpcInternal.deleteSession deletes the file
        // immediately but only actually confirms it via a full, DELIBERATELY
        // slow sessions-dir rescan — waiting for that before hiding the row
        // is what reads as "takes a while to remove the deleted item". We
        // already know it's gone; show that now, self-heals in buildModel()
        // once the real rescan catches up (or un-hides it if the delete
        // actually failed — see applyPendingDeletions).
        if (sessionPath) {
          this.pendingDeletions.push({ id: sessionPath, startedAt: Date.now() });
        } else if (resource) {
          this.pendingDeletions.push({ id: resource, startedAt: Date.now() });
        }
        void this.pushSnapshot();
        if (sessionPath) {
          await vscode.commands.executeCommand('piRpcInternal.deleteSession', { sessionPath });
          return;
        }
        // No session file yet (a fresh draft) — nothing on disk to delete
        // via piRpcInternal.deleteSession, which requires one. Closing the
        // tab is the only meaningful action for this case.
        if (resource) {
          await this.chatTabs.closeResource(vscode.Uri.parse(resource));
        }
        return;
      }
      default:
        return;
    }
  }

  /** Switching to Chat mode: this instance is kept alive (constructed once,
   * lazily, in extension.ts) so switching back to Agentic mode later still
   * has a working auto-refresh — only the view-specific wiring goes away,
   * NOT the onDidChangeOpenChats/onDidChange subscriptions dispose() would
   * also tear down. Clearing `view` also stops a late, already-queued
   * scheduleRefresh() timer from posting into a view Chat mode now owns. */
  public detach(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    this.messageSub?.dispose();
    this.messageSub = undefined;
    this.view = undefined;
  }

  public dispose(): void {
    this.detach();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }
}
