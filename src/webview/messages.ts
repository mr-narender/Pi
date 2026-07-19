export type WebviewInboundMessage =
  | { type: 'send'; mode: 'prompt' | 'steer' | 'followUp'; text: string }
  | { type: 'abort' }
  | { type: 'refresh' }
  | { type: 'setDraft'; text: string }
  | { type: 'executeCommand'; command: string; argument?: unknown }
  | { type: 'pickImages' }
  | { type: 'clearImages' }
  | { type: 'appendActiveFile' }
  | { type: 'appendSelection' }
  | { type: 'appendDiagnostics' }
  | { type: 'appendPickedFile' }
  | { type: 'openAttachment'; uri: string }
  | { type: 'switchFolder'; folderUri: string };

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
    case 'send':
      if (
        typeof record.text === 'string' &&
        (record.mode === 'prompt' || record.mode === 'steer' || record.mode === 'followUp')
      ) {
        return { type: 'send', mode: record.mode, text: record.text };
      }
      return undefined;
    case 'abort':
    case 'refresh':
    case 'pickImages':
    case 'clearImages':
    case 'appendActiveFile':
    case 'appendSelection':
    case 'appendDiagnostics':
    case 'appendPickedFile':
      return { type: record.type };
    case 'setDraft':
      return typeof record.text === 'string' ? { type: 'setDraft', text: record.text } : undefined;
    case 'executeCommand':
      return typeof record.command === 'string'
        ? { type: 'executeCommand', command: record.command, argument: record.argument }
        : undefined;
    case 'openAttachment':
      return typeof record.uri === 'string'
        ? { type: 'openAttachment', uri: record.uri }
        : undefined;
    case 'switchFolder':
      return typeof record.folderUri === 'string'
        ? { type: 'switchFolder', folderUri: record.folderUri }
        : undefined;
    default:
      return undefined;
  }
}
