export type WebviewInboundMessage =
  | { type: 'requestSend'; command: 'prompt' | 'follow_up' | 'steer' }
  | { type: 'acceptPreview' }
  | { type: 'cancelPreview' }
  | { type: 'copyAcceptedSnapshot' }
  | { type: 'sendAcceptedSnapshotAgain' }
  | { type: 'abort' }
  | { type: 'setDraft'; text: string }
  | {
      type: 'setFocus';
      focus: 'composer' | 'attach' | 'contextChip' | 'imageChip' | 'preview' | 'none';
    }
  | { type: 'executeCommand'; command: string; argument?: unknown }
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
  | { type: 'requestSlashCommands' };

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
        return { type: 'requestSend', command: record.command };
      }
      return undefined;
    case 'acceptPreview':
    case 'cancelPreview':
    case 'copyAcceptedSnapshot':
    case 'sendAcceptedSnapshotAgain':
    case 'abort':
    case 'pickImages':
    case 'clearAttachments':
    case 'appendActiveFile':
    case 'appendSelection':
    case 'appendDiagnostics':
    case 'appendPickedFile':
    case 'loadOlder':
      return { type: record.type };
    case 'setDraft':
      return typeof record.text === 'string' ? { type: 'setDraft', text: record.text } : undefined;
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
      return { type: 'requestSlashCommands' };
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
