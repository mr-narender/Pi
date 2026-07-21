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

/**
 * Short, deterministic, human-readable label used as the URI path segment (and
 * therefore the editor breadcrumb). Must depend ONLY on the target so the URI
 * stays stable for tab identity/keying. The real, live chat name is shown on
 * the tab title, not here.
 */
export function chatPathLabel(target: ChatTabTarget): string {
  const canonical = canonicalChatTarget(target);
  if (canonical.kind === 'sessionFile' && canonical.sessionFile) {
    const stem = basename(canonical.sessionFile).replace(/\.jsonl$/i, '');
    const idPart = stem.includes('_') ? stem.slice(stem.indexOf('_') + 1) : stem;
    const short = idPart.slice(0, 8);
    return short ? `Chat ${short}` : 'Chat';
  }
  if (canonical.kind === 'sessionId' && canonical.sessionId) {
    return `Chat ${canonical.sessionId.slice(0, 8)}`;
  }
  return 'New Chat';
}

/** Encode the full target identity into a URI query string. */
export function buildChatQuery(target: ChatTabTarget): string {
  const canonical = canonicalChatTarget(target);
  const params = new URLSearchParams();
  params.set('w', encodeSegment(canonical.workspaceFolderUri));
  params.set('k', canonical.kind);
  if (canonical.kind === 'sessionFile' && canonical.sessionFile) {
    params.set('f', encodeSegment(canonical.sessionFile));
  } else if (canonical.kind === 'sessionId' && canonical.sessionId) {
    params.set('s', encodeSegment(canonical.sessionId));
  }
  return params.toString();
}

/** Recover a target from a URI query built by {@link buildChatQuery}. */
export function parseChatQuery(query: string): ChatTabTarget | undefined {
  if (!query) {
    return undefined;
  }
  const params = new URLSearchParams(query);
  const workspaceKey = params.get('w');
  const kind = params.get('k');
  if (!workspaceKey || !kind) {
    return undefined;
  }
  const workspaceFolderUri = decodeSegment(workspaceKey);
  if (kind === 'sessionFile') {
    const encoded = params.get('f');
    return encoded
      ? { workspaceFolderUri, kind: 'sessionFile', sessionFile: decodeSegment(encoded) }
      : undefined;
  }
  if (kind === 'sessionId') {
    const encoded = params.get('s');
    return encoded
      ? { workspaceFolderUri, kind: 'sessionId', sessionId: decodeSegment(encoded) }
      : undefined;
  }
  if (kind === 'workspaceDraft') {
    return { workspaceFolderUri, kind: 'workspaceDraft' };
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
