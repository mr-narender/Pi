// Session replay: walk back through PAST turns, file by file, showing exactly
// what changed — a rewind for turns you didn't watch live. Reuses the same
// hunk-diff engine as line-by-line review and the persisted turn history.
// A violet glow (not live-ember) keeps "this already happened" visually
// distinct from "this is happening now" (the realtime follow caret).
import { join } from 'node:path';
import * as vscode from 'vscode';
import { computeHunks } from './hunks';
import type { TurnChange, TurnRecord, TurnReview } from './turnReview';

const STEP_MS = 1500;

export class SessionReplay implements vscode.Disposable {
  private readonly decoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: 'rgba(120, 160, 255, 0.16)',
    borderColor: 'rgba(120, 160, 255, 0.8)',
    borderStyle: 'solid',
    borderWidth: '0 0 0 2px',
    overviewRulerColor: 'rgba(120, 160, 255, 0.8)',
    overviewRulerLane: vscode.OverviewRulerLane.Right,
  });

  public constructor(private readonly review: TurnReview) {}

  /** Replay one turn's files in order. */
  public async replayTurn(record: TurnRecord & { title: string }): Promise<void> {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Replaying "${record.title}"`, cancellable: true },
      (progress, token) => this.walk([record], progress, token)
    );
  }

  /** Replay the WHOLE session, oldest turn first — tells the story of how it evolved. */
  public async replaySession(history: Array<TurnRecord & { title: string }>): Promise<void> {
    const ordered = [...history].reverse();
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Replaying session (${ordered.length} turn${ordered.length === 1 ? '' : 's'})`,
        cancellable: true,
      },
      (progress, token) => this.walk(ordered, progress, token)
    );
  }

  private async walk(
    turns: Array<TurnRecord & { title: string }>,
    progress: vscode.Progress<{ message?: string; increment?: number }>,
    token: vscode.CancellationToken
  ): Promise<void> {
    const totalFiles = turns.reduce((sum, turn) => sum + turn.changes.length, 0) || 1;
    for (const turn of turns) {
      for (const change of turn.changes) {
        if (token.isCancellationRequested) {
          this.clear();
          return;
        }
        progress.report({ message: `${turn.title} — ${change.file}`, increment: 100 / totalFiles });
        await this.showChange(turn, change);
        await this.sleep(STEP_MS, token);
      }
    }
    this.clear();
  }

  private async showChange(record: TurnRecord, change: TurnChange): Promise<void> {
    if (change.kind === 'deleted') {
      return; // nothing to show live for a file that no longer exists
    }
    const absolute = change.file.startsWith('/') ? change.file : join(record.cwd, change.file);
    try {
      const before = await this.review.fileBefore(record, change);
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(absolute));
      const editor = await vscode.window.showTextDocument(doc, {
        preview: false, // stays open — consistent with follow's "files stay open"
        preserveFocus: true,
      });
      const hunks = await computeHunks(before, doc.getText());
      const ranges = hunks
        .filter((hunk) => hunk.afterCount > 0)
        .map((hunk) => new vscode.Range(hunk.afterStart, 0, hunk.afterStart + hunk.afterCount - 1, 0));
      editor.setDecorations(this.decoration, ranges);
      if (ranges[0]) {
        editor.revealRange(ranges[0], vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      }
    } catch {
      /* file gone/unreadable — skip, the walkthrough still advances */
    }
  }

  private clear(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      editor.setDecorations(this.decoration, []);
    }
  }

  private sleep(ms: number, token: vscode.CancellationToken): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      token.onCancellationRequested(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  public dispose(): void {
    this.clear();
    this.decoration.dispose();
  }
}
