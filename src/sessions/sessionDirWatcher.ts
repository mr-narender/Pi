import * as vscode from 'vscode';
import type { DiagnosticsLogger } from '../diagnostics/logger';
import type { RecentSessionService } from './recentSessionService';
import type { SessionRegistry } from './sessionRegistry';
import type { SessionController } from './sessionController';
import { getSessionsRootDir } from './recentSessions';
import { normalizeSessionFilePath } from '../editorTabs/uriContract';

// Performance guards. Filesystem writes from a streaming session are frequent;
// we must NOT re-read on every event. These bound how often we do real work.
const LIST_REFRESH_DEBOUNCE_MS = 600;
const LIST_REFRESH_MIN_INTERVAL_MS = 2500;
// Silent append is a cheap tail-read (not a full reload), so it can be snappier.
const RELOAD_DEBOUNCE_MS = 700;
const RELOAD_MIN_INTERVAL_MS = 1500;
// Ignore file changes that arrive right after our OWN writes (self-generated).
const SELF_WRITE_GRACE_MS = 3000;

/**
 * Keeps the extension in sync with the terminal (TUI) via the on-disk sessions
 * directory, WITHOUT hammering the filesystem:
 *  - the recent-chats LIST refreshes on create/delete, and at most every ~2.5s
 *    on content changes;
 *  - an OPEN chat whose file changes EXTERNALLY (a terminal appended to it) is
 *    re-read from disk, but only when idle, debounced, and rate-limited to once
 *    every ~4s per session, and never for our own writes.
 */
export class SessionDirWatcher implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private listTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly reloadTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly lastReloadAt = new Map<string, number>();

  public constructor(
    private readonly registry: SessionRegistry,
    private readonly recentSessions: RecentSessionService,
    private readonly logger: DiagnosticsLogger
  ) {}

  public start(): void {
    const root = getSessionsRootDir();
    try {
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.file(root), '**/*.jsonl')
      );
      this.disposables.push(
        watcher,
        // A new/removed session always affects the list.
        watcher.onDidCreate(() => this.scheduleListRefresh(true)),
        watcher.onDidDelete(() => this.scheduleListRefresh(true)),
        // A content change (append) may be the terminal editing an open chat.
        watcher.onDidChange((uri) => this.onChange(uri))
      );
      this.logger.info(`Watching Pi sessions for terminal/GUI sync: ${root}`);
    } catch (error) {
      this.logger.warn(
        `Could not watch the Pi sessions directory (${root}); terminal changes ` +
          `won't auto-refresh: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private onChange(uri: vscode.Uri): void {
    // Keep the list roughly current for renames/ordering, but throttled.
    this.scheduleListRefresh(false);

    const changed = normalizeSessionFilePath(uri.fsPath);
    for (const controller of this.registry.list()) {
      const active = controller.activeSessionFile;
      if (!active || normalizeSessionFilePath(active) !== changed) {
        continue;
      }
      // Skip if this is (likely) our own write, or the controller is busy.
      if (
        controller.snapshot.connectionState !== 'ready' ||
        controller.msSinceSelfWrite() < SELF_WRITE_GRACE_MS
      ) {
        return;
      }
      this.scheduleReload(controller);
      return;
    }
  }

  private scheduleListRefresh(structural: boolean): void {
    // Structural changes (new/removed chat) refresh quickly; content changes
    // (appends) use a much longer debounce so a streaming session refreshes the
    // list at most ~once every few seconds.
    if (this.listTimer) {
      clearTimeout(this.listTimer);
    }
    this.listTimer = setTimeout(
      () => {
        this.listTimer = undefined;
        void this.recentSessions.refresh();
      },
      structural ? LIST_REFRESH_DEBOUNCE_MS : LIST_REFRESH_MIN_INTERVAL_MS
    );
  }

  private scheduleReload(controller: SessionController): void {
    const key = controller.folder.uri.toString();
    const last = this.lastReloadAt.get(key) ?? 0;
    if (Date.now() - last < RELOAD_MIN_INTERVAL_MS) {
      return; // rate-limit per session
    }
    const existing = this.reloadTimers.get(key);
    if (existing) {
      clearTimeout(existing);
    }
    this.reloadTimers.set(
      key,
      setTimeout(() => {
        this.reloadTimers.delete(key);
        // Re-check idle + self-write at fire time (state may have changed).
        if (
          controller.snapshot.connectionState !== 'ready' ||
          controller.msSinceSelfWrite() < SELF_WRITE_GRACE_MS
        ) {
          return;
        }
        this.lastReloadAt.set(key, Date.now());
        // Silent append (tail new messages) — no reload/flash.
        void controller.appendExternalMessages().catch((error) => {
          this.logger.warn(
            `Live-append failed for '${controller.folder.name}': ` +
              `${error instanceof Error ? error.message : String(error)}`
          );
        });
      }, RELOAD_DEBOUNCE_MS)
    );
  }

  public dispose(): void {
    if (this.listTimer) {
      clearTimeout(this.listTimer);
    }
    for (const timer of this.reloadTimers.values()) {
      clearTimeout(timer);
    }
    this.reloadTimers.clear();
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
  }
}
