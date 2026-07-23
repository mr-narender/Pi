import * as vscode from 'vscode';
import type { DiagnosticsLogger } from '../diagnostics/logger';
import type { RecentSessionService } from './recentSessionService';
import { getSessionsRootDir } from './recentSessions';

/**
 * Keeps the extension in sync with the terminal (TUI). Pi writes sessions to
 * `~/.pi/agent/sessions/`; when the user creates, switches, renames, or appends
 * to a session in the terminal, those `.jsonl` files change on disk. This
 * watcher notices and refreshes the recent-sessions list live, so the sidebar
 * reflects terminal activity without reloading the extension or window (and the
 * reverse works because the terminal re-reads the dir on `/resume`).
 */
export class SessionDirWatcher implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;

  public constructor(
    private readonly recentSessions: RecentSessionService,
    private readonly logger: DiagnosticsLogger
  ) {}

  public start(): void {
    const root = getSessionsRootDir();
    try {
      // Recursive glob over the sessions root catches new per-project folders
      // and any .jsonl create/change/delete, on all platforms.
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.file(root), '**/*.jsonl')
      );
      this.disposables.push(
        watcher,
        watcher.onDidCreate(() => this.scheduleRefresh()),
        watcher.onDidChange(() => this.scheduleRefresh()),
        watcher.onDidDelete(() => this.scheduleRefresh())
      );
      this.logger.info(`Watching Pi sessions for terminal/GUI sync: ${root}`);
    } catch (error) {
      this.logger.warn(
        `Could not watch the Pi sessions directory (${root}); terminal changes ` +
          `won't auto-refresh: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /** Debounced so a burst of writes (a streaming terminal session) refreshes once. */
  private scheduleRefresh(): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.recentSessions.refresh();
    }, 350);
  }

  public dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
  }
}
