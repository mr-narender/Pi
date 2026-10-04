export type WebviewInboundMessage =
  | {
      type: 'requestSend';
      command: 'prompt' | 'follow_up' | 'steer';
      follow?: boolean;
      submissionId?: string;
    }
  | { type: 'acceptPreview' }
  | { type: 'cancelPreview' }
  | { type: 'copyAcceptedSnapshot' }
  | { type: 'sendAcceptedSnapshotAgain' }
  | { type: 'abort' }
  | { type: 'toggleFollow' }
  | { type: 'screenOpenFile'; path: string; needle?: string }
  | { type: 'screenRevert'; path: string; oldText?: string; newText?: string }
  | { type: 'setDraft'; text: string; resetSeq?: number }
  | {
      type: 'setFocus';
      focus: 'composer' | 'attach' | 'contextChip' | 'imageChip' | 'preview' | 'none';
    }
  | { type: 'executeCommand'; command: string; argument?: unknown }
  | {
      type: 'forkAndSend';
      fromBottom: number;
      originalText: string;
      text: string;
      pickModel?: boolean;
    }
  | { type: 'debugLog'; text: string }
  | { type: 'pickImages' }
  | { type: 'clearAttachments' }
  | { type: 'appendActiveFile' }
  | { type: 'appendSelection' }
  | { type: 'appendDiagnostics' }
  | { type: 'appendPickedFile' }
  | { type: 'removeContextItem'; itemId: string }
  | { type: 'removeImageItem'; itemId: string }
  | { type: 'openAttachment'; uri: string }
  | { type: 'switchFolder'; folderUri: string }
  | { type: 'loadOlder' }
  | { type: 'insertCode'; text: string; language?: string }
  | { type: 'newFileFromCode'; text: string; language?: string }
  | { type: 'openExternal'; url: string }
  | { type: 'openFile'; path: string }
  | { type: 'openDiff'; path: string }
  | { type: 'attachFile'; path: string }
  | { type: 'requestFileMentions'; query: string }
  | { type: 'requestSlashCommands'; requestId?: string }
  | { type: 'pasteImage'; data: string; mimeType: string }
  | { type: 'diag'; scope: string; detail: string }
  | { type: 'respondUi'; id: string; value?: string; confirmed?: boolean };

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function parseWebviewMessage(value: unknown): WebviewInboundMessage | undefined {
  const record = asRecord(value);
  if (!record || typeof record.type !== 'string') {
    return undefined;
  }
  switch (record.type) {
    case 'requestSend':
      if (
        record.command === 'prompt' ||
        record.command === 'follow_up' ||
        record.command === 'steer'
      ) {
        return {
          submissionId: typeof record.submissionId === 'string' ? record.submissionId : undefined,
          follow: record.follow === true ? true : undefined,
          type: 'requestSend',
          command: record.command,
        };
      }
      return undefined;
    case 'acceptPreview':
    case 'cancelPreview':
    case 'copyAcceptedSnapshot':
    case 'sendAcceptedSnapshotAgain':
    case 'toggleFollow':
    case 'abort':
    case 'pickImages':
    case 'clearAttachments':
    case 'appendActiveFile':
    case 'appendSelection':
    case 'appendDiagnostics':
    case 'appendPickedFile':
    case 'loadOlder':
      return { type: record.type };
    case 'screenOpenFile':
      return typeof record.path === 'string'
        ? {
            type: 'screenOpenFile',
            path: record.path,
            needle: typeof record.needle === 'string' ? record.needle : undefined,
          }
        : undefined;
    case 'screenRevert':
      return typeof record.path === 'string'
        ? {
            type: 'screenRevert',
            path: record.path,
            oldText: typeof record.oldText === 'string' ? record.oldText : undefined,
            newText: typeof record.newText === 'string' ? record.newText : undefined,
          }
        : undefined;
    case 'setDraft':
      return typeof record.text === 'string'
        ? {
            type: 'setDraft',
            text: record.text,
            resetSeq: typeof record.resetSeq === 'number' ? record.resetSeq : undefined,
          }
        : undefined;
    case 'setFocus':
      return record.focus === 'composer' ||
        record.focus === 'attach' ||
        record.focus === 'contextChip' ||
        record.focus === 'imageChip' ||
        record.focus === 'preview' ||
        record.focus === 'none'
        ? { type: 'setFocus', focus: record.focus }
        : undefined;
    case 'executeCommand':
      return typeof record.command === 'string'
        ? { type: 'executeCommand', command: record.command, argument: record.argument }
        : undefined;
    case 'debugLog':
      return typeof record.text === 'string' ? { type: 'debugLog', text: record.text } : undefined;
    case 'forkAndSend':
      return typeof record.fromBottom === 'number' &&
        Number.isFinite(record.fromBottom) &&
        typeof record.text === 'string' &&
        record.text.trim().length > 0
        ? {
            type: 'forkAndSend',
            fromBottom: record.fromBottom,
            originalText: typeof record.originalText === 'string' ? record.originalText : '',
            text: record.text,
            ...(record.pickModel === true ? { pickModel: true } : {}),
          }
        : undefined;
    case 'removeContextItem':
    case 'removeImageItem':
      return typeof record.itemId === 'string'
        ? { type: record.type, itemId: record.itemId }
        : undefined;
    case 'openAttachment':
      return typeof record.uri === 'string'
        ? { type: 'openAttachment', uri: record.uri }
        : undefined;
    case 'openExternal':
      return typeof record.url === 'string' ? { type: 'openExternal', url: record.url } : undefined;
    case 'openFile':
      return typeof record.path === 'string' ? { type: 'openFile', path: record.path } : undefined;
    case 'openDiff':
      return typeof record.path === 'string' ? { type: 'openDiff', path: record.path } : undefined;
    case 'attachFile':
      return typeof record.path === 'string'
        ? { type: 'attachFile', path: record.path }
        : undefined;
    case 'requestFileMentions':
      return typeof record.query === 'string'
        ? { type: 'requestFileMentions', query: record.query }
        : undefined;
    case 'requestSlashCommands':
      return {
        type: 'requestSlashCommands',
        ...(typeof record.requestId === 'string' ? { requestId: record.requestId } : {}),
      };
    case 'pasteImage':
      return typeof record.data === 'string' && typeof record.mimeType === 'string'
        ? { type: 'pasteImage', data: record.data, mimeType: record.mimeType }
        : undefined;
    // 'pasteText' intentionally removed: pasted text stays plain text in the
    // composer — only images (and file URIs) become chips.
    case 'diag':
      // Webview-side breadcrumbs (e.g. what a paste delivered) — log-only,
      // bounded so a hostile payload can't flood the output channel.
      return typeof record.scope === 'string' && typeof record.detail === 'string'
        ? { type: 'diag', scope: record.scope.slice(0, 64), detail: record.detail.slice(0, 2000) }
        : undefined;
    case 'respondUi': {
      if (typeof record.id !== 'string') {
        return undefined;
      }
      const response: { type: 'respondUi'; id: string; value?: string; confirmed?: boolean } = {
        type: 'respondUi',
        id: record.id,
      };
      if (typeof record.value === 'string') {
        response.value = record.value;
      }
      if (typeof record.confirmed === 'boolean') {
        response.confirmed = record.confirmed;
      }
      return response;
    }
    case 'insertCode':
    case 'newFileFromCode':
      return typeof record.text === 'string'
        ? {
            type: record.type,
            text: record.text,
            language: typeof record.language === 'string' ? record.language : undefined,
          }
        : undefined;
    case 'switchFolder':
      return typeof record.folderUri === 'string'
        ? { type: 'switchFolder', folderUri: record.folderUri }
        : undefined;
    default:
      return undefined;
  }
}
