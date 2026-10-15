import * as vscode from 'vscode';

// Coalesce background approval and context warnings into one entry point.
type Kind = 'approval' | 'context';

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
    const message =
      item.kind === 'approval'
        ? `π is waiting for your approval in ${item.title}.`
        : `π chat ${item.title} is at ${item.detail ?? 'high'} context — compact soon to avoid losing thread.`;
    void vscode.window.showWarningMessage(message, 'Open Chat').then((choice) => {
      if (choice === 'Open Chat') {
        open?.();
      }
    });
  }

  private digest(items: Item[]): void {
    const count = (kind: Kind): number => items.filter((item) => item.kind === kind).length;
    const parts: string[] = [];
    const approval = count('approval');
    const context = count('context');
    if (approval > 0) {
      parts.push(`${approval} need${approval === 1 ? 's' : ''} approval`);
    }
    if (context > 0) {
      parts.push(`${context} near context limit`);
    }
    const message = `π: ${parts.join(' · ')}`;
    void vscode.window.showWarningMessage(message, 'Show Chats').then((choice) => {
      if (choice === 'Show Chats') {
        void vscode.commands.executeCommand('piRpc.showRunningChats');
      }
    });
  }
}

export const notifier = new Notifier();
