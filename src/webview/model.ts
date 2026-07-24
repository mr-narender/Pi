import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { redactText } from '../diagnostics/redaction';
import type { JsonObject, JsonValue } from '../rpc/protocol';
import type {
  ControllerState,
  WebviewAttachmentFileRef,
  WebviewAttachmentItem,
  WebviewAttachmentPreviewItem,
  WebviewMessageBlock,
  WebviewMessageItem,
  WebviewPendingImageItem,
  WebviewSnapshot,
} from '../state/types';
import type { ChatUiMode, ComposerSessionState, PendingImageItem } from './composer';
import { summarizeUsage } from './usageSummary';

// Default number of trailing messages sent to the webview. The webview lazily
// requests older batches on scroll-up, so we never eagerly ship a huge chat.
export const DEFAULT_MESSAGE_WINDOW = 50;

/**
 * First-user-prompt preview for a transcript, used as the chat/tab title for
 * unnamed history sessions. Returns the first line of the first user message,
 * truncated. Works on the FULL transcript (not the webview window).
 */
export function firstPromptPreview(
  messages: readonly JsonObject[],
  maxChars = 48
): string | undefined {
  const first = messages.find((message) => message?.role === 'user');
  if (!first) {
    return undefined;
  }
  const firstLine = messageText(first)
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) {
    return undefined;
  }
  return firstLine.length > maxChars
    ? `${firstLine.slice(0, maxChars - 1).trimEnd()}\u2026`
    : firstLine;
}
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

function toBlocks(message: JsonObject): WebviewMessageBlock[] {
  const content = message.content;
  if (typeof content === 'string') {
    return content.trim().length > 0 ? [{ kind: 'text', text: content }] : [];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  const blocks: WebviewMessageBlock[] = [];
  for (const raw of content) {
    if (!raw || typeof raw !== 'object') {
      continue;
    }
    const typed = raw as Record<string, unknown>;
    if (typed.type === 'text' && typeof typed.text === 'string') {
      blocks.push({ kind: 'text', text: typed.text });
    } else if (typed.type === 'thinking' && typeof typed.thinking === 'string') {
      blocks.push({ kind: 'thinking', text: typed.thinking });
    } else if (typed.type === 'toolCall') {
      blocks.push({
        kind: 'tool',
        name: String(typed.name ?? 'tool'),
        args:
          typed.arguments !== undefined && typed.arguments !== null
            ? JSON.stringify(typed.arguments, null, 2)
            : undefined,
      });
    } else if (typed.type === 'toolResult') {
      blocks.push({
        kind: 'toolResult',
        name: typeof typed.name === 'string' ? typed.name : undefined,
        text: typeof typed.content === 'string' ? typed.content : messageText(raw as JsonObject),
        isError: typed.isError === true,
      });
    } else if (typed.type === 'image') {
      blocks.push({ kind: 'image', mimeType: String(typed.mimeType ?? 'image') });
    }
  }
  return blocks;
}

function toItem(message: JsonObject, index: number, cwd: string): WebviewMessageItem {
  return {
    id: typeof message.id === 'string' ? message.id : `m${index}`,
    role: typeof message.role === 'string' ? message.role : 'unknown',
    text: messageText(message),
    blocks: toBlocks(message),
    attachments: normalizeAttachments(message.attachments, cwd),
  };
}

function normalizePendingImage(image: PendingImageItem): WebviewPendingImageItem {
  return {
    itemId: sanitizeDisplayText(image.itemId, 80),
    name: sanitizeDisplayText(image.name, MAX_ATTACHMENT_NAME_CHARS),
    mimeType: sanitizeDisplayText(image.mimeType, MAX_ATTACHMENT_MIME_CHARS),
    sizeBytes:
      typeof image.sizeBytes === 'number' &&
      Number.isFinite(image.sizeBytes) &&
      image.sizeBytes >= 0
        ? image.sizeBytes
        : 0,
    width: typeof image.width === 'number' ? image.width : undefined,
    height: typeof image.height === 'number' ? image.height : undefined,
    previewDataUrl: image.previewDataUrl,
    requiresReselect: image.requiresReselect,
  };
}

export function createWebviewSnapshot(
  state: ControllerState,
  sequence: number,
  extra: {
    uiMode: ChatUiMode;
    composer: ComposerSessionState;
    isTrusted: boolean;
    folders: WebviewSnapshot['folders'];
    // How many trailing messages to include. Grows as the webview requests
    // older batches. Defaults to DEFAULT_MESSAGE_WINDOW.
    messageLimit?: number;
    presentation?: { workingAnimation: string; chatFontFamily: string; chatFontSize: number };
  }
): WebviewSnapshot {
  const totalMessages = state.messages.length;
  const limit =
    typeof extra.messageLimit === 'number' && extra.messageLimit > 0
      ? extra.messageLimit
      : DEFAULT_MESSAGE_WINDOW;
  const windowOffset = Math.max(0, totalMessages - limit);
  return {
    sequence,
    title: state.title,
    uiMode: extra.uiMode,
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
      .slice(windowOffset)
      .map((message, index) => toItem(message, windowOffset + index, state.cwd)),
    messageWindow: {
      total: totalMessages,
      offset: windowOffset,
      hasOlder: windowOffset > 0,
    },
    queue: state.queue,
    draft: extra.composer.draft,
    composerResetSeq: extra.composer.composerResetSeq ?? 0,
    statuses: state.statuses,
    widgets: state.widgets,
    model: state.state.model,
    thinkingLevel:
      typeof state.state.thinkingLevel === 'string' ? state.state.thinkingLevel : undefined,
    usage: summarizeUsage(state.lastSessionStats),
    pendingContextItems: extra.composer.pendingContextItems,
    pendingImages: extra.composer.pendingImages.map(normalizePendingImage),
    focus: extra.composer.focus,
    preview: extra.composer.preview,
    acceptedSendSnapshot: extra.composer.acceptedSendSnapshot,
    recovery: extra.composer.recovery,
    isTrusted: extra.isTrusted,
    folders: extra.folders,
    workingAnimation: extra.presentation?.workingAnimation,
    chatFontFamily: extra.presentation?.chatFontFamily || undefined,
    chatFontSize:
      extra.presentation?.chatFontSize && extra.presentation.chatFontSize > 0
        ? extra.presentation.chatFontSize
        : undefined,
  };
}
