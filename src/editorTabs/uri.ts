import * as vscode from 'vscode';
import {
  parseChatPath,
  chatPathLabel,
  buildChatQuery,
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
  // The path is a short, friendly, deterministic label (drives the breadcrumb);
  // the full identity lives in the query so the breadcrumb never shows the long
  // encoded workspace/session paths.
  return vscode.Uri.from({
    scheme: CHAT_URI_SCHEME,
    path: `/${chatPathLabel(target)}.chat`,
    query: buildChatQuery(target),
  });
}

export function parseChatUri(uri: vscode.Uri): ChatTabTarget | undefined {
  if (uri.scheme !== CHAT_URI_SCHEME) {
    return undefined;
  }
  // Prefer the query (current format); fall back to the legacy path format for
  // tabs/URIs created by older versions.
  return parseChatQuery(uri.query) ?? parseChatPath(uri.path);
}
