import * as vscode from 'vscode';
import { ChatEditorDocument } from './document';
import { parseChatUri } from './uri';
import type { ChatTabManager } from './tabManager';

export class ChatEditorProvider implements vscode.CustomReadonlyEditorProvider<ChatEditorDocument> {
  public constructor(private readonly manager: ChatTabManager) {}

  public openCustomDocument(uri: vscode.Uri): ChatEditorDocument {
    const target = parseChatUri(uri);
    if (!target) {
      throw new Error(`Unsupported Pi chat URI: ${uri.toString()}`);
    }
    return new ChatEditorDocument(uri, target);
  }

  public async resolveCustomEditor(
    document: ChatEditorDocument,
    webviewPanel: vscode.WebviewPanel
  ): Promise<void> {
    await this.manager.resolveEditor(document, webviewPanel);
  }
}
