export type ChatUiMode = 'simple' | 'advanced';

export type ComposerFocusTarget =
  | 'composer'
  | 'attach'
  | 'contextChip'
  | 'imageChip'
  | 'preview'
  | 'none';

export interface PersistedContextRefBase {
  workspaceRelativePath: string;
  lineStart: number;
  lineEnd: number;
}

export interface PersistedFileContextRef extends PersistedContextRefBase {
  languageId: string;
  contentFingerprint: string;
}

export interface PersistedDiagnosticsContextRef extends PersistedContextRefBase {
  severity: 'error' | 'warning' | 'info' | 'hint' | 'mixed';
  issueCount: number;
  diagnosticFingerprint: string;
}

export type PendingContextItem =
  | {
      kind: 'activeFile';
      itemId: string;
      workspaceFolder: string;
      workspaceRelativePath: string;
      lineStart: number;
      lineEnd: number;
      languageId: string;
      sanitizedContent: string;
      capturedAt: string;
      persistedRef: PersistedFileContextRef;
      stale?: boolean;
      staleReason?: string;
    }
  | {
      kind: 'pickedFile';
      itemId: string;
      workspaceFolder: string;
      workspaceRelativePath: string;
      lineStart: number;
      lineEnd: number;
      languageId: string;
      sanitizedContent: string;
      capturedAt: string;
      persistedRef: PersistedFileContextRef;
      stale?: boolean;
      staleReason?: string;
    }
  | {
      kind: 'selection';
      itemId: string;
      workspaceFolder: string;
      workspaceRelativePath: string;
      lineStart: number;
      lineEnd: number;
      languageId: string;
      sanitizedContent: string;
      capturedAt: string;
      persistedRef: PersistedFileContextRef;
      stale?: boolean;
      staleReason?: string;
    }
  | {
      kind: 'diagnostics';
      itemId: string;
      workspaceFolder: string;
      workspaceRelativePath: string;
      lineStart: number;
      lineEnd: number;
      severity: 'error' | 'warning' | 'info' | 'hint' | 'mixed';
      issueCount: number;
      sanitizedContent: string;
      capturedAt: string;
      persistedRef: PersistedDiagnosticsContextRef;
      stale?: boolean;
      staleReason?: string;
    };

export interface PendingImageItem {
  itemId: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  width?: number;
  height?: number;
  inMemoryBase64?: string;
  previewDataUrl?: string;
  requiresReselect?: boolean;
}

export interface AcceptedSendSnapshot {
  command: 'prompt' | 'follow_up' | 'steer';
  draft: string;
  serializedContextEnvelope?: string;
  rpcMessage: string;
  rpcImages: Array<{ type: 'image'; data: string; mimeType: string }>;
  contextItems: PendingContextItem[];
  imageItems: Array<{
    itemId: string;
    name: string;
    mimeType: string;
    sizeBytes: number;
    requiresReselect?: boolean;
  }>;
  acceptedAt: string;
  state: 'accepted' | 'failed';
  errorMessage?: string;
}

export interface SendPreviewState {
  command: 'prompt' | 'follow_up' | 'steer';
  draft: string;
  serializedContextEnvelope?: string;
  rpcMessage: string;
  rpcImages: Array<{ type: 'image'; data: string; mimeType: string }>;
  imageItems: Array<{
    itemId: string;
    name: string;
    mimeType: string;
    sizeBytes: number;
    requiresReselect?: boolean;
  }>;
}

export interface RecoveryState {
  kind: 'startFailure' | 'disconnected' | 'sendFailure' | 'preflightError';
  title: string;
  detail: string;
}

export interface ComposerSessionState {
  draft: string;
  composerResetSeq?: number;
  pendingContextItems: PendingContextItem[];
  pendingImages: PendingImageItem[];
  focus: ComposerFocusTarget;
  acceptedSendSnapshot?: AcceptedSendSnapshot;
  preview?: SendPreviewState;
  recovery?: RecoveryState;
}

