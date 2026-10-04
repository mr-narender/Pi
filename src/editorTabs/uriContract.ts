import { basename, resolve } from 'node:path';
import { canonicalSessionKey } from '../webview/composer';

/**
 * Normalize a session-file path for IDENTITY comparison only.
 *
 * The same session can be referenced by slightly different path strings across
 * the sidebar (what we clicked) and what the running Pi reports back after a
 * resume — most importantly on Windows, where drive-letter casing and
 * forward/back slashes differ and the filesystem is case-insensitive. Without
 * this, `sameTarget` returns false, the tab never binds as "current", and it
 * shows an empty transcript titled with the long .jsonl filename. Comparing
 * `resolve()`d (and, on Windows, lower-cased) paths fixes that.
 */
export function normalizeSessionFilePath(sessionFile: string): string {
  const resolved = resolve(sessionFile);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export interface ChatTabTarget {
  workspaceFolderUri: string;
  kind: 'workspaceDraft' | 'sessionFile' | 'sessionId';
  sessionFile?: string;
  sessionId?: string;
  /** Unique per New Chat click: lets several drafts coexist and lets a draft
   * tab keep its URI forever (it gets BOUND to its session in place — no
   * open/close tab swap on the first message). */
  draftId?: string;
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
    ...(target.draftId ? { draftId: target.draftId } : {}),
  };
}

export function chatTargetSessionKey(target: ChatTabTarget): string {
  const canonical = canonicalChatTarget(target);
  const base = canonicalSessionKey(
    canonical.workspaceFolderUri,
    canonical.sessionFile ? normalizeSessionFilePath(canonical.sessionFile) : undefined,
    canonical.sessionId
  );
  return canonical.kind === 'workspaceDraft' && canonical.draftId
    ? `${base}#d:${canonical.draftId}`
    : base;
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
