import * as vscode from 'vscode';
import type { SessionController } from '../../sessions/sessionController';

// The status bar is a PASSIVE Pi-status indicator only. All configuration
// (model, usage/cost, thinking level, etc.) lives in the chat composer toolbar
// so controls have a single, focused home and don't compete across surfaces.
export class StatusBarController implements vscode.Disposable {
  private mode: 'simple' | 'advanced' = 'simple';
  private readonly connection = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100
  );
  // Agent-driven transient statuses (e.g. plan mode) — informational, not config.
  private readonly keyed = new Map<string, vscode.StatusBarItem>();
  private controller: SessionController | undefined;
  private subscription: vscode.Disposable | undefined;

  public constructor() {
    this.connection.command = 'piRpcInternal.showHealth';
    this.connection.tooltip = 'Pi connection status — click for health details';
    this.connection.show();
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
    this.connection.text = '$(plug) Pi: inactive';
  }

  public dispose(): void {
    this.subscription?.dispose();
    this.clearKeyed();
    this.connection.dispose();
  }

  private render(state: SessionController['snapshot']): void {
    const folder = this.controller?.folder.name ?? state.workspaceFolderName;
    const visible = this.mode === 'advanced' || state.connectionState === 'faulted';
    if (!visible) {
      this.connection.hide();
      this.clearKeyed();
      return;
    }
    this.connection.show();
    this.connection.text = `$(plug) ${folder}: ${state.connectionState}`;
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