export interface PersistedComposerSessionState {
  draft: string;
  pendingContextItems: Array<
    Omit<PendingContextItem, 'sanitizedContent'> & {
      sanitizedContent?: string;
    }
  >;
  pendingImages?: Array<
    Pick<PendingImageItem, 'itemId' | 'name' | 'mimeType' | 'sizeBytes' | 'width' | 'height'> & {
      requiresReselect?: boolean;
    }
  >;
  focus: ComposerFocusTarget;
}

const FILE_MAX_LINES = 200;
const FILE_MAX_CHARS = 16000;
const DIAGNOSTIC_MAX_ISSUES = 100;
const DIAGNOSTIC_MAX_CHARS = 8000;
const TOTAL_ENVELOPE_MAX_CHARS = 32000;
const CONTROL_CHARS =
  /[\u0000\u0001\u0002\u0003\u0004\u0005\u0006\u0007\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export function createEmptyComposerState(): ComposerSessionState {
  return {
    draft: '',
    pendingContextItems: [],
    pendingImages: [],
    focus: 'composer',
  };
}

export function cloneComposerState(state: ComposerSessionState): ComposerSessionState {
  return JSON.parse(JSON.stringify(state)) as ComposerSessionState;
}

export function canonicalSessionKey(
  workspaceFolderUri: string,
  sessionFile?: string,
  sessionId?: string
): string {
  if (sessionFile) {
    return `${workspaceFolderUri}::session:${sessionFile}`;
  }
  if (sessionId) {
    return `${workspaceFolderUri}::id:${sessionId}`;
  }
  return `${workspaceFolderUri}::workspace-draft`;
}

export function normalizeCapturedText(value: string): string {
  return value.replace(/\r\n?/g, '\n').replace(CONTROL_CHARS, '�');
}

function trimToBounds(value: string, maxLines: number, maxChars: number): string {
  const normalized = normalizeCapturedText(value);
  const lines = normalized.split('\n').slice(0, maxLines);
  const joined = lines.join('\n');
  return joined.length > maxChars ? joined.slice(0, maxChars) : joined;
}

export function fingerprint(value: string): string {
  const input = normalizeCapturedText(value);
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function boundFileContent(value: string): string {
  return trimToBounds(value, FILE_MAX_LINES, FILE_MAX_CHARS);
}

export function boundDiagnosticsContent(value: string): string {
  const normalized = normalizeCapturedText(value);
  const lines = normalized.split('\n').slice(0, DIAGNOSTIC_MAX_ISSUES);
  const joined = lines.join('\n');
  return joined.length > DIAGNOSTIC_MAX_CHARS ? joined.slice(0, DIAGNOSTIC_MAX_CHARS) : joined;
}

function canonicalContextLine(item: PendingContextItem): string {
  const base: Record<string, unknown> = {
    kind: item.kind,
    workspaceRelativePath: item.workspaceRelativePath,
    lineStart: item.lineStart,
    lineEnd: item.lineEnd,
  };
  if (item.kind === 'diagnostics') {
    base.severity = item.severity;
  } else {
    base.languageId = item.languageId;
  }
  base.content = normalizeCapturedText(item.sanitizedContent);
  return JSON.stringify(base);
}

export function serializeContextEnvelope(items: PendingContextItem[]): {
  envelope?: string;
  lines: string[];
  totalChars: number;
} {
  const lines: string[] = [];
  for (const item of items) {
    if (item.stale) {
      throw new Error('Remove or refresh expired attachments before sending.');
    }
    const content = normalizeCapturedText(item.sanitizedContent);
    const bounded =
      item.kind === 'diagnostics' ? boundDiagnosticsContent(content) : boundFileContent(content);
    if (bounded !== content) {
      throw new Error(
        item.kind === 'diagnostics'
          ? 'Diagnostics attachment is too large. Narrow or remove it before sending.'
          : 'File attachment is too large. Narrow or remove it before sending.'
      );
    }
    lines.push(canonicalContextLine(item));
  }
  if (lines.length === 0) {
    return { lines, totalChars: 0 };
  }
  const envelope = `<pi-vscode-context-v1>\n${lines.join('\n')}\n</pi-vscode-context-v1>`;
  if (envelope.length > TOTAL_ENVELOPE_MAX_CHARS) {
    throw new Error('Attachments are too large together. Narrow or remove one before sending.');
  }
  return { envelope, lines, totalChars: envelope.length };
}

export function buildSendPreview(
  command: 'prompt' | 'follow_up' | 'steer',
  state: ComposerSessionState
): SendPreviewState {
  if (
    !state.draft.trim() &&
    state.pendingContextItems.length === 0 &&
    state.pendingImages.length === 0
  ) {
    throw new Error('Enter a message or attach something to send.');
  }
  if (state.pendingImages.some((image) => image.requiresReselect || !image.inMemoryBase64)) {
    throw new Error('Reselect expired images before sending.');
  }
  const { envelope } = serializeContextEnvelope(state.pendingContextItems);
  const draft = state.draft;
  const rpcMessage = envelope ? (draft ? `${draft}\n\n${envelope}` : envelope) : draft;
  const rpcImages = state.pendingImages.map((image) => ({
    type: 'image' as const,
    data: image.inMemoryBase64 ?? '',
    mimeType: image.mimeType,
  }));
  return {
    command,
    draft,
    serializedContextEnvelope: envelope,
    rpcMessage,
    rpcImages,
    imageItems: state.pendingImages.map((image) => ({
      itemId: image.itemId,
      name: image.name,
      mimeType: image.mimeType,
      sizeBytes: image.sizeBytes,
      requiresReselect: image.requiresReselect,
    })),
  };
}

export function acceptedSnapshotFromPreview(
  preview: SendPreviewState,
  contextItems: PendingContextItem[]
): AcceptedSendSnapshot {
  return {
    command: preview.command,
    draft: preview.draft,
    serializedContextEnvelope: preview.serializedContextEnvelope,
    rpcMessage: preview.rpcMessage,
    rpcImages: preview.rpcImages,
    contextItems: JSON.parse(JSON.stringify(contextItems)) as PendingContextItem[],
    imageItems: preview.imageItems.map((item) => ({ ...item })),
    acceptedAt: new Date().toISOString(),
    state: 'accepted',
  };
}

export function restoreEditableStateFromAcceptedSnapshot(
  snapshot: AcceptedSendSnapshot
): Pick<ComposerSessionState, 'draft' | 'pendingContextItems' | 'pendingImages'> {
  return {
    draft: snapshot.draft,
    pendingContextItems: JSON.parse(JSON.stringify(snapshot.contextItems)) as PendingContextItem[],
    pendingImages: snapshot.imageItems.map((image) => ({
      itemId: image.itemId,
      name: image.name,
      mimeType: image.mimeType,
      sizeBytes: image.sizeBytes,
      requiresReselect: image.requiresReselect,
    })),
  };
}

export function persistableComposerState(
  state: ComposerSessionState
): PersistedComposerSessionState {
  return {
    draft: state.draft,
    pendingContextItems: state.pendingContextItems.map((item) => {
      const clone = { ...item } as Omit<PendingContextItem, 'sanitizedContent'> & {
        sanitizedContent?: string;
      };
      delete clone.sanitizedContent;
      return clone;
    }),
    pendingImages: state.pendingImages.map((item) => ({
      itemId: item.itemId,
      name: item.name,
      mimeType: item.mimeType,
      sizeBytes: item.sizeBytes,
      width: item.width,
      height: item.height,
      requiresReselect: true,
    })),
    focus: state.focus,
  };
}

export function summarizeChip(item: PendingContextItem): string {
  switch (item.kind) {
    case 'activeFile':
      return `Active file: ${item.workspaceRelativePath}`;
    case 'pickedFile':
      return `File: ${item.workspaceRelativePath}`;
    case 'selection':
      return `Selection: ${item.workspaceRelativePath} L${item.lineStart}-L${item.lineEnd}`;
    case 'diagnostics':
      return `Diagnostics: ${item.workspaceRelativePath} · ${item.issueCount} issues`;
  }
}

export function chipPrivacyLabel(item: PendingContextItem): string {
  switch (item.kind) {
    case 'activeFile':
      return 'Workspace file snapshot';
    case 'pickedFile':
      return 'Selected file snapshot';
    case 'selection':
      return 'Selected text only';
    case 'diagnostics':
      return 'Active-file diagnostics snapshot';
  }
}
