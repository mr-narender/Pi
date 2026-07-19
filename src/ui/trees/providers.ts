import * as vscode from 'vscode';
import type { RecentSessionService } from '../../sessions/recentSessionService';
import type { SessionRegistry } from '../../sessions/sessionRegistry';
import type { SessionController } from '../../sessions/sessionController';
import {
  createNewChatSidebarModel,
  createResumeChatSidebarModel,
  createSessionsSidebarModel,
  type SidebarNode,
} from './sessionSidebarModel';
import type { ChatUiState } from '../../webview/composerState';

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

abstract class RegistryTreeProvider
  implements vscode.TreeDataProvider<SidebarNode>, vscode.Disposable
{
  protected readonly emitter = new vscode.EventEmitter<void>();
  private readonly subscriptions: vscode.Disposable[] = [];

  public constructor(
    protected readonly registry: SessionRegistry,
    protected readonly uiState: ChatUiState
  ) {
    for (const controller of registry.list()) {
      this.track(controller);
    }
    this.subscriptions.push(uiState.onDidChange(() => this.refresh()));
  }

  public get onDidChangeTreeData(): vscode.Event<void> {
    return this.emitter.event;
  }

  public refresh(): void {
    this.emitter.fire();
  }

  public getTreeItem(element: SidebarNode): vscode.TreeItem {
    return nodeToTreeItem(element);
  }

  public abstract getChildren(element?: SidebarNode): Promise<SidebarNode[]>;

  public dispose(): void {
    for (const disposable of this.subscriptions) {
      disposable.dispose();
    }
    this.emitter.dispose();
  }

  protected track(controller: SessionController): void {
    this.subscriptions.push(controller.onDidChangeState(() => this.refresh()));
  }

  protected async sidebarInput(recentSessions: RecentSessionService) {
    const active = this.registry.getActive();
    const composer = active ? await this.uiState.getComposerState(active) : undefined;
    return {
      activeFolderName: active?.folder.name,
      activeState: active?.snapshot,
      recent: active
        ? recentSessions.getState(active.folder)
        : { loading: false, filterText: '', items: [] },
      hasDraft: (composer?.draft.trim().length ?? 0) > 0,
      hasPendingAttachments:
        (composer?.pendingContextItems.length ?? 0) + (composer?.pendingImages.length ?? 0) > 0,
      showWorkspacePicker: (vscode.workspace.workspaceFolders?.length ?? 0) > 1,
    };
  }
}

export class NewChatTreeProvider extends RegistryTreeProvider {
  public constructor(
    registry: SessionRegistry,
    private readonly recentSessions: RecentSessionService,
    uiState: ChatUiState
  ) {
    super(registry, uiState);
    this.recentSessions.onDidChange(() => this.refresh());
  }

  public async getChildren(element?: SidebarNode): Promise<SidebarNode[]> {
    if (element) {
      return [];
    }
    return createNewChatSidebarModel(await this.sidebarInput(this.recentSessions));
  }
}

export class SessionsTreeProvider extends RegistryTreeProvider {
  public constructor(
    registry: SessionRegistry,
    private readonly recentSessions: RecentSessionService,
    uiState: ChatUiState
  ) {
    super(registry, uiState);
    this.recentSessions.onDidChange(() => this.refresh());
  }

  public async getChildren(element?: SidebarNode): Promise<SidebarNode[]> {
    if (element) {
      return [];
    }
    return createSessionsSidebarModel(await this.sidebarInput(this.recentSessions));
  }
}

export class ResumeChatTreeProvider extends RegistryTreeProvider {
  public constructor(
    registry: SessionRegistry,
    private readonly recentSessions: RecentSessionService,
    uiState: ChatUiState
  ) {
    super(registry, uiState);
    this.recentSessions.onDidChange(() => this.refresh());
  }

  public async getChildren(element?: SidebarNode): Promise<SidebarNode[]> {
    if (element) {
      return [];
    }
    return createResumeChatSidebarModel(await this.sidebarInput(this.recentSessions));
  }
}
