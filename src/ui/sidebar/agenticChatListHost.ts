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

/** Agentic's chat list in the sidebar. A
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
    return { ...model, rows: applyPendingDeletions(model, this.pendingDeletions) };
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
        const id = sessionPath ?? resource;
        if (!id || this.pendingDeletions.some((entry) => entry.id === id)) return;
        this.pendingDeletions.push({ id });
        void this.pushSnapshot();
        try {
          if (sessionPath) {
            await vscode.commands.executeCommand('piRpcInternal.deleteSession', { sessionPath });
          } else if (resource) {
            // A fresh draft has no file to delete; closing its tab removes it.
            await this.chatTabs.closeResource(vscode.Uri.parse(resource));
          }
        } catch (error) {
          this.pendingDeletions = this.pendingDeletions.filter((entry) => entry.id !== id);
          await this.view?.webview.postMessage({ type: 'deleteFailed', id });
          void vscode.window.showErrorMessage(
            `Could not delete chat: ${error instanceof Error ? error.message : String(error)}`
          );
          this.snapshotState.lastIdentity = undefined;
          void this.pushSnapshot();
          return;
        }
        this.pendingDeletions = this.pendingDeletions.filter((entry) => entry.id !== id);
        // For a session file, deleteSession has synchronously removed the
        // cached record. An in-flight scan cannot reintroduce it.
        void this.pushSnapshot();
        await this.view?.webview.postMessage({ type: 'deleteSucceeded', id });
        return;
      }
      default:
        return;
    }
  }

  /** Release view wiring while retaining the list data subscriptions. */
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
