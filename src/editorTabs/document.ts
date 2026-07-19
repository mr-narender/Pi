import * as vscode from 'vscode';
import type { ChatTabTarget } from './uri';

export class ChatEditorDocument implements vscode.CustomDocument {
  public constructor(
    public readonly uri: vscode.Uri,
    public readonly target: ChatTabTarget
  ) {}

  public dispose(): void {
    // Nothing to dispose.
  }
}
