import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { redactText } from '../diagnostics/redaction';
import type { JsonObject, JsonValue } from '../rpc/protocol';
import type {
  ControllerState,
  WebviewAttachmentFileRef,
  WebviewAttachmentItem,
  WebviewAttachmentPreviewItem,
  WebviewMessageItem,
  WebviewSnapshot,
} from '../state/types';

const MAX_MESSAGES = 200;
const MAX_ATTACHMENT_NAME_CHARS = 160;
const MAX_ATTACHMENT_MIME_CHARS = 120;
const MAX_ATTACHMENT_TEXT_CHARS = 400;
const MAX_ATTACHMENT_PREVIEW_VALUE_CHARS = 160;
const MAX_ATTACHMENT_PREVIEW_ITEMS = 8;
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const URI_PATTERN = /^[a-zA-Z][a-zA-Z\d+.-]*:/;

function messageText(message: JsonObject): string {
  const role = typeof message.role === 'string' ? message.role : 'unknown';
  const content = message.content;
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (!block || typeof block !== 'object') {
          return '[unknown block]';
        }
        const typed = block as Record<string, unknown>;
        if (typed.type === 'text' && typeof typed.text === 'string') {
          return typed.text;
        }
        if (typed.type === 'thinking' && typeof typed.thinking === 'string') {
          return `[thinking]\n${typed.thinking}`;
        }
        if (typed.type === 'toolCall') {
          return `[tool:${String(typed.name ?? 'unknown')}] ${JSON.stringify(typed.arguments ?? {})}`;
        }
        if (typed.type === 'image') {
          return `[image:${String(typed.mimeType ?? 'unknown')}]`;
        }
        return '[unknown block]';
      })
      .join('\n');
  }
  return `[${role}]`;
}

function asObject(value: unknown): JsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function sanitizeDisplayText(value: string, limit: number): string {
  const compact = value.replace(CONTROL_CHARS, ' ');
  const trimmed = compact.trim();
  if (/^data:/i.test(trimmed)) {
    return '[data URI omitted]';
  }
  const collapsed = trimmed.replace(/\s+/g, '');
  if (
    collapsed.length >= 32 &&
    collapsed.length % 4 === 0 &&
    /^[A-Za-z0-9+/]+=*$/.test(collapsed)
  ) {
    return '[base64 omitted]';
  }
  const redacted = redactText(compact);
  return redacted.length > limit ? `${redacted.slice(0, limit)}…` : redacted;
}

function sanitizeOptionalText(value: unknown, limit: number): string | undefined {
  return typeof value === 'string' ? sanitizeDisplayText(value, limit) : undefined;
}

function normalizeSize(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

function normalizePreviewValue(value: JsonValue | undefined): string {
  if (typeof value === 'string') {
    return sanitizeDisplayText(value, MAX_ATTACHMENT_PREVIEW_VALUE_CHARS);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (value === null) {
    return 'null';
  }
  return sanitizeDisplayText(JSON.stringify(value), MAX_ATTACHMENT_PREVIEW_VALUE_CHARS);
}

function maybeWorkspaceFileRef(
  candidate: string,
  cwd: string
): WebviewAttachmentFileRef | undefined {
  const trimmed = candidate.trim();
  if (!trimmed || !cwd) {
    return undefined;
  }

  let filePath: string;
  if (URI_PATTERN.test(trimmed)) {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return undefined;
    }
    if (parsed.protocol !== 'file:') {
      return undefined;
    }
    filePath = fileURLToPath(parsed);
  } else {
    filePath = isAbsolute(trimmed) ? trimmed : resolve(cwd, trimmed);
  }

  const relativePath = relative(cwd, filePath);
  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    return undefined;
  }

  const normalizedPath = (relativePath || '.').split(sep).join('/');
  return {
    uri: pathToFileURL(filePath).toString(),
    path: sanitizeDisplayText(normalizedPath, MAX_ATTACHMENT_NAME_CHARS),
  };
}

function attachmentFileRef(
  attachment: JsonObject,
  preview: JsonObject | undefined,
  cwd: string
): WebviewAttachmentFileRef | undefined {
  const sources = [attachment, preview].filter((value): value is JsonObject => !!value);
  for (const source of sources) {
    for (const key of ['fileUri', 'uri', 'filePath', 'path']) {
      const value = source[key];
      if (typeof value === 'string') {
        const resolved = maybeWorkspaceFileRef(value, cwd);
        if (resolved) {
          return resolved;
        }
      }
    }
  }
  return undefined;
}

