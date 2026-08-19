import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import * as vscode from 'vscode';
import type { SessionController } from '../sessions/sessionController';
import type { DiagnosticsLogger } from '../diagnostics/logger';

const exec = promisify(execFile);

interface TurnSnapshot {
  sha: string;
  untracked: Set<string>;
  at: number;
}

interface TurnChange {
  file: string;
  kind: 'modified' | 'added' | 'deleted' | 'new';
}

interface TurnRecord {
  sha: string;
  cwd: string;
  changes: TurnChange[];
  at: number;
}

/**
 * Turn review: a git snapshot (`git stash create` — no working-tree mutation) is
 * taken when a chat turn STARTS; when it settles, the working tree is diffed
 * against that snapshot and the user can review a consolidated
 * "files changed this turn" list — open before↔after diffs, revert one file, or
 * revert everything the turn touched. Untracked files created during the turn
 * are detected via an ls-files delta (git doesn't snapshot those).
 */
export class TurnReview {
  private readonly snapshots = new Map<SessionController, TurnSnapshot>();
  private readonly lastTurn = new Map<SessionController, TurnRecord>();

  public constructor(private readonly logger: DiagnosticsLogger) {}

  public async onTurnStart(controller: SessionController): Promise<void> {
    const cwd = controller.folder.uri.fsPath;
    try {
      const stashSha = (await this.git(cwd, ['stash', 'create'])).trim();
      const sha = stashSha || (await this.git(cwd, ['rev-parse', 'HEAD'])).trim();
      const untracked = new Set(
        (await this.git(cwd, ['ls-files', '--others', '--exclude-standard']))
          .split('\n')
          .filter(Boolean)
      );
      this.snapshots.set(controller, { sha, untracked, at: Date.now() });
    } catch {
      // Not a git repo / git unavailable — turn review silently unavailable.
      this.snapshots.delete(controller);
    }
  }

  public async onTurnEnd(controller: SessionController): Promise<void> {
    const snapshot = this.snapshots.get(controller);
    this.snapshots.delete(controller);
    if (!snapshot) {
      return;
    }
    const cwd = controller.folder.uri.fsPath;
    try {
      const changes: TurnChange[] = (await this.git(cwd, ['diff', '--name-status', snapshot.sha]))
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [status = '', ...rest] = line.split('\t');
          const file = rest[rest.length - 1] ?? '';
          const kind: TurnChange['kind'] = status.startsWith('D')
            ? 'deleted'
            : status.startsWith('A')
              ? 'added'
              : 'modified';
          return { file, kind };
        })
        .filter((change) => change.file.length > 0);
      const untrackedNow = (await this.git(cwd, ['ls-files', '--others', '--exclude-standard']))
        .split('\n')
        .filter(Boolean);
      for (const file of untrackedNow) {
        if (!snapshot.untracked.has(file)) {
          changes.push({ file, kind: 'new' });
        }
      }
      if (changes.length === 0) {
        this.lastTurn.delete(controller);
        return;
      }
      this.lastTurn.set(controller, { sha: snapshot.sha, cwd, changes, at: Date.now() });
      const count = changes.length;
      void vscode.window
        .showInformationMessage(
          `Pi changed ${count} file${count === 1 ? '' : 's'} this turn.`,
          'Review Changes'
        )
        .then((choice) => {
          if (choice === 'Review Changes') {
            void this.review(controller);
          }
        });
    } catch (error) {
      this.logger.warn(
        `Turn review diff failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  public hasChanges(controller: SessionController): boolean {
    return this.lastTurn.has(controller);
  }

  public async review(controller: SessionController | undefined): Promise<void> {
    const record = controller ? this.lastTurn.get(controller) : undefined;
    if (!record) {
      void vscode.window.showInformationMessage('No file changes recorded for the last Pi turn.');
      return;
    }
    const icons: Record<TurnChange['kind'], string> = {
      modified: '$(diff-modified)',
      added: '$(diff-added)',
      deleted: '$(diff-removed)',
      new: '$(new-file)',
    };
    type FilePick = vscode.QuickPickItem & { change?: TurnChange; revertAll?: boolean };
    const picks: FilePick[] = record.changes.map((change) => ({
      label: `${icons[change.kind]} ${change.file}`,
      description: change.kind,
      change,
    }));
    picks.push({ label: '$(discard) Revert ALL files from this turn', revertAll: true });
    const picked = await vscode.window.showQuickPick(picks, {
      title: `Files changed this turn (${record.changes.length})`,
      placeHolder: 'Open a before↔after diff, or revert',
    });
    if (!picked) {
      return;
    }
    if (picked.revertAll) {
      const confirm = await vscode.window.showWarningMessage(
        `Revert all ${record.changes.length} file(s) to their state before this turn?`,
        { modal: true },
        'Revert All'
      );
      if (confirm === 'Revert All') {
        for (const change of record.changes) {
          await this.revertFile(record, change).catch((error) =>
            this.logger.warn(`Revert failed for ${change.file}: ${String(error)}`)
          );
        }
        void vscode.window.showInformationMessage('Reverted all files from the last turn.');
      }
      return;
    }
    const change = picked.change;
    if (!change) {
      return;
    }
    const action = await vscode.window.showQuickPick(
      [
        { label: '$(diff) Open diff (before ↔ current)' },
        { label: '$(discard) Revert this file' },
      ],
      { title: change.file }
    );
    if (!action) {
      return;
    }
    if (action.label.includes('Open diff')) {
      await this.openDiff(record, change);
    } else {
      await this.revertFile(record, change);
      void vscode.window.showInformationMessage(`Reverted ${change.file}`);
    }
  }

  private async openDiff(record: TurnRecord, change: TurnChange): Promise<void> {
    const fileUri = vscode.Uri.file(join(record.cwd, change.file));
    if (change.kind === 'new') {
      await vscode.window.showTextDocument(fileUri, { preview: true });
      return;
    }
    let before = '';
    try {
      before = await this.git(
        record.cwd,
        ['show', `${record.sha}:${change.file}`],
        32 * 1024 * 1024
      );
    } catch {
      before = '';
    }
    const dir = await mkdtemp(join(tmpdir(), 'pi-turn-'));
    const beforePath = join(dir, basename(change.file));
    await writeFile(beforePath, before, 'utf8');
    if (change.kind === 'deleted') {
      await vscode.window.showTextDocument(vscode.Uri.file(beforePath), { preview: true });
      return;
    }
    await vscode.commands.executeCommand(
      'vscode.diff',
      vscode.Uri.file(beforePath),
      fileUri,
      `${basename(change.file)} (before ↔ after turn)`
    );
  }

  private async revertFile(record: TurnRecord, change: TurnChange): Promise<void> {
    if (change.kind === 'new') {
      await vscode.workspace.fs.delete(vscode.Uri.file(join(record.cwd, change.file)), {
        useTrash: true,
      });
      return;
    }
    await this.git(record.cwd, ['checkout', record.sha, '--', change.file]);
  }

  private async git(cwd: string, args: string[], maxBuffer = 4 * 1024 * 1024): Promise<string> {
    const { stdout } = await exec('git', args, { cwd, maxBuffer });
    return stdout;
  }
}
