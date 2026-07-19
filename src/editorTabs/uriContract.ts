import { basename } from 'node:path';
import { canonicalSessionKey } from '../webview/composer';

export interface ChatTabTarget {
  workspaceFolderUri: string;
  kind: 'workspaceDraft' | 'sessionFile' | 'sessionId';
  sessionFile?: string;
  sessionId?: string;
}

function encodeSegment(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function decodeSegment(value: string): string {
  return Buffer.from(value, 'base64url').toString('utf8');
}

export function canonicalChatTarget(target: ChatTabTarget): ChatTabTarget {
  if (target.sessionFile) {
    return {
      workspaceFolderUri: target.workspaceFolderUri,
      kind: 'sessionFile',
      sessionFile: target.sessionFile,
    };
  }
  if (target.sessionId) {
    return {
      workspaceFolderUri: target.workspaceFolderUri,
      kind: 'sessionId',
      sessionId: target.sessionId,
    };
  }
  return {
    workspaceFolderUri: target.workspaceFolderUri,
    kind: 'workspaceDraft',
  };
}

export function chatTargetSessionKey(target: ChatTabTarget): string {
  const canonical = canonicalChatTarget(target);
  return canonicalSessionKey(
    canonical.workspaceFolderUri,
    canonical.sessionFile,
    canonical.sessionId
  );
}

export function buildChatPath(target: ChatTabTarget): string {
  const canonical = canonicalChatTarget(target);
  const workspaceKey = encodeSegment(canonical.workspaceFolderUri);
  if (canonical.kind === 'sessionFile' && canonical.sessionFile) {
    return `/${workspaceKey}/session-file/${encodeSegment(canonical.sessionFile)}.chat`;
  }
  if (canonical.kind === 'sessionId' && canonical.sessionId) {
    return `/${workspaceKey}/session-id/${encodeSegment(canonical.sessionId)}.chat`;
  }
  return `/${workspaceKey}/draft.chat`;
}

export function parseChatPath(path: string): ChatTabTarget | undefined {
  const parts = path.split('/').filter(Boolean);
  const workspaceKey = parts[0];
  if (!workspaceKey) {
    return undefined;
  }
  const workspaceFolderUri = decodeSegment(workspaceKey);
  if (parts.length === 2 && parts[1] === 'draft.chat') {
    return { workspaceFolderUri, kind: 'workspaceDraft' };
  }
  if (parts.length !== 3) {
    return undefined;
  }
  const [, kind, encodedValue] = parts;
  if (
    typeof kind !== 'string' ||
    typeof encodedValue !== 'string' ||
    !encodedValue.endsWith('.chat')
  ) {
    return undefined;
  }
  const rawValue = encodedValue.slice(0, -'.chat'.length);
  if (kind === 'session-file') {
    return {
      workspaceFolderUri,
      kind: 'sessionFile',
      sessionFile: decodeSegment(rawValue),
    };
  }
  if (kind === 'session-id') {
    return {
      workspaceFolderUri,
      kind: 'sessionId',
      sessionId: decodeSegment(rawValue),
    };
  }
  return undefined;
}

export function tabTitleFromTarget(target: ChatTabTarget, workspaceFolderName?: string): string {
  if (target.kind === 'sessionFile' && target.sessionFile) {
    return basename(target.sessionFile);
  }
  if (target.kind === 'sessionId' && target.sessionId) {
    return target.sessionId;
  }
  if (workspaceFolderName) {
    return `${workspaceFolderName} Chat`;
  }
  return 'New Chat';
}
