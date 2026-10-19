import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { writeFile, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, basename } from 'node:path';
import * as vscode from 'vscode';
import type { SessionController } from '../sessions/sessionController';
import type { DiagnosticsLogger } from '../diagnostics/logger';
import {
  captureUndoState,
  matchesUndoState,
  restoreUndoFile,
  showUndoConflict,
  resolveUndoUri,
  undoTextChanges,
  type UndoState,
} from './safeUndo';
import { editReplacements, editToolFilePath } from '../webview/editToolPath';
import type { JsonObject } from '../rpc/protocol';

const exec = promisify(execFile);

interface TurnSnapshot {
  sha: string;
  untracked: Set<string>;
  at: number;
  refId?: string;
}

export interface TurnChange {
  file: string;
  kind: 'modified' | 'added' | 'deleted' | 'new';
  added?: number;
  deleted?: number;
  after?: UndoState;
  afterSha?: string;
  afterRef?: string;
}

export interface TurnRecord {
  sha: string;
  cwd: string;
  changes: TurnChange[];
  at: number;
  /** git ref rooting the stash commit — survives `git gc` across reloads. */
  refId?: string;
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
  /** Last N reviewed turns (newest first) — feeds the π Review panel. */
  public readonly history: Array<TurnRecord & { title: string }> = [];
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  public readonly onDidChange = this.changeEmitter.event;
  private readonly snapshots = new Map<SessionController, TurnSnapshot>();
  private readonly lastTurn = new Map<SessionController, TurnRecord>();
  private readonly pendingStarts = new Map<SessionController, Promise<void>>();
  private readonly generations = new Map<SessionController, number>();
  private readonly observedTools = new Map<
    SessionController,
    Map<string, { valid: () => boolean; generation: number | undefined }>
  >();
  private readonly turnOrigins = new Map<SessionController, () => boolean>();
  private readonly toolCaptures = new Map<
    SessionController,
    Array<{
      path: string;
      after: UndoState;
      bytes?: Buffer;
      order: number;
      generation: number | undefined;
    }>
  >();
  private readonly pendingTools = new Map<SessionController, Promise<void>[]>();
  private readonly editResults: Array<{
    session: string;
    callId: string;
    cwd: string;
    path: string;
    after: UndoState;
  }> = [];
  // cwd -> is a safe repo to snapshot. Guards macOS TCC: git in a HOME-rooted
  // repo walks ~/Library, ~/Documents, ~/Desktop and triggers "VS Code wants to
  // access data from other apps" prompts on every turn.
  private readonly repoAllowed = new Map<string, boolean>();

  private async allowedRepo(cwd: string): Promise<boolean> {
    const cached = this.repoAllowed.get(cwd);
    if (cached !== undefined) {
      return cached;
    }
    let allowed = false;
    try {
      const top = (await this.git(cwd, ['rev-parse', '--show-toplevel'])).trim();
      allowed = top.length > 0 && join(top) !== join(homedir());
      if (!allowed) {
        this.logger.warn(
          `Turn review disabled for ${cwd}: repository root is the home directory (macOS privacy prompts)`
        );
      }
    } catch {
      allowed = false; // not a git repo
    }
    this.repoAllowed.set(cwd, allowed);
    return allowed;
  }

  private static readonly STORAGE_KEY = 'piRpc.turnReview.history.v1';

  public constructor(
    private readonly logger: DiagnosticsLogger,
    private readonly memento?: vscode.Memento
  ) {
    const saved = this.memento?.get<Array<TurnRecord & { title: string }>>(
      TurnReview.STORAGE_KEY,
      []
    );
    if (saved && saved.length > 0) {
      this.history.push(...saved);
      this.logger.info(`Restored ${saved.length} reviewable turn(s) from disk.`);
    }
    this.editResults.push(
      ...(this.memento?.get<typeof this.editResults>(`${TurnReview.STORAGE_KEY}.editResults`, []) ??
        [])
    );
  }

  private persist(): void {
    void this.memento?.update(TurnReview.STORAGE_KEY, this.history);
    void this.memento?.update(`${TurnReview.STORAGE_KEY}.editResults`, this.editResults);
  }

  public onTurnStart(controller: SessionController): Promise<void> {
    const generation = (this.generations.get(controller) ?? 0) + 1;
    this.generations.set(controller, generation);
    this.turnOrigins.set(controller, this.captureOrigin(controller));
    this.snapshots.delete(controller);
    this.toolCaptures.set(controller, []);
    this.pendingTools.set(controller, []);
    const pending = this.captureStart(controller, generation);
    this.pendingStarts.set(controller, pending);
    return pending;
  }

