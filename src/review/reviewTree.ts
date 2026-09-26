// π Review panel: persistent tree of the last agent turns and every file each
// one touched — diffstat per file, click = before↔after diff, inline revert.
// The trust loop for agentic edits: see exactly what changed, keep or undo.
import { basename } from 'node:path';
import * as vscode from 'vscode';
import type { TurnChange, TurnRecord, TurnReview } from './turnReview';

type ReviewNode =
  | { kind: 'turn'; record: TurnRecord & { title: string }; index: number }
  | { kind: 'file'; record: TurnRecord & { title: string }; change: TurnChange };

export class ReviewTreeProvider implements vscode.TreeDataProvider<ReviewNode> {
  private readonly emitter = new vscode.EventEmitter<void>();
  public readonly onDidChangeTreeData = this.emitter.event;

  public constructor(private readonly review: TurnReview) {
    review.onDidChange(() => this.emitter.fire());
  }

  public getChildren(element?: ReviewNode): ReviewNode[] {
    if (!element) {
      return this.review.history.map((record, index) => ({ kind: 'turn', record, index }));
    }
    if (element.kind === 'turn') {
      return element.record.changes.map((change) => ({
        kind: 'file',
        record: element.record,
        change,
      }));
    }
    return [];
  }

  public getTreeItem(node: ReviewNode): vscode.TreeItem {
    if (node.kind === 'turn') {
      const when = new Date(node.record.at).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
      });
      const files = node.record.changes.length;
      const item = new vscode.TreeItem(
        `${node.record.title} · ${when}`,
        node.index === 0
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.Collapsed
      );
      item.description = `${files} file${files === 1 ? '' : 's'}`;
      item.iconPath = new vscode.ThemeIcon('history');
      item.contextValue = 'piReviewTurn';
      return item;
    }
    const { change } = node;
    const icons: Record<TurnChange['kind'], string> = {
      modified: 'diff-modified',
      added: 'diff-added',
      deleted: 'diff-removed',
      new: 'new-file',
    };
    const item = new vscode.TreeItem(basename(change.file));
    const stat =
      change.added !== undefined || change.deleted !== undefined
        ? ` +${change.added ?? 0} −${change.deleted ?? 0}`
        : '';
    item.description = `${change.file}${stat}`;
    item.tooltip = `${change.file} (${change.kind}${stat})`;
    item.iconPath = new vscode.ThemeIcon(icons[change.kind]);
    item.contextValue = 'piReviewFile';
    item.command = {
      command: 'piRpc.reviewOpenDiff',
      title: 'Open diff',
      arguments: [node],
    };
    return item;
  }
}

/** Creates the tree view and returns the view + command HANDLERS.
 * Handlers must be wired through extension.ts's central `registrations` map —
 * registering commands directly here bypasses the activation self-check
 * (learned the hard way: it hard-fails activation). */
export function createReviewTree(review: TurnReview): {
  view: vscode.Disposable;
  handlers: Record<string, (node: ReviewNode) => Promise<void>>;
} {
  const provider = new ReviewTreeProvider(review);
  const view = vscode.window.createTreeView('piRpc.review', {
    treeDataProvider: provider,
    showCollapseAll: true,
  });
  const handlers: Record<string, (node: ReviewNode) => Promise<void>> = {
    'piRpc.reviewOpenDiff': async (node) => {
      if (node?.kind === 'file') {
        await review.openDiff(node.record, node.change);
      }
    },
    'piRpc.reviewRevertFile': async (node) => {
      if (node?.kind !== 'file') {
        return;
      }
      const confirm = await vscode.window.showWarningMessage(
        `Revert ${node.change.file} to its state before this turn?`,
        { modal: true },
        'Revert'
      );
      if (confirm === 'Revert') {
        await review.revertFile(node.record, node.change); // tree + editor show it
      }
    },
    'piRpc.reviewRevertTurn': async (node) => {
      if (node?.kind !== 'turn') {
        return;
      }
      const count = node.record.changes.length;
      const confirm = await vscode.window.showWarningMessage(
        `Revert all ${count} file(s) from this turn?`,
        { modal: true },
        'Revert All'
      );
      if (confirm === 'Revert All') {
        for (const change of node.record.changes) {
          await review.revertFile(node.record, change).catch(() => undefined);
        }
      }
    },
  };
  return { view, handlers };
}
