import * as vscode from 'vscode';

// #3 (review round 2): ONE coalescing notifier for background-chat events.
// During parallel work, completion + approval + context toasts stacked five
// deep; now anything arriving within a short window collapses into a single
// digest ("π: 2 finished · 1 needs approval") with one entry point.
type Kind = 'completed' | 'approval' | 'context';

interface Item {
  kind: Kind;
  title: string;
  detail?: string;
  open?: () => void;
}

const FLUSH_MS = 1500;

class Notifier {
  private pending: Item[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;

  public notify(item: Item): void {
    this.pending.push(item);
    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), FLUSH_MS);
      this.timer.unref?.();
    }
  }

  private flush(): void {
    this.timer = undefined;
    const items = this.pending.splice(0);
    if (items.length === 0) {
      return;
    }
    if (items.length === 1) {
      this.single(items[0]!);
      return;
    }
    this.digest(items);
  }

  private single(item: Item): void {
    const open = item.open;
    const show =
      item.kind === 'completed'
        ? vscode.window.showInformationMessage
        : vscode.window.showWarningMessage;
    const message =
      item.kind === 'completed'
        ? `π finished responding in ${item.title}.`
        : item.kind === 'approval'
          ? `π is waiting for your approval in ${item.title}.`
          : `π chat ${item.title} is at ${item.detail ?? 'high'} context — compact soon to avoid losing thread.`;
    void show(message, 'Open Chat').then((choice) => {
      if (choice === 'Open Chat') {
        open?.();
      }
    });
  }

  private digest(items: Item[]): void {
    const count = (kind: Kind): number => items.filter((item) => item.kind === kind).length;
    const parts: string[] = [];
    const completed = count('completed');
    const approval = count('approval');
    const context = count('context');
    if (completed > 0) {
      parts.push(`${completed} finished`);
    }
    if (approval > 0) {
      parts.push(`${approval} need${approval === 1 ? 's' : ''} approval`);
    }
    if (context > 0) {
      parts.push(`${context} near context limit`);
    }
    const message = `π: ${parts.join(' · ')}`;
    const show =
      approval > 0 || context > 0
        ? vscode.window.showWarningMessage
        : vscode.window.showInformationMessage;
    void show(message, 'Show Chats').then((choice) => {
      if (choice === 'Show Chats') {
        void vscode.commands.executeCommand('piRpc.showRunningChats');
      }
    });
  }
}

export const notifier = new Notifier();
