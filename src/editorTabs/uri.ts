import * as vscode from 'vscode';
import {
  parseChatPath,
  parseChatQuery,
  tabTitleFromTarget,
  chatTargetSessionKey,
  canonicalChatTarget,
  type ChatTabTarget,
} from './uriContract';
import { chatPathFor, rememberChatUri, lookupChatUri } from './uriRegistry';

export const CHAT_URI_SCHEME = 'pi-chat';
export const CHAT_EDITOR_VIEW_TYPE = 'piRpc.chatEditor';

export { tabTitleFromTarget, chatTargetSessionKey, canonicalChatTarget, type ChatTabTarget };

export function buildChatUri(target: ChatTabTarget): vscode.Uri {
  // Short, clean, deterministic path (drives the breadcrumb). The full identity
  // is remembered in a persisted `path -> identity` map so it survives restore
  // — unlike a URI query, which VS Code does not reliably round-trip.
  const canonical = canonicalChatTarget(target);
  const path = chatPathFor(canonical);
  rememberChatUri(path, canonical);
  return vscode.Uri.from({ scheme: CHAT_URI_SCHEME, path });
}

export function parseChatUri(uri: vscode.Uri): ChatTabTarget | undefined {
  if (uri.scheme !== CHAT_URI_SCHEME) {
    return undefined;
  }
  // 1) short-id map (current), 2) legacy path format, 3) legacy query format.
  return lookupChatUri(uri.path) ?? parseChatPath(uri.path) ?? parseChatQuery(uri.query);
}
