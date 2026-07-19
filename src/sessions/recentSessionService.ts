import * as vscode from 'vscode';
import { getSettings } from '../config/settings';
import {
  filterRecentSessions,
  type RecentSessionRecord,
  readRecentSessionsIndex,
} from './recentSessions';

export interface RecentSessionsState {
  loading: boolean;
  error?: string;
  filterText: string;
  sessionDir?: string;
  items: RecentSessionRecord[];
}

export class RecentSessionService implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  private readonly state = new Map<string, RecentSessionsState>();

  public get onDidChange(): vscode.Event<void> {
    return this.emitter.event;
  }

  public dispose(): void {
    this.emitter.dispose();
    this.state.clear();
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

  private async refreshFolder(folder: vscode.WorkspaceFolder): Promise<void> {
    const key = folder.uri.toString();
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
      this.state.set(key, {
        loading: false,
        filterText: current.filterText,
        sessionDir: index.sessionDir,
        items: index.sessions,
      });
    } catch (error) {
      this.state.set(key, {
        loading: false,
        filterText: current.filterText,
        sessionDir: current.sessionDir,
        items: current.items,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    this.emitter.fire();
  }
}
