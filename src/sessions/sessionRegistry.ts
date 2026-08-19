import * as vscode from 'vscode';
import { DiagnosticsLogger } from '../diagnostics/logger';
import { SessionController } from './sessionController';

/**
 * Pool of Pi controllers. Historically there was ONE controller per workspace
 * FOLDER (all chat tabs shared it), which made parallel chats impossible — a
 * single Pi can only be on one session at a time. Now controllers are keyed by
 * an arbitrary string (the chat tab resource), so each open chat owns its own
 * controller + Pi process and they run independently. `getOrCreate(folder)` is
 * kept (key = folderUri) for folder-level / draft use.
 */
export class SessionRegistry implements vscode.Disposable {
  private readonly controllers = new Map<string, SessionController>();
  private readonly folderByKey = new Map<string, string>();
  private activeKey: string | undefined;
  // Fired for EVERY controller created (incl. per-tab ones made long after
  // activation) so cross-cutting consumers — the extension-UI broker (dialogs!),
  // sidebar refresh, status bar — can track it. Without this, chats opened
  // after activation would never get dialog handling.
  private readonly createEmitter = new vscode.EventEmitter<SessionController>();
  public readonly onDidCreateController = this.createEmitter.event;

  public constructor(private readonly logger: DiagnosticsLogger) {}

  /** Folder-level controller (key = folderUri). Used for drafts / fallback. */
  public getOrCreate(folder: vscode.WorkspaceFolder): SessionController {
    return this.getOrCreateFor(folder.uri.toString(), folder);
  }

  /** Per-session controller (key = a unique string, e.g. the chat tab resource). */
  public getOrCreateFor(key: string, folder: vscode.WorkspaceFolder): SessionController {
    const existing = this.controllers.get(key);
    if (existing) {
      return existing;
    }
    const controller = new SessionController(folder, this.logger);
    this.controllers.set(key, controller);
    this.folderByKey.set(key, folder.uri.toString());
    if (!this.activeKey) {
      this.activeKey = key;
    }
    this.createEmitter.fire(controller);
    return controller;
  }

  /** Move a controller to a new key (e.g. a draft that just got a real session). */
  public rekey(oldKey: string, newKey: string): void {
    if (oldKey === newKey) {
      return;
    }
    const controller = this.controllers.get(oldKey);
    if (!controller) {
      return;
    }
    this.controllers.delete(oldKey);
    this.folderByKey.delete(oldKey);
    this.controllers.set(newKey, controller);
    this.folderByKey.set(newKey, controller.folder.uri.toString());
    if (this.activeKey === oldKey) {
      this.activeKey = newKey;
    }
  }

  public keyForController(controller: SessionController): string | undefined {
    for (const [key, value] of this.controllers) {
      if (value === controller) {
        return key;
      }
    }
    return undefined;
  }

  /** Dispose + drop the controller for a key (e.g. when its tab closes). */
  public remove(key: string): void {
    const controller = this.controllers.get(key);
    if (!controller) {
      return;
    }
    controller.dispose();
    this.controllers.delete(key);
    this.folderByKey.delete(key);
    if (this.activeKey === key) {
      this.activeKey = undefined;
    }
  }

  public list(): SessionController[] {
    return [...this.controllers.values()];
  }

  /** The active controller for a folder (else any controller for it). */
  public getByFolderUri(folderUri: string): SessionController | undefined {
    if (this.activeKey && this.folderByKey.get(this.activeKey) === folderUri) {
      return this.controllers.get(this.activeKey);
    }
    for (const [key, folder] of this.folderByKey) {
      if (folder === folderUri) {
        return this.controllers.get(key);
      }
    }
    return undefined;
  }

  public setActive(
    target: vscode.WorkspaceFolder | SessionController | string
  ): SessionController | undefined {
    if (target instanceof SessionController) {
      const key = this.keyForController(target);
      if (key) {
        this.activeKey = key;
        return target;
      }
      return undefined;
    }
    // String: a controller key first, else a folderUri.
    const asKey = typeof target === 'string' ? target : target.uri.toString();
    if (this.controllers.has(asKey)) {
      this.activeKey = asKey;
      return this.controllers.get(asKey);
    }
    const folderUri = typeof target === 'string' ? target : target.uri.toString();
    const controller = this.getByFolderUri(folderUri);
    if (controller) {
      this.activeKey = this.keyForController(controller);
    }
    return controller;
  }

  public getActive(): SessionController | undefined {
    if (this.activeKey) {
      const controller = this.controllers.get(this.activeKey);
      if (controller) {
        return controller;
      }
    }
    // Fallback: any existing controller, else create the first folder's.
    const first = this.controllers.values().next().value as SessionController | undefined;
    if (first) {
      return first;
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
    if (folders.length === 1 && folders[0]) {
      return this.getOrCreate(folders[0]);
    }
    const picked = await vscode.window.showQuickPick(
      folders.map((folder) => ({
        label: folder.name,
        description: folder.uri.fsPath,
        folder,
      })),
      { title }
    );
    return picked ? this.getOrCreate(picked.folder) : undefined;
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
    this.folderByKey.clear();
    this.createEmitter.dispose();
  }
}
