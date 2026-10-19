export type WebviewInboundMessage =
  | {
      type: 'requestSend';
      command: 'prompt' | 'follow_up' | 'steer';
      submissionId?: string;
    }
  | { type: 'acceptPreview' }
  | { type: 'cancelPreview' }
  | { type: 'copyAcceptedSnapshot' }
  | { type: 'sendAcceptedSnapshotAgain' }
  | { type: 'abort' }
  | { type: 'checkMcpStatus' }
  | { type: 'modelToolsRequest'; originKey: string; requestId: string }
  | {
      type: 'modelToolsApply';
      originKey: string;
      requestId: string;
      revision: string;
      names: string[];
    }
  | {
      type: 'outboxAction';
      key: string;
      id: string;
      revision: number;
      action: 'edit' | 'save' | 'cancel' | 'remove' | 'resume' | 'steer' | 'discard';
      text?: string;
    }
  | { type: 'toggleFollow' }
  | { type: 'screenOpenFile'; path: string; needle?: string }
  | { type: 'screenRevert'; callId: string }
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
  | { type: 'loadOlder' }
  | { type: 'openExternal'; url: string }
  | { type: 'openFile'; path: string }
  | { type: 'openIdeLocation'; path: string; line: number; character: number }
  | { type: 'openDiff'; path: string }
  | { type: 'attachFile'; path: string }
  | { type: 'dropFile'; name: string; mimeType: string; sizeBytes: number; data: string }
  | { type: 'requestFileMentions'; query: string }
  | { type: 'requestSlashCommands'; requestId?: string }
  | { type: 'pasteImage'; data: string; mimeType: string }
  | { type: 'diag'; scope: string; detail: string }
  | {
      type: 'respondUi';
      id: string;
      requestKey: string;
      value?: string;
      confirmed?: boolean;
      cancelled?: boolean;
    };

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
    case 'modelToolsRequest':
    case 'modelToolsApply': {
      if (
        typeof record.originKey !== 'string' ||
        !record.originKey ||
        record.originKey.length > 16384 ||
        typeof record.requestId !== 'string' ||
        !record.requestId ||
        record.requestId.length > 200
      )
        return undefined;
      if (record.type === 'modelToolsRequest')
        return { type: record.type, originKey: record.originKey, requestId: record.requestId };
      if (
        typeof record.revision !== 'string' ||
        !record.revision ||
        record.revision.length > 512 ||
        !Array.isArray(record.names) ||
        record.names.length > 512 ||
        record.names.some(
          (name) =>
            typeof name !== 'string' ||
            !name ||
            name.length > 200 ||
            /[\u0000-\u001f\u007f]/.test(name)
        ) ||
        new Set(record.names).size !== record.names.length
      )
        return undefined;
      return {
        type: record.type,
        originKey: record.originKey,
        requestId: record.requestId,
        revision: record.revision,
        names: [...record.names] as string[],
      };
    }
    case 'outboxAction': {
      const action = record.action;
      if (
        typeof record.key !== 'string' ||
        !record.key ||
        record.key.length > 16384 ||
        typeof record.id !== 'string' ||
        !record.id ||
        record.id.length > 256 ||
        !Number.isSafeInteger(record.revision) ||
        Number(record.revision) < 0 ||
        typeof action !== 'string' ||
        !['edit', 'save', 'cancel', 'remove', 'resume', 'steer', 'discard'].includes(action) ||
        (action === 'save'
          ? typeof record.text !== 'string' || record.text.length > 160000
          : record.text !== undefined)
      )
        return undefined;
      return {
        type: 'outboxAction',
        key: record.key,
        id: record.id,
        revision: Number(record.revision),
        action: action as 'edit' | 'save' | 'cancel' | 'remove' | 'resume' | 'steer' | 'discard',
        ...(action === 'save' ? { text: record.text as string } : {}),
      };
    }
    case 'requestSend':
      if (
        record.command === 'prompt' ||
        record.command === 'follow_up' ||
        record.command === 'steer'
      ) {
        return {
          submissionId: typeof record.submissionId === 'string' ? record.submissionId : undefined,
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
    case 'checkMcpStatus':
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
      return typeof record.callId === 'string' && record.callId.length > 0
        ? {
            type: 'screenRevert',
            callId: record.callId,
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
    case 'openIdeLocation':
      return typeof record.path === 'string' &&
        record.path.length <= 4096 &&
        Number.isSafeInteger(record.line) &&
        Number(record.line) >= 1 &&
        Number(record.line) <= 1000000 &&
        Number.isSafeInteger(record.character) &&
        Number(record.character) >= 1 &&
        Number(record.character) <= 1000000
        ? {
            type: 'openIdeLocation',
            path: record.path,
            line: Number(record.line),
            character: Number(record.character),
          }
        : undefined;
    case 'openDiff':
      return typeof record.path === 'string' ? { type: 'openDiff', path: record.path } : undefined;
    case 'attachFile':
      return typeof record.path === 'string'
        ? { type: 'attachFile', path: record.path }
        : undefined;
    case 'dropFile':
      return typeof record.name === 'string' &&
        typeof record.mimeType === 'string' &&
        typeof record.sizeBytes === 'number' &&
        Number.isFinite(record.sizeBytes) &&
        record.sizeBytes >= 0 &&
        typeof record.data === 'string'
        ? {
            type: 'dropFile',
            name: record.name.slice(0, 256),
            mimeType: record.mimeType.slice(0, 128),
            sizeBytes: Math.floor(record.sizeBytes),
            data: record.data,
          }
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
      if (
        typeof record.id !== 'string' ||
        !record.id ||
        record.id.length > 512 ||
        typeof record.requestKey !== 'string' ||
        !record.requestKey ||
        record.requestKey.length > 512 ||
        (record.value !== undefined &&
          (typeof record.value !== 'string' || record.value.length > 160000))
      ) {
        return undefined;
      }
      const response: {
        type: 'respondUi';
        id: string;
        requestKey: string;
        value?: string;
        confirmed?: boolean;
        cancelled?: boolean;
      } = {
        type: 'respondUi',
        id: record.id,
        requestKey: record.requestKey,
      };
      if (typeof record.value === 'string') {
        response.value = record.value;
      }
      if (typeof record.confirmed === 'boolean') {
        response.confirmed = record.confirmed;
      }
      if (record.cancelled === true) {
        response.cancelled = true;
      }
      return response;
    }
    default:
      return undefined;
  }
}
