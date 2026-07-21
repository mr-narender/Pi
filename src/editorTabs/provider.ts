import * as vscode from 'vscode';
import { ChatEditorDocument } from './document';
import { parseChatUri } from './uri';
import type { ChatTabManager } from './tabManager';

export class ChatEditorProvider implements vscode.CustomReadonlyEditorProvider<ChatEditorDocument> {
  public constructor(private readonly manager: ChatTabManager) {}

  public openCustomDocument(uri: vscode.Uri): ChatEditorDocument {
    // Recover the identity from the URI. If it can't be resolved (e.g. a tab
    // restored after the persisted short-id map was cleared), fall back to a
    // usable New Chat for the current workspace instead of throwing — throwing
    // here leaves the webview in a "Blocked" broken state.
    const target = parseChatUri(uri) ?? this.manager.fallbackDraftTarget();
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