  private async captureStart(controller: SessionController, generation: number): Promise<void> {
    const cwd = controller.folder.uri.fsPath;
    if (!(await this.allowedRepo(cwd))) {
      return;
    }
    try {
      const stashSha = (await this.git(cwd, ['stash', 'create'])).trim();
      const sha = stashSha || (await this.git(cwd, ['rev-parse', 'HEAD'])).trim();
      const untracked = new Set(
        (await this.git(cwd, ['ls-files', '--others', '--exclude-standard']))
          .split('\n')
          .filter(Boolean)
      );
      // `stash create` returns a DANGLING commit — nothing references it, so
      // `git gc` can prune it. Root it under our own ref namespace so the
      // snapshot survives long enough to be reviewed after a reload/restart.
      let refId: string | undefined;
      if (stashSha) {
        refId = `refs/pi-review/${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        await this.git(cwd, ['update-ref', refId, stashSha]).catch(() => undefined);
      }
      if (this.generations.get(controller) === generation)
        this.snapshots.set(controller, { sha, untracked, at: Date.now(), refId });
      else if (refId) await this.git(cwd, ['update-ref', '-d', refId]);
    } catch {
      // Not a git repo / git unavailable — turn review silently unavailable.
      this.snapshots.delete(controller);
    }
  }

  public async onTurnEnd(
    controller: SessionController,
    options?: { silent?: boolean }
  ): Promise<void> {
    const generation = this.generations.get(controller);
    try {
      await this.finishTurn(controller, options);
    } finally {
      if (this.generations.get(controller) === generation) {
        this.toolCaptures.delete(controller);
        this.pendingTools.delete(controller);
        this.pendingStarts.delete(controller);
      }
    }
  }

  private async finishTurn(
    controller: SessionController,
    options?: { silent?: boolean }
  ): Promise<void> {
    const generation = this.generations.get(controller);
    await this.pendingStarts.get(controller);
    if (
      this.generations.get(controller) !== generation ||
      this.turnOrigins.get(controller)?.() === false
    )
      return;
    await Promise.all(this.pendingTools.get(controller) ?? []);
    if (
      this.generations.get(controller) !== generation ||
      this.turnOrigins.get(controller)?.() === false
    )
      return;
    const snapshot = this.snapshots.get(controller);
    this.snapshots.delete(controller);
    if (!snapshot) {
      return;
    }
    const cwd = controller.folder.uri.fsPath;
    try {
      const changes: TurnChange[] = (
        await this.git(cwd, ['diff', '--relative', '--no-renames', '--name-status', snapshot.sha])
      )
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
        if (snapshot.refId) await this.git(cwd, ['update-ref', '-d', snapshot.refId]);
        return;
      }
      for (const change of changes) {
        try {
          const uri = await resolveUndoUri(cwd, change.file);
          const evidence = this.toolCaptures
            .get(controller)
            ?.filter((item) => item.generation === generation && item.path === uri.fsPath)
            .sort((a, b) => b.order - a.order)[0];
          if (!evidence) continue;
          const after = evidence.after;
          if (after.digest !== null) {
            const content = evidence.bytes;
            if (!content || createHash('sha256').update(content).digest('hex') !== after.digest)
              continue;
            const sha = (
              await this.git(cwd, ['hash-object', '-w', '--stdin'], undefined, content)
            ).trim();
            const ref = `refs/pi-review/result-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
            await this.git(cwd, ['update-ref', ref, sha]);
            change.afterSha = sha;
            change.afterRef = ref;
          }
          change.after = after;
        } catch {
          /* Missing post-state makes automatic Undo unavailable. */
        }
      }
      if (this.generations.get(controller) !== generation) {
        for (const change of changes)
          if (change.afterRef) await this.git(cwd, ['update-ref', '-d', change.afterRef]);
        if (snapshot.refId) await this.git(cwd, ['update-ref', '-d', snapshot.refId]);
        return;
      }
      // Per-file +/- counts for the review panel (one numstat call).
      try {
        const numstat = await this.git(cwd, ['diff', '--relative', '--numstat', snapshot.sha]);
        const stats = new Map<string, { added: number; deleted: number }>();
        for (const line of numstat.split('\n')) {
          const [added = '', deleted = '', ...file] = line.split('\t');
          if (file.length > 0) {
            stats.set(file[file.length - 1]!, {
              added: Number.parseInt(added, 10) || 0,
              deleted: Number.parseInt(deleted, 10) || 0,
            });
          }
        }
        for (const change of changes) {
          const stat = stats.get(change.file);
          change.added = stat?.added;
          change.deleted = stat?.deleted;
        }
      } catch {
        /* diffstat optional */
      }
      this.lastTurn.set(controller, {
        sha: snapshot.sha,
        cwd,
        changes,
        at: Date.now(),
        refId: snapshot.refId,
      });
      this.history.unshift({
        sha: snapshot.sha,
        cwd,
        changes,
        at: Date.now(),
        title: basename(cwd),
        refId: snapshot.refId,
      });
      if (this.history.length > 10) {
        // Un-root anything falling out of the reviewable window so refs never
        // grow unbounded.
        for (const dropped of this.history.splice(10)) {
          if (dropped.refId) {
            void this.git(dropped.cwd, ['update-ref', '-d', dropped.refId]).catch(() => undefined);
          }
          for (const change of dropped.changes)
            if (change.afterRef)
              void this.git(dropped.cwd, ['update-ref', '-d', change.afterRef]).catch(
                () => undefined
              );
        }
      }
      this.persist();
      this.changeEmitter.fire();
      const count = changes.length;
      if (options?.silent) {
        return; // user is watching this chat — the Review panel has it
      }
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

