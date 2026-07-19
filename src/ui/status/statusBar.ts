import * as vscode from 'vscode';
import { summarizeModel, summarizeQueue } from '../../state/selectors';
import type { SessionController } from '../../sessions/sessionController';

export class StatusBarController implements vscode.Disposable {
  private mode: 'simple' | 'advanced' = 'simple';
  private readonly connection = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100
  );
  private readonly model = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
  private readonly queue = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 98);
  private readonly usage = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 97);
  private readonly keyed = new Map<string, vscode.StatusBarItem>();
  private controller: SessionController | undefined;
  private subscription: vscode.Disposable | undefined;

  public constructor() {
    this.connection.command = 'piRpcInternal.showHealth';
    this.model.command = 'piRpc.showModels';
    this.queue.command = 'piRpcInternal.openChat';
    this.usage.command = 'piRpc.showSessionStats';
    this.connection.show();
    this.model.show();
    this.queue.show();
    this.usage.show();
  }

  public setMode(mode: 'simple' | 'advanced'): void {
    this.mode = mode;
    if (this.controller) {
      this.render(this.controller.snapshot);
    }
  }

  public bind(controller: SessionController | undefined): void {
    this.subscription?.dispose();
    this.controller = controller;
    if (controller) {
      this.subscription = controller.onDidChangeState((state) => this.render(state));
      this.render(controller.snapshot);
      return;
    }
    this.clearKeyed();
    this.connection.text = '$(plug) Pi RPC: inactive';
    this.model.text = '$(hubot) No model';
    this.queue.text = '$(list-unordered) Queue';
    this.usage.text = '$(pulse) Usage';
  }

  public dispose(): void {
    this.subscription?.dispose();
    this.clearKeyed();
    this.connection.dispose();
    this.model.dispose();
    this.queue.dispose();
    this.usage.dispose();
  }

  private render(state: SessionController['snapshot']): void {
    const folder = this.controller?.folder.name ?? state.workspaceFolderName;
    const visible = this.mode === 'advanced' || state.connectionState === 'faulted';
    if (!visible) {
      this.connection.hide();
      this.model.hide();
      this.queue.hide();
      this.usage.hide();
      this.clearKeyed();
      return;
    }
    this.connection.show();
    this.model.show();
    this.queue.show();
    this.usage.show();
    this.connection.text = `$(plug) ${folder}: ${state.connectionState}`;
    this.model.text = `$(hubot) ${summarizeModel(state)}`;
    this.queue.text = `$(list-unordered) ${summarizeQueue(state)}`;
    const stats = state.lastSessionStats;
    const total = typeof stats?.cost === 'number' ? stats.cost.toFixed(4) : 'n/a';
    this.usage.text = `$(pulse) Cost ${total}`;
    this.renderKeyedStatuses(state.statuses);
  }

  private renderKeyedStatuses(statuses: Record<string, string>): void {
    const seen = new Set(Object.keys(statuses));
    for (const [key, value] of Object.entries(statuses)) {
      const item = this.keyed.get(key) ?? this.createKeyedItem(key);
      item.text = `$(info) ${key}: ${value}`;
      item.tooltip = value;
      item.show();
    }
    for (const [key, item] of this.keyed.entries()) {
      if (!seen.has(key)) {
        item.hide();
      }
    }
  }

  private createKeyedItem(key: string): vscode.StatusBarItem {
    const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 96);
    item.command = 'piRpc.extensionUi.setStatus';
    this.keyed.set(key, item);
    return item;
  }

  private clearKeyed(): void {
    for (const item of this.keyed.values()) {
      item.dispose();
    }
    this.keyed.clear();
  }
}
