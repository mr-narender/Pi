import * as vscode from 'vscode';
import type { RecentSessionService } from '../../sessions/recentSessionService';
import type { SessionRegistry } from '../../sessions/sessionRegistry';
import type { SessionController } from '../../sessions/sessionController';
import {
  createHelpSidebarModel,
  createSessionSidebarModel,
  type SidebarNode,
} from './sessionSidebarModel';

const SELECT_WORKSPACE_COMMAND = 'piRpcInternal.selectWorkspaceFolder';

class BasicItem extends vscode.TreeItem {
  public constructor(
    label: string,
    description?: string,
    collapsibleState = vscode.TreeItemCollapsibleState.None
  ) {
    super(label, collapsibleState);
    this.description = description;
  }
}

abstract class RegistryTreeProvider<T> implements vscode.TreeDataProvider<T>, vscode.Disposable {
  protected readonly emitter = new vscode.EventEmitter<void>();
  private readonly subscriptions: vscode.Disposable[] = [];

  public constructor(protected readonly registry: SessionRegistry) {
    for (const controller of registry.list()) {
      this.track(controller);
    }
  }

  public get onDidChangeTreeData(): vscode.Event<void> {
    return this.emitter.event;
  }

  public refresh(): void {
    this.emitter.fire();
  }

  public abstract getTreeItem(element: T): vscode.TreeItem;

  public abstract getChildren(element?: T): Promise<T[]>;

  public dispose(): void {
    for (const disposable of this.subscriptions) {
      disposable.dispose();
    }
    this.emitter.dispose();
  }

  protected track(controller: SessionController): void {
    this.subscriptions.push(controller.onDidChangeState(() => this.refresh()));
  }
}

