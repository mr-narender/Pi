import * as vscode from 'vscode';
import { getSettings } from '../config/settings';
import {
  filterRecentSessions,
  type RecentSessionRecord,
  readRecentSessionsIndex,
  readAllProjectsSessions,
} from './recentSessions';

export interface RecentSessionsState {
  loading: boolean;
  error?: string;
  filterText: string;
  sessionDir?: string;
  items: RecentSessionRecord[];
  /** Chats belonging to OTHER projects (different cwd), newest first. */
  others?: RecentSessionRecord[];
}

export class RecentSessionService implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  private readonly state = new Map<string, RecentSessionsState>();
  private readonly revision = new Map<string, number>();

  public constructor(
    // Optional off-thread accelerator; every use falls back to the inline scan.
    private readonly indexService?: {
      scanAll(excludeCwds: string[]): Promise<RecentSessionRecord[]>;
    }
  ) {}

  public get onDidChange(): vscode.Event<void> {
    return this.emitter.event;
  }

  public dispose(): void {
    this.emitter.dispose();
    this.state.clear();
    this.revision.clear();
  }

  public getState(folder: vscode.WorkspaceFolder): RecentSessionsState {
    const key = folder.uri.toString();
    let current = this.state.get(key);
    if (!current) {
      current = { loading: true, filterText: '', items: [] };
      this.state.set(key, current);
      void this.refresh(folder);
    }
    return {
      ...current,
      items: filterRecentSessions(current.items, current.filterText),
    };
  }

  public async refresh(folder?: vscode.WorkspaceFolder): Promise<void> {
    const targets = folder ? [folder] : (vscode.workspace.workspaceFolders ?? []);
    await Promise.all(targets.map((item) => this.refreshFolder(item)));
  }

  public setFilter(folder: vscode.WorkspaceFolder, filterText: string): void {
    const key = folder.uri.toString();
    const current = this.state.get(key) ?? { loading: false, filterText: '', items: [] };
    this.state.set(key, { ...current, filterText });
    this.emitter.fire();
  }

  public clearFilter(folder: vscode.WorkspaceFolder): void {
    this.setFilter(folder, '');
  }

  /** Drop a successfully deleted file from every cached project immediately.
   * Invalidate scans that began before the deletion so they cannot restore it. */
  public removePath(sessionPath: string): void {
    for (const [key, current] of this.state) {
      this.revision.set(key, (this.revision.get(key) ?? 0) + 1);
      this.state.set(key, {
        ...current,
        loading: false,
        items: current.items.filter((item) => item.path !== sessionPath),
        others: current.others?.filter((item) => item.path !== sessionPath),
      });
    }
    this.emitter.fire();
  }

  private async refreshFolder(folder: vscode.WorkspaceFolder): Promise<void> {
    const key = folder.uri.toString();
    const revision = (this.revision.get(key) ?? 0) + 1;
    this.revision.set(key, revision);
    const current = this.state.get(key) ?? { loading: false, filterText: '', items: [] };
    this.state.set(key, { ...current, loading: true, error: undefined });
    this.emitter.fire();
    try {
      const settings = getSettings();
      const workspaceCwds = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
      const [index, others] = await Promise.all([
        readRecentSessionsIndex({
          workspaceName: folder.name,
          workspacePath: folder.uri.fsPath,
          additionalArgs: settings.additionalArgs,
        }),
        // All-projects list — off-thread when the index worker is up, inline
        // fallback otherwise; never fail the main list because of it.
        (this.indexService
          ? this.indexService
              .scanAll(workspaceCwds)
              .catch(() => readAllProjectsSessions(workspaceCwds))
          : readAllProjectsSessions(workspaceCwds)
        ).catch(() => []),
      ]);
      if (this.revision.get(key) !== revision) {
        return;
      }
      this.state.set(key, {
        loading: false,
        filterText: this.state.get(key)?.filterText ?? current.filterText,
        sessionDir: index.sessionDir,
        items: index.sessions,
        others,
      });
    } catch (error) {
      if (this.revision.get(key) !== revision) {
        return;
      }
      this.state.set(key, {
        loading: false,
        filterText: this.state.get(key)?.filterText ?? current.filterText,
        sessionDir: current.sessionDir,
        items: current.items,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    this.emitter.fire();
  }
}
