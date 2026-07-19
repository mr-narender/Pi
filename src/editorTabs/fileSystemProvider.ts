import * as vscode from 'vscode';
import { CHAT_URI_SCHEME } from './uri';

/**
 * Minimal in-memory read-only FileSystemProvider for the `pi-chat:` scheme.
 *
 * A CustomReadonlyEditorProvider can only be resolved by VS Code if the editor
 * input URI is backed by a FileSystemProvider. Without one, `vscode.openWith`
 * on a `pi-chat:` URI never resolves the resource and the custom-editor tab
 * spins on a permanent loading indicator. The actual chat content is rendered
 * entirely by the webview, so the backing "document" only needs to exist as a
 * zero-byte readable file.
 */
export class ChatFileSystemProvider implements vscode.FileSystemProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  public readonly onDidChangeFile = this.emitter.event;

  public static register(): vscode.Disposable {
    return vscode.workspace.registerFileSystemProvider(
      CHAT_URI_SCHEME,
      new ChatFileSystemProvider(),
      { isReadonly: true, isCaseSensitive: true }
    );
  }

  public watch(): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }

  public stat(_uri: vscode.Uri): vscode.FileStat {
    return {
      type: vscode.FileType.File,
      ctime: 0,
      mtime: 0,
      size: 0,
      permissions: vscode.FilePermission.Readonly,
    };
  }

  public readDirectory(): [string, vscode.FileType][] {
    return [];
  }

  public readFile(_uri: vscode.Uri): Uint8Array {
    return new Uint8Array(0);
  }

  public createDirectory(): void {
    throw vscode.FileSystemError.NoPermissions('pi-chat is read-only');
  }

  public writeFile(): void {
    throw vscode.FileSystemError.NoPermissions('pi-chat is read-only');
  }

  public delete(): void {
    throw vscode.FileSystemError.NoPermissions('pi-chat is read-only');
  }

  public rename(): void {
    throw vscode.FileSystemError.NoPermissions('pi-chat is read-only');
  }
}
