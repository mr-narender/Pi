import * as vscode from 'vscode';
import {
  buildChatPath,
  parseChatPath,
  tabTitleFromTarget,
  chatTargetSessionKey,
  canonicalChatTarget,
  type ChatTabTarget,
} from './uriContract';

export const CHAT_URI_SCHEME = 'pi-chat';
export const CHAT_EDITOR_VIEW_TYPE = 'piRpc.chatEditor';

export { tabTitleFromTarget, chatTargetSessionKey, canonicalChatTarget, type ChatTabTarget };

export function buildChatUri(target: ChatTabTarget): vscode.Uri {
  return vscode.Uri.from({
    scheme: CHAT_URI_SCHEME,
    path: buildChatPath(target),
  });
}

export function parseChatUri(uri: vscode.Uri): ChatTabTarget | undefined {
  if (uri.scheme !== CHAT_URI_SCHEME) {
    return undefined;
  }
  return parseChatPath(uri.path);
}