  public discard(controller: SessionController): void {
    this.generations.set(controller, (this.generations.get(controller) ?? 0) + 1);
    const snapshot = this.snapshots.get(controller);
    if (snapshot?.refId)
      void this.git(controller.folder.uri.fsPath, ['update-ref', '-d', snapshot.refId]).catch(
        () => undefined
      );
    this.snapshots.delete(controller);
    this.toolCaptures.delete(controller);
    this.pendingTools.delete(controller);
    this.pendingStarts.delete(controller);
    this.observedTools.delete(controller);
    this.turnOrigins.delete(controller);
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
        let reverted = 0;
        let failed = 0;
        for (const change of record.changes) {
          try {
            if (await this.revertFile(record, change)) reverted++;
          } catch (error) {
            failed++;
            this.logger.warn(`Revert failed for ${change.file}: ${String(error)}`);
          }
        }
        void vscode.window.showInformationMessage(
          `Reverted ${reverted} file(s); kept ${record.changes.length - reverted - failed}; failed ${failed}.`
        );
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
      if (await this.revertFile(record, change))
        void vscode.window.showInformationMessage(`Reverted ${change.file}`);
    }
  }

  /** Snapshot content of a file before the turn ('' for new files). */
  public async fileBefore(record: TurnRecord, change: TurnChange): Promise<string> {
    if (change.kind === 'new' || change.kind === 'added') {
      return '';
    }
    const bytes = await this.beforeBytes(record, change);
    const text = bytes.toString('utf8');
    if (!Buffer.from(text).equals(bytes)) throw new Error('Binary files require whole-file Undo.');
    return text;
  }

  public async openDiff(record: TurnRecord, change: TurnChange): Promise<void> {
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

  private editCalls(controller: SessionController): JsonObject[] {
    return (controller.snapshot.messages ?? [])
      .filter((message) => message.role === 'assistant')
      .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
      .filter(
        (value): value is JsonObject =>
          !!value &&
          typeof value === 'object' &&
          !Array.isArray(value) &&
          value.type === 'toolCall' &&
          typeof value.id === 'string'
      );
  }

  private sessionKey(controller: SessionController): string {
    return String(
      controller.snapshot.state.sessionFile ?? controller.snapshot.state.sessionId ?? ''
    );
  }

  private captureOrigin(controller: SessionController): () => boolean {
    const native = controller.captureFileUndoOrigin?.() ?? controller.captureLocalCommandOrigin?.();
    const session = this.sessionKey(controller);
    const generation = controller.snapshot.generation;
    return () =>
      this.sessionKey(controller) === session &&
      controller.snapshot.generation === generation &&
      (native?.() ?? true);
  }

  /** Called on the tool-end reducer notification, before the chat rendering awaits. */
  public observeTools(controller: SessionController): Promise<void> {
    const seen =
      this.observedTools.get(controller) ??
      new Map<string, { valid: () => boolean; generation: number | undefined }>();
    this.observedTools.set(controller, seen);
    for (const [order, tool] of (controller.snapshot.tools ?? []).entries()) {
      if (!tool.endedAt) {
        if (!seen.has(tool.id))
          seen.set(tool.id, {
            valid: this.captureOrigin(controller),
            generation: this.generations.get(controller),
          });
        continue;
      }
      const running = seen.get(tool.id);
      seen.delete(tool.id);
      if (
        !running?.valid() ||
        running.generation !== this.generations.get(controller) ||
        tool.isError
      )
        continue;
      const path = editToolFilePath(tool.name, JSON.stringify(tool.args));
      if (!path) continue;
      const pending = this.captureToolResult(
        controller,
        tool.id,
        path,
        tool.endedAt * 1000 + order,
        this.generations.get(controller),
        running.valid
      );
      const tasks = this.pendingTools.get(controller) ?? [];
      if (this.toolCaptures.has(controller)) {
        tasks.push(pending);
        this.pendingTools.set(controller, tasks);
      }
    }
    return Promise.all(this.pendingTools.get(controller) ?? []).then(() => undefined);
  }

  private async captureToolResult(
    controller: SessionController,
    callId: string,
    path: string,
    order: number,
    generation: number | undefined,
    valid: () => boolean
  ): Promise<void> {
    const session = this.sessionKey(controller);
    if (!session || !valid()) return;
    try {
      const uri = await resolveUndoUri(controller.folder.uri.fsPath, path);
      const after = await captureUndoState(uri);
      if (
        !(await matchesUndoState(uri, after)) ||
        this.generations.get(controller) !== generation ||
        !valid()
      )
        return;
      const bytes = after.digest === null ? undefined : await readFile(uri.fsPath);
      if (
        !valid() ||
        (bytes &&
          (bytes.length > 32 * 1024 * 1024 ||
            createHash('sha256').update(bytes).digest('hex') !== after.digest))
      )
        return;
      const captures = this.toolCaptures.get(controller);
      if (captures && this.snapshots.has(controller)) {
        const previous = captures.findIndex((item) => item.path === uri.fsPath);
        if (previous < 0) captures.push({ path: uri.fsPath, after, bytes, order, generation });
        else if (captures[previous]!.order < order)
          captures[previous] = { path: uri.fsPath, after, bytes, order, generation };
      }
      this.editResults.unshift({ session, callId, cwd: controller.folder.uri.fsPath, path, after });
    } catch {
      /* No provable post-state: keep the file and offer manual review. */
    }
    this.editResults.splice(100);
    this.persist();
  }

  public async undoEdit(
    controller: SessionController,
    callId: string,
    valid: () => boolean
  ): Promise<boolean> {
    const origin = this.captureOrigin(controller);
    const calls = this.editCalls(controller).filter((call) => call.id === callId);
    const call = calls[0];
    if (calls.length !== 1 || !call || controller.snapshot.runOutcome === 'running') return false;
    const path = editToolFilePath(String(call.name), JSON.stringify(call.arguments));
    const changes = editReplacements(String(call.name), JSON.stringify(call.arguments));
    if (!path || changes.length === 0) return false;
    const uri = await resolveUndoUri(controller.folder.uri.fsPath, path);
    const saved = this.editResults.find(
      (result) =>
        result.session === this.sessionKey(controller) &&
        result.callId === callId &&
        result.cwd === controller.folder.uri.fsPath &&
        result.path === path
    );
    return undoTextChanges(uri, saved?.after, changes, () => origin() && valid());
  }

  private async beforeBytes(record: TurnRecord, change: TurnChange): Promise<Buffer> {
    const { stdout } = await exec('git', ['show', `${record.sha}:./${change.file}`], {
      cwd: record.cwd,
      maxBuffer: 32 * 1024 * 1024,
      encoding: 'buffer',
    });
    return stdout;
  }

  public async revertFile(record: TurnRecord, change: TurnChange): Promise<boolean> {
    const uri = await resolveUndoUri(record.cwd, change.file);
    let before: Buffer | null;
    let after: Buffer | undefined;
    let mode: number | undefined;
    try {
      before =
        change.kind === 'new' || change.kind === 'added'
          ? null
          : await this.beforeBytes(record, change);
      after = change.afterSha
        ? (
            await exec('git', ['show', change.afterSha], {
              cwd: record.cwd,
              maxBuffer: 32 * 1024 * 1024,
              encoding: 'buffer',
            })
          ).stdout
        : undefined;
      if (before !== null) {
        const tree = await this.git(record.cwd, ['ls-tree', record.sha, '--', change.file]);
        if (!/^(100644|100755) /.test(tree))
          throw new Error('Only regular file snapshots can be undone.');
        const permissions = (change.after?.mode ?? 0o600) & 0o777;
        mode = (permissions & 0o666) | (tree.startsWith('100755') ? (permissions & 0o444) >> 2 : 0);
      }
    } catch {
      await showUndoConflict(uri);
      return false;
    }
    return restoreUndoFile(uri, change.after, before, after, mode);
  }

  private async git(
    cwd: string,
    args: string[],
    maxBuffer = 4 * 1024 * 1024,
    input?: Buffer
  ): Promise<string> {
    if (!input) return (await exec('git', args, { cwd, maxBuffer })).stdout;
    return new Promise((resolveOutput, reject) => {
      const child = execFile('git', args, { cwd, maxBuffer }, (error, stdout) =>
        error ? reject(error) : resolveOutput(stdout)
      );
      child.stdin?.end(input);
    });
  }
}