function normalizePreviewItems(value: unknown): WebviewAttachmentPreviewItem[] {
  const preview = asObject(value);
  if (!preview) {
    return value === undefined || value === null
      ? []
      : [{ key: 'value', value: normalizePreviewValue(value as JsonValue | undefined) }];
  }
  return Object.entries(preview)
    .slice(0, MAX_ATTACHMENT_PREVIEW_ITEMS)
    .map(([key, item]) => ({
      key: sanitizeDisplayText(key, 40),
      value: normalizePreviewValue(item),
    }));
}

export function normalizeAttachment(
  attachment: unknown,
  cwd: string
): WebviewAttachmentItem | undefined {
  const record = asObject(attachment);
  if (!record) {
    return undefined;
  }

  const preview = asObject(record.preview);
  return {
    id: sanitizeOptionalText(record.id, 80),
    type: sanitizeOptionalText(record.type, 40) ?? 'attachment',
    name: sanitizeOptionalText(record.fileName ?? record.name, MAX_ATTACHMENT_NAME_CHARS),
    mimeType: sanitizeOptionalText(record.mimeType, MAX_ATTACHMENT_MIME_CHARS),
    size: normalizeSize(record.size),
    hasContent: typeof record.content === 'string' && record.content.length > 0,
    extractedText: sanitizeOptionalText(record.extractedText, MAX_ATTACHMENT_TEXT_CHARS),
    previewItems: normalizePreviewItems(record.preview),
    fileRef: attachmentFileRef(record, preview, cwd),
  };
}

function normalizeAttachments(value: unknown, cwd: string): WebviewAttachmentItem[] {
  return Array.isArray(value)
    ? value
        .map((item) => normalizeAttachment(item, cwd))
        .filter((item): item is WebviewAttachmentItem => !!item)
    : [];
}

function toItem(message: JsonObject, index: number, cwd: string): WebviewMessageItem {
  return {
    id: typeof message.id === 'string' ? message.id : `m${index}`,
    role: typeof message.role === 'string' ? message.role : 'unknown',
    text: messageText(message),
    attachments: normalizeAttachments(message.attachments, cwd),
  };
}

function normalizePendingImage(
  image: WebviewSnapshot['pendingImages'][number]
): WebviewSnapshot['pendingImages'][number] {
  return {
    name: sanitizeDisplayText(image.name, MAX_ATTACHMENT_NAME_CHARS),
    mimeType: sanitizeDisplayText(image.mimeType, MAX_ATTACHMENT_MIME_CHARS),
    size:
      typeof image.size === 'number' && Number.isFinite(image.size) && image.size >= 0
        ? image.size
        : 0,
  };
}

export function createWebviewSnapshot(
  state: ControllerState,
  sequence: number,
  extra: Pick<WebviewSnapshot, 'pendingImages' | 'isTrusted' | 'folders'>
): WebviewSnapshot {
  return {
    sequence,
    title: state.title,
    connectionState: state.connectionState,
    workspaceFolderName: state.workspaceFolderName,
    sessionName: typeof state.state.sessionName === 'string' ? state.state.sessionName : undefined,
    sessionId: typeof state.state.sessionId === 'string' ? state.state.sessionId : undefined,
    sessionFile: typeof state.state.sessionFile === 'string' ? state.state.sessionFile : undefined,
    isStreaming: state.state.isStreaming === true,
    isCompacting: state.state.isCompacting === true,
    messageCount:
      typeof state.state.messageCount === 'number' ? state.state.messageCount : undefined,
    pendingMessageCount:
      typeof state.state.pendingMessageCount === 'number'
        ? state.state.pendingMessageCount
        : undefined,
    messages: state.messages
      .slice(-MAX_MESSAGES)
      .map((message, index) => toItem(message, index, state.cwd)),
    queue: state.queue,
    draft: state.draft,
    statuses: state.statuses,
    widgets: state.widgets,
    model: state.state.model,
    thinkingLevel:
      typeof state.state.thinkingLevel === 'string' ? state.state.thinkingLevel : undefined,
    pendingImages: extra.pendingImages.map(normalizePendingImage),
    isTrusted: extra.isTrusted,
    folders: extra.folders,
  };
}
