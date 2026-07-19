import * as vscode from 'vscode';
import { SessionRegistry } from '../../sessions/sessionRegistry';
import type { SessionController } from '../../sessions/sessionController';

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

abstract class RegistryTreeProvider
  implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.Disposable
{
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

  public abstract getTreeItem(element: vscode.TreeItem): vscode.TreeItem;

  public abstract getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]>;

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

export class SessionsTreeProvider extends RegistryTreeProvider {
  public getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  public async getChildren(): Promise<vscode.TreeItem[]> {
    const active = this.registry.getActive()?.folder.uri.toString();
    return this.registry.list().map((controller) => {
      const state = controller.snapshot;
      const label =
        controller.folder.uri.toString() === active
          ? `${controller.folder.name} • active`
          : controller.folder.name;
      const item = new BasicItem(label, state.connectionState);
      item.command = {
        command: 'piRpcInternal.selectWorkspaceFolder',
        title: 'Select Pi RPC Workspace Folder',
        arguments: [controller.folder.uri.toString()],
      };
      item.contextValue = 'piRpc.session';
      return item;
    });
  }
}

export class OutlineTreeProvider extends RegistryTreeProvider {
  public getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  public async getChildren(): Promise<vscode.TreeItem[]> {
    const controller = this.registry.getActive();
    if (!controller) {
      return [];
    }
    return controller.snapshot.entries.slice(-100).map((entry, index) => {
      const type = typeof entry.type === 'string' ? entry.type : 'entry';
      const item = new BasicItem(
        `${index + 1}. ${type}`,
        typeof entry.id === 'string' ? entry.id : undefined
      );
      item.tooltip = new vscode.MarkdownString().appendCodeblock(
        JSON.stringify(entry, null, 2),
        'json'
      );
      if (typeof entry.id === 'string') {
        item.command = {
          command: 'piRpc.forkSession',
          title: 'Fork Session',
          arguments: [{ entryId: entry.id }],
        };
      }
      return item;
    });
  }
}

export class QueueTreeProvider extends RegistryTreeProvider {
  public getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  public async getChildren(): Promise<vscode.TreeItem[]> {
    const controller = this.registry.getActive();
    if (!controller) {
      return [];
    }
    const state = controller.snapshot;
    return [
      ...state.queue.steering.map((value) => new BasicItem(`Steer: ${value}`)),
      ...state.queue.followUp.map((value) => new BasicItem(`Follow-up: ${value}`)),
    ];
  }
}

export class WorkflowTreeProvider extends RegistryTreeProvider {
  public getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  public async getChildren(): Promise<vscode.TreeItem[]> {
    const controller = this.registry.getActive();
    if (!controller) {
      return [];
    }
    const commands = controller.snapshot.commands.map((command) => {
      const name = typeof command.name === 'string' ? command.name : 'command';
      const sourceInfo =
        command.sourceInfo && typeof command.sourceInfo === 'object'
          ? JSON.stringify(command.sourceInfo)
          : undefined;
      const source = typeof command.source === 'string' ? command.source : 'pi';
      const item = new BasicItem(name, source);
      item.tooltip = sourceInfo;
      item.command = {
        command: 'piRpc.prompt',
        title: 'Invoke Pi Command',
        arguments: [`/${name}`],
      };
      return item;
    });
    const tools = controller.snapshot.tools.map((tool) => {
      const item = new BasicItem(`Tool: ${tool.name}`, tool.isError ? 'error' : 'ok');
      item.tooltip = JSON.stringify(tool, null, 2);
      return item;
    });
    return [...commands, ...tools];
  }
}

export class DiagnosticsTreeProvider extends RegistryTreeProvider {
  public getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  public async getChildren(): Promise<vscode.TreeItem[]> {
    const controller = this.registry.getActive();
    if (!controller) {
      return [];
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