function nodeToTreeItem(node: SidebarNode): vscode.TreeItem {
  const item = new vscode.TreeItem(
    node.label,
    node.children?.length
      ? vscode.TreeItemCollapsibleState.Expanded
      : vscode.TreeItemCollapsibleState.None
  );
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

export class SessionsTreeProvider extends RegistryTreeProvider<SidebarNode> {
  public constructor(
    registry: SessionRegistry,
    private readonly recentSessions: RecentSessionService,
    private readonly isFirstRun: () => boolean
  ) {
    super(registry);
    this.recentSessions.onDidChange(() => this.refresh());
  }

  public getTreeItem(element: SidebarNode): vscode.TreeItem {
    return nodeToTreeItem(element);
  }

  public async getChildren(element?: SidebarNode): Promise<SidebarNode[]> {
    if (element) {
      return element.children ?? [];
    }
    const active = this.registry.getActive();
    const folder = active?.folder;
    if (!folder && (vscode.workspace.workspaceFolders?.length ?? 0) > 1) {
      return [
        {
          id: 'workspace.pick',
          kind: 'action',
          label: 'Choose Workspace',
          description: 'Pick which workspace folder Pi should use.',
          icon: 'folder-library',
          command: { command: SELECT_WORKSPACE_COMMAND, title: 'Choose Workspace' },
        },
      ];
    }
    return createSessionSidebarModel({
      activeFolderName: folder?.name,
      activeFolderUri: folder?.uri.toString(),
      activeState: active?.snapshot,
      recent: folder
        ? this.recentSessions.getState(folder)
        : { loading: false, filterText: '', items: [] },
      isTrusted: vscode.workspace.isTrusted,
      isFirstRun: this.isFirstRun(),
    });
  }
}

export class HelpTreeProvider extends RegistryTreeProvider<SidebarNode> {
  public constructor(
    registry: SessionRegistry,
    private readonly isFirstRun: () => boolean
  ) {
    super(registry);
  }

  public getTreeItem(element: SidebarNode): vscode.TreeItem {
    return nodeToTreeItem(element);
  }

  public async getChildren(element?: SidebarNode): Promise<SidebarNode[]> {
    if (element) {
      return element.children ?? [];
    }
    return createHelpSidebarModel({ isFirstRun: this.isFirstRun() });
  }
}

function entryLabel(
  entry: Record<string, unknown>,
  index: number
): { label: string; icon: string } {
  if (entry.type === 'message') {
    const message =
      entry.message && typeof entry.message === 'object' && !Array.isArray(entry.message)
        ? (entry.message as Record<string, unknown>)
        : undefined;
    const role = typeof message?.role === 'string' ? message.role : undefined;
    if (role === 'user') {
      return { label: `User message ${index + 1}`, icon: 'person' };
    }
    if (role === 'assistant') {
      return { label: `Assistant reply ${index + 1}`, icon: 'sparkle' };
    }
    if (role === 'toolResult') {
      return { label: `Tool result ${index + 1}`, icon: 'tools' };
    }
  }
  if (entry.type === 'branch_summary') {
    return { label: `Branch summary ${index + 1}`, icon: 'git-branch' };
  }
  if (entry.type === 'label') {
    return { label: `Saved branch label ${index + 1}`, icon: 'tag' };
  }
  return {
    label: `${typeof entry.type === 'string' ? entry.type.replaceAll('_', ' ') : 'Entry'} ${index + 1}`,
    icon: 'list-tree',
  };
}

export class OutlineTreeProvider extends RegistryTreeProvider<vscode.TreeItem> {
  public getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  public async getChildren(): Promise<vscode.TreeItem[]> {
    const controller = this.registry.getActive();
    if (!controller) {
      return [new BasicItem('No active session', 'Start or resume a session first.')];
    }
    const intro = new BasicItem(
      'Conversation map',
      'Pick a user message below to start a branch from that point.'
    );
    intro.iconPath = new vscode.ThemeIcon('git-branch');
    return [
      intro,
      ...controller.snapshot.entries.slice(-100).map((entry, index) => {
        const data = entry as Record<string, unknown>;
        const meta = entryLabel(data, index);
        const item = new BasicItem(
          meta.label,
          typeof data.id === 'string' && controller.snapshot.leafId === data.id
            ? 'Current'
            : undefined
        );
        item.iconPath = new vscode.ThemeIcon(meta.icon);
        item.contextValue = 'piRpc.outlineEntry';
        item.accessibilityInformation = {
          label: [item.label, item.description].filter(Boolean).join('. '),
          role: 'treeitem',
        };
        item.tooltip = new vscode.MarkdownString().appendMarkdown(
          typeof data.id === 'string'
            ? `**${meta.label}**\n\nID: \`${data.id}\``
            : `**${meta.label}**`
        );
        const message =
          data.message && typeof data.message === 'object' && !Array.isArray(data.message)
            ? (data.message as Record<string, unknown>)
            : undefined;
        if (message?.role === 'user' && typeof data.id === 'string') {
          item.command = {
            command: 'piRpc.forkSession',
            title: 'Start Branch',
            arguments: [{ entryId: data.id }],
          };
          item.contextValue = 'piRpc.branchableEntry';
          item.tooltip = new vscode.MarkdownString().appendMarkdown(
            `**${meta.label}**\n\nSelect to start a new branch from this user message.`
          );
        }
        return item;
      }),
    ];
  }
}

export class QueueTreeProvider extends RegistryTreeProvider<vscode.TreeItem> {
  public getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  public async getChildren(): Promise<vscode.TreeItem[]> {
    const controller = this.registry.getActive();
    if (!controller) {
      return [new BasicItem('No active queue', 'Start or resume a session first.')];
    }
    const state = controller.snapshot;
    if (state.queue.steering.length === 0 && state.queue.followUp.length === 0) {
      const item = new BasicItem('No queued notes', 'Steering and follow-up queues are empty.');
      item.iconPath = new vscode.ThemeIcon('check');
      return [item];
    }
    return [
      ...state.queue.steering.map((value, index) => {
        const item = new BasicItem(`Steering note ${index + 1}`, value);
        item.iconPath = new vscode.ThemeIcon('list-unordered');
        return item;
      }),
      ...state.queue.followUp.map((value, index) => {
        const item = new BasicItem(`Follow-up note ${index + 1}`, value);
        item.iconPath = new vscode.ThemeIcon('list-unordered');
        return item;
      }),
    ];
  }
}

export class WorkflowTreeProvider extends RegistryTreeProvider<vscode.TreeItem> {
  public getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  public async getChildren(): Promise<vscode.TreeItem[]> {
    const controller = this.registry.getActive();
    if (!controller) {
      return [new BasicItem('No workflow data', 'Start or resume a session first.')];
    }
    const commands = controller.snapshot.commands.map((command) => {
      const name = typeof command.name === 'string' ? command.name : 'command';
      const sourceInfo =
        command.sourceInfo && typeof command.sourceInfo === 'object'
          ? JSON.stringify(command.sourceInfo)
          : undefined;
      const source = typeof command.source === 'string' ? command.source : 'pi';
      const item = new BasicItem(`Run /${name}`, source);
      item.iconPath = new vscode.ThemeIcon('terminal-cmd');
      item.tooltip = sourceInfo;
      item.command = {
        command: 'piRpc.prompt',
        title: 'Run Pi command',
        arguments: [`/${name}`],
      };
      return item;
    });
    const tools = controller.snapshot.tools.map((tool) => {
      const item = new BasicItem(tool.name, tool.isError ? 'Needs attention' : 'Available');
      item.iconPath = new vscode.ThemeIcon(tool.isError ? 'warning' : 'tools');
      item.tooltip = JSON.stringify(tool, null, 2);
      return item;
    });
    return [...commands, ...tools];
  }
}

export class DiagnosticsTreeProvider extends RegistryTreeProvider<vscode.TreeItem> {
  public getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  public async getChildren(): Promise<vscode.TreeItem[]> {
    const controller = this.registry.getActive();
    if (!controller) {
      return [new BasicItem('No diagnostics yet', 'Start or resume a session first.')];
    }
    if (controller.snapshot.diagnostics.length === 0) {
      const item = new BasicItem('No diagnostics yet', 'Everything looks healthy.');
      item.iconPath = new vscode.ThemeIcon('check');
      return [item];
    }
    return controller.snapshot.diagnostics.slice(-100).map((diagnostic) => {
      const item = new BasicItem(diagnostic.message, diagnostic.kind);
      item.tooltip = diagnostic.detail;
      item.iconPath = new vscode.ThemeIcon(
        diagnostic.kind === 'error' ? 'error' : diagnostic.kind === 'warning' ? 'warning' : 'info'
      );
      return item;
    });
  }
}
