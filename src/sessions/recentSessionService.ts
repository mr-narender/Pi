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
  private readonly refreshes = new Map<string, { revision: number; promise: Promise<void> }>();
  private readonly allProjectsScans = new Map<string, Promise<RecentSessionRecord[]>>();

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
    this.refreshes.clear();
    this.allProjectsScans.clear();
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
    this.allProjectsScans.clear();
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

  private refreshFolder(folder: vscode.WorkspaceFolder): Promise<void> {
    const key = folder.uri.toString();
    const currentRevision = this.revision.get(key) ?? 0;
    const active = this.refreshes.get(key);
    if (active?.revision === currentRevision) {
      return active.promise;
    }
    const revision = currentRevision + 1;
    this.revision.set(key, revision);
    const promise = this.runRefreshFolder(folder, key, revision).finally(() => {
      if (this.refreshes.get(key)?.revision === revision) {
        this.refreshes.delete(key);
      }
    });
    this.refreshes.set(key, { revision, promise });
    return promise;
  }

  private async runRefreshFolder(
    folder: vscode.WorkspaceFolder,
    key: string,
    revision: number
  ): Promise<void> {
    const current = this.state.get(key) ?? { loading: false, filterText: '', items: [] };
    this.state.set(key, { ...current, loading: true, error: undefined });
    this.emitter.fire();
    try {
      const settings = getSettings();
      const index = await readRecentSessionsIndex({
        workspaceName: folder.name,
        workspacePath: folder.uri.fsPath,
        additionalArgs: settings.additionalArgs,
      });
      if (this.revision.get(key) !== revision) {
        return;
      }
      this.state.set(key, {
        ...current,
        loading: false,
        filterText: this.state.get(key)?.filterText ?? current.filterText,
        sessionDir: index.sessionDir,
        items: index.sessions,
        error: undefined,
      });
      this.emitter.fire();

      // Other projects can span hundreds of files. Populate them after the
      // current workspace is visible so a broad history scan never blocks the
      // sidebar's first useful paint.
      const workspaceCwds = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
      void this.scanAllProjects(workspaceCwds).then((others) => {
        if (this.revision.get(key) !== revision) {
          return;
        }
        const latest = this.state.get(key);
        if (!latest) {
          return;
        }
        this.state.set(key, { ...latest, others });
        this.emitter.fire();
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
      this.emitter.fire();
    }
  }

  private scanAllProjects(workspaceCwds: string[]): Promise<RecentSessionRecord[]> {
    const key = [...workspaceCwds].sort().join('\n');
    const active = this.allProjectsScans.get(key);
    if (active) {
      return active;
    }
    const promise = (
      this.indexService
        ? this.indexService
            .scanAll(workspaceCwds)
            .catch(() => readAllProjectsSessions(workspaceCwds))
        : readAllProjectsSessions(workspaceCwds)
    )
      .catch(() => [])
      .finally(() => {
        if (this.allProjectsScans.get(key) === promise) {
          this.allProjectsScans.delete(key);
        }
      });
    this.allProjectsScans.set(key, promise);
    return promise;
  }
}
