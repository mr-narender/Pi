import * as vscode from 'vscode';
import {
  buildChatPath,
  parseChatPath,
  parseChatQuery,
  tabTitleFromTarget,
  chatTargetSessionKey,
  canonicalChatTarget,
  type ChatTabTarget,
} from './uriContract';

export const CHAT_URI_SCHEME = 'pi-chat';
export const CHAT_EDITOR_VIEW_TYPE = 'piRpc.chatEditor';

export { tabTitleFromTarget, chatTargetSessionKey, canonicalChatTarget, type ChatTabTarget };

export function buildChatUri(target: ChatTabTarget): vscode.Uri {
  // Identity MUST live in the path: VS Code does not reliably round-trip a
  // custom-editor URI's query string when it restores/reopens a tab, so a
  // query-based identity is lost on restore and the editor fails to resolve
  // ("Blocked vscode-webview request"). The path always survives.
  return vscode.Uri.from({
    scheme: CHAT_URI_SCHEME,
    path: buildChatPath(target),
  });
}

export function parseChatUri(uri: vscode.Uri): ChatTabTarget | undefined {
  if (uri.scheme !== CHAT_URI_SCHEME) {
    return undefined;
  }
  // Path is the source of truth; fall back to the query only for any tabs that
  // were created by 0.0.31/0.0.32 while identity briefly lived in the query.
  return parseChatPath(uri.path) ?? parseChatQuery(uri.query);
}
