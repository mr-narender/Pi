import * as vscode from 'vscode';
import { DiagnosticsLogger } from '../diagnostics/logger';
import { SessionController } from './sessionController';

export class SessionRegistry implements vscode.Disposable {
  private readonly controllers = new Map<string, SessionController>();
  private activeFolderUri: string | undefined;

  public constructor(private readonly logger: DiagnosticsLogger) {}

  public getOrCreate(folder: vscode.WorkspaceFolder): SessionController {
    const key = folder.uri.toString();
    const existing = this.controllers.get(key);
    if (existing) {
      return existing;
    }
    const controller = new SessionController(folder, this.logger);
    this.controllers.set(key, controller);
    if (!this.activeFolderUri) {
      this.activeFolderUri = key;
    }
    return controller;
  }

  public list(): SessionController[] {
    return [...this.controllers.values()];
  }

  public getByFolderUri(folderUri: string): SessionController | undefined {
    return this.controllers.get(folderUri);
  }

  public setActive(
    folderOrController: vscode.WorkspaceFolder | SessionController | string
  ): SessionController | undefined {
    const folderUri =
      typeof folderOrController === 'string'
        ? folderOrController
        : 'folder' in folderOrController
          ? folderOrController.folder.uri.toString()
          : folderOrController.uri.toString();
    const controller = this.controllers.get(folderUri);
    if (controller) {
      this.activeFolderUri = folderUri;
    }
    return controller;
  }

  public getActive(): SessionController | undefined {
    if (this.activeFolderUri) {
      return this.controllers.get(this.activeFolderUri);
    }
    const folder = vscode.workspace.workspaceFolders?.[0];
    return folder ? this.getOrCreate(folder) : undefined;
  }

  public async pickFolder(
    title = 'Select Pi workspace folder'
  ): Promise<SessionController | undefined> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
      return undefined;
    }
    if (folders.length === 1) {
      const onlyFolder = folders[0];
      if (!onlyFolder) {
        return undefined;
      }
      const controller = this.getOrCreate(onlyFolder);
      this.activeFolderUri = onlyFolder.uri.toString();
      return controller;
    }
    const picked = await vscode.window.showQuickPick(
      folders.map((folder) => ({
        label: folder.name,
        description: folder.uri.fsPath,
        detail: this.activeFolderUri === folder.uri.toString() ? 'Active Pi folder' : undefined,
        folder,
      })),
      { title }
    );
    if (!picked) {
      return undefined;
    }
    this.activeFolderUri = picked.folder.uri.toString();
    return this.getOrCreate(picked.folder);
  }

  public async getSelectedOrPick(options?: {
    forcePicker?: boolean;
    title?: string;
  }): Promise<SessionController | undefined> {
    if (options?.forcePicker) {
      return this.pickFolder(options.title);
    }
    return this.getActive() ?? this.pickFolder(options?.title);
  }

  public dispose(): void {
    for (const controller of this.controllers.values()) {
      controller.dispose();
    }
    this.controllers.clear();
  }
}
