// Inline per-hunk review: π's changes reviewed LINE BY LINE inside the real
// file. Each hunk gets CodeLens controls (Keep / Revert) plus a header lens
// (Keep all / Revert all / Done); reverting applies a surgical WorkspaceEdit
// restoring the snapshot text for just that range, then hunks recompute.
import * as vscode from 'vscode';
import { computeHunks, type Hunk } from './hunks';
import type { TurnChange, TurnRecord, TurnReview } from './turnReview';

interface ActiveReview {
  record: TurnRecord;
  change: TurnChange;
  before: string;
  hunks: Hunk[];
}

export class InlineReview implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly active = new Map<string, ActiveReview>();
  private readonly emitter = new vscode.EventEmitter<void>();
  public readonly onDidChangeCodeLenses = this.emitter.event;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly decoration: vscode.TextEditorDecorationType;
  private recomputeTimer: ReturnType<typeof setTimeout> | undefined;

  public constructor(private readonly review: TurnReview) {
    this.decoration = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
      overviewRulerColor: 'rgba(255, 140, 66, 0.8)',
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    });
    this.disposables.push(
      vscode.languages.registerCodeLensProvider({ scheme: 'file' }, this),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (this.active.has(event.document.uri.fsPath)) {
          clearTimeout(this.recomputeTimer);
          this.recomputeTimer = setTimeout(
            () => void this.recompute(event.document.uri.fsPath),
            400
          );
        }
      }),
      vscode.window.onDidChangeVisibleTextEditors(() => this.paint())
    );
  }

  /** Enter line-by-line review for one file of a turn. */
  public async start(record: TurnRecord, change: TurnChange): Promise<void> {
    const fsPath = vscode.Uri.file(
      change.file.startsWith('/') ? change.file : `${record.cwd}/${change.file}`
    ).fsPath;
    const before = await this.review.fileBefore(record, change);
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(fsPath));
    const hunks = await computeHunks(before, document.getText());
    if (hunks.length === 0) {
      void vscode.window.showInformationMessage('No line changes left to review in this file.');
      return;
    }
    this.active.set(fsPath, { record, change, before, hunks });
    await vscode.window.showTextDocument(document, { preview: false });
    this.emitter.fire();
    this.paint();
  }

  private async recompute(fsPath: string): Promise<void> {
    const entry = this.active.get(fsPath);
    if (!entry) {
      return;
    }
    try {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(fsPath));
      entry.hunks = await computeHunks(entry.before, document.getText());
      if (entry.hunks.length === 0) {
        this.active.delete(fsPath);
      }
      this.emitter.fire();
      this.paint();
    } catch {
      this.active.delete(fsPath);
      this.emitter.fire();
    }
  }

  private paint(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      const entry = this.active.get(editor.document.uri.fsPath);
      if (!entry) {
        editor.setDecorations(this.decoration, []);
        continue;
      }
      editor.setDecorations(
        this.decoration,
        entry.hunks
          .filter((hunk) => hunk.afterCount > 0)
          .map((hunk) => ({
            range: new vscode.Range(hunk.afterStart, 0, hunk.afterStart + hunk.afterCount - 1, 0),
            hoverMessage: new vscode.MarkdownString(
              `**π changed this** (−${hunk.removed} +${hunk.added})` +
                (hunk.beforeText
                  ? `\n\n*before:*\n\`\`\`\n${hunk.beforeText.slice(0, 600)}\n\`\`\``
                  : '')
            ),
          }))
      );
    }
  }

  public provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const entry = this.active.get(document.uri.fsPath);
    if (!entry) {
      return [];
    }
    const lenses: vscode.CodeLens[] = [];
    const top = new vscode.Range(0, 0, 0, 0);
    lenses.push(
      new vscode.CodeLens(top, {
        title: `π review: ${entry.hunks.length} hunk${entry.hunks.length === 1 ? '' : 's'}`,
        command: '',
      }),
      new vscode.CodeLens(top, {
        title: '✓ Keep all',
        command: 'piRpcInternal.hunkKeepAll',
        arguments: [document.uri.fsPath],
      }),
      new vscode.CodeLens(top, {
        title: '↩ Revert all',
        command: 'piRpcInternal.hunkRevertAll',
        arguments: [document.uri.fsPath],
      }),
      new vscode.CodeLens(top, {
        title: '✕ Done',
        command: 'piRpcInternal.hunkKeepAll',
        arguments: [document.uri.fsPath],
      })
    );
    entry.hunks.forEach((hunk, index) => {
      const line = Math.min(hunk.afterStart, Math.max(0, document.lineCount - 1));
      const range = new vscode.Range(line, 0, line, 0);
      lenses.push(
        new vscode.CodeLens(range, {
          title: `π −${hunk.removed} +${hunk.added} · ✓ Keep`,
          command: 'piRpcInternal.hunkKeep',
          arguments: [document.uri.fsPath, index],
        }),
        new vscode.CodeLens(range, {
          title: '↩ Revert',
          command: 'piRpcInternal.hunkRevert',
          arguments: [document.uri.fsPath, index],
        })
      );
    });
    return lenses;
  }

  public async keepHunk(fsPath: string, index: number): Promise<void> {
    const entry = this.active.get(fsPath);
    if (!entry) {
      return;
    }
    entry.hunks.splice(index, 1);
    if (entry.hunks.length === 0) {
      this.active.delete(fsPath);
    }
    this.emitter.fire();
    this.paint();
  }

  public async revertHunk(fsPath: string, index: number): Promise<void> {
    const entry = this.active.get(fsPath);
    const hunk = entry?.hunks[index];
    if (!entry || !hunk) {
      return;
    }
    const uri = vscode.Uri.file(fsPath);
    const document = await vscode.workspace.openTextDocument(uri);
    const edit = new vscode.WorkspaceEdit();
    if (hunk.afterCount === 0) {
      // Pure deletion by π — restore the before-text AFTER the anchor line.
      const at = Math.min(hunk.afterStart, document.lineCount);
      const position = new vscode.Position(at, 0);
      const text = hunk.beforeText + '\n';
      edit.insert(uri, position, text);
    } else {
      const endLine = hunk.afterStart + hunk.afterCount - 1;
      const range = new vscode.Range(
        hunk.afterStart,
        0,
        endLine,
        document.lineAt(Math.min(endLine, document.lineCount - 1)).text.length
      );
      edit.replace(uri, range, hunk.beforeText);
    }
    await vscode.workspace.applyEdit(edit);
    await document.save();
    await this.recompute(fsPath);
  }

  public async keepAll(fsPath: string): Promise<void> {
    this.active.delete(fsPath);
    this.emitter.fire();
    this.paint();
  }

  public async revertAll(fsPath: string): Promise<void> {
    const entry = this.active.get(fsPath);
    if (!entry) {
      return;
    }
    // Restore the whole file to its before state (single edit, then done).
    const uri = vscode.Uri.file(fsPath);
    const document = await vscode.workspace.openTextDocument(uri);
    const full = new vscode.Range(0, 0, document.lineCount, 0);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, full, entry.before);
    await vscode.workspace.applyEdit(edit);
    await document.save();
    this.active.delete(fsPath);
    this.emitter.fire();
    this.paint();
  }

  public dispose(): void {
    clearTimeout(this.recomputeTimer);
    this.decoration.dispose();
    this.emitter.dispose();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }
}
