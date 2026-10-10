import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { redactText } from '../diagnostics/redaction';
import type { JsonObject, JsonValue } from '../rpc/protocol';
import type {
  ControllerState,
  WebviewAttachmentFileRef,
  WebviewAttachmentItem,
  WebviewAttachmentPreviewItem,
  WebviewCapturedContextItem,
  WebviewMessageBlock,
  WebviewMessageItem,
  WebviewPendingImageItem,
  WebviewSnapshot,
} from '../state/types';
import type { ComposerSessionState, PendingImageItem } from './composer';
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
const CONTEXT_OPEN = '<pi-vscode-context-v1>\n';
const CONTEXT_CLOSE = '\n</pi-vscode-context-v1>';
const CONTEXT_MAX_CHARS = 32000;
const PREVIEW_IMAGE_MIME = /^image\/(?:png|jpeg|gif|webp|bmp)$/i;
const BASE64_IMAGE_DATA = /^[A-Za-z0-9+/]+={0,2}$/;
const CONTEXT_KINDS = new Set([
  'activeFile',
  'pickedFile',
  'selection',
  'diagnostics',
  'pastedText',
  'droppedFile',
]);

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

function imageDataUrl(data: unknown, mimeType: string): string | undefined {
  return typeof data === 'string' &&
    data.length > 0 &&
    PREVIEW_IMAGE_MIME.test(mimeType) &&
    BASE64_IMAGE_DATA.test(data)
    ? `data:${mimeType.toLowerCase()};base64,${data}`
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

export function parseCapturedContextEnvelope(
  value: string,
  cwd: string
): { displayText: string; items: WebviewCapturedContextItem[] } | undefined {
  const start = value.lastIndexOf(CONTEXT_OPEN);
  const closeStart = value.indexOf(CONTEXT_CLOSE, start + CONTEXT_OPEN.length);
  if (start < 0 || closeStart < 0) {
    return undefined;
  }
  const separator = start === 0 ? '' : '\n\n';
  if (start > 0 && value.slice(start - separator.length, start) !== separator) {
    return undefined;
  }
  const envelopeEnd = closeStart + CONTEXT_CLOSE.length;
  const trailing = value.slice(envelopeEnd);
  if (trailing && !trailing.startsWith('\n\n')) {
    return undefined;
  }
  const envelope = value.slice(start, envelopeEnd);
  if (envelope.length > CONTEXT_MAX_CHARS) {
    return undefined;
  }
  const body = envelope.slice(CONTEXT_OPEN.length, -CONTEXT_CLOSE.length);
  const lines = body.split('\n');
  if (lines.length === 0 || lines.some((line) => !line)) {
    return undefined;
  }
  const items: WebviewCapturedContextItem[] = [];
  for (const line of lines) {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      return undefined;
    }
    const item = asObject(raw);
    const kind = typeof item?.kind === 'string' ? item.kind : '';
    const path = typeof item?.workspaceRelativePath === 'string' ? item.workspaceRelativePath : '';
    const lineStart = item?.lineStart;
    const lineEnd = item?.lineEnd;
    const content = item?.content;
    if (
      !CONTEXT_KINDS.has(kind) ||
      !path ||
      path.length > MAX_ATTACHMENT_NAME_CHARS ||
      !Number.isInteger(lineStart) ||
      !Number.isInteger(lineEnd) ||
      (lineStart as number) < 1 ||
      (lineEnd as number) < (lineStart as number) ||
      typeof content !== 'string'
    ) {
      return undefined;
    }
    const diagnostics = kind === 'diagnostics';
    const languageId = diagnostics ? undefined : item?.languageId;
    const severity = diagnostics ? item?.severity : undefined;
    if (
      (!diagnostics && typeof languageId !== 'string') ||
      (diagnostics && typeof severity !== 'string')
    ) {
      return undefined;
    }
    const mayOpen = kind !== 'pastedText' && kind !== 'droppedFile';
    items.push({
      kind: kind as WebviewCapturedContextItem['kind'],
      path,
      lineStart: lineStart as number,
      lineEnd: lineEnd as number,
      languageId: typeof languageId === 'string' ? languageId : undefined,
      severity: typeof severity === 'string' ? severity : undefined,
      content,
      fileRef: mayOpen ? maybeWorkspaceFileRef(path, cwd) : undefined,
    });
  }
  const before = start === 0 ? '' : value.slice(0, start - separator.length);
  const after = trailing ? trailing.slice(2) : '';
  return {
    displayText: [before, after].filter(Boolean).join('\n\n'),
    items,
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
        callId: typeof typed.id === 'string' ? typed.id : undefined,
      });
    } else if (typed.type === 'toolResult') {
      blocks.push({
        kind: 'toolResult',
        name: typeof typed.name === 'string' ? typed.name : undefined,
        text: typeof typed.content === 'string' ? typed.content : messageText(raw as JsonObject),
        isError: typed.isError === true,
        callId: typeof typed.toolCallId === 'string' ? typed.toolCallId : undefined,
      });
    } else if (typed.type === 'image') {
      const mimeType = typeof typed.mimeType === 'string' ? typed.mimeType : 'image';
      const dataUrl = imageDataUrl(typed.data, mimeType);
      blocks.push({ kind: 'image', mimeType, ...(dataUrl ? { dataUrl } : {}) });
    }
  }
  return blocks;
}

// Tool RESULTS stream in as separate messages, which rendered as disconnected
// cards. Fold each result INTO the assistant message that made the call (matched
// by toolCallId, else the nearest previous assistant with tool calls), inserted
// right after its call block — the renderer then fuses call+result into one
// card. Results with no owning call stay standalone.
function foldToolResults(
  items: WebviewMessageItem[],
  raws: readonly JsonObject[]
): WebviewMessageItem[] {
  const out: WebviewMessageItem[] = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]!;
    const raw = raws[index];
    const role = item.role;
    const isResultRole =
      role === 'toolResult' ||
      role === 'tool' ||
      role === 'tool_result' ||
      role === 'bashExecution';
    if (!isResultRole) {
      out.push(item);
      continue;
    }
    const callId = typeof raw?.toolCallId === 'string' ? raw.toolCallId : undefined;
    // Find the owning assistant: prefer exact callId match, else nearest
    // previous assistant that has any tool-call block.
    let targetIndex = -1;
    for (let back = out.length - 1; back >= 0; back -= 1) {
      const candidate = out[back]!;
      if (candidate.role !== 'assistant' || !candidate.blocks) {
        continue;
      }
      const hasMatch = callId
        ? candidate.blocks.some((block) => block.kind === 'tool' && block.callId === callId)
        : candidate.blocks.some((block) => block.kind === 'tool');
      if (hasMatch) {
        targetIndex = back;
        break;
      }
      if (candidate.role === 'assistant') {
        break; // don't skip past an unrelated assistant turn
      }
    }
    if (targetIndex < 0) {
      out.push(item); // no owner — keep it standalone
      continue;
    }
    const target = out[targetIndex]!;
    const resultBlock: WebviewMessageBlock = {
      kind: 'toolResult',
      name: item.blocks?.find((block) => block.kind === 'toolResult')?.name,
      text: item.text,
      isError:
        raw?.isError === true ||
        item.blocks?.some((block) => block.kind === 'toolResult' && block.isError === true) ===
          true,
      callId,
    };
    const blocks = [...(target.blocks ?? [])];
    let insertAt = blocks.length;
    if (callId) {
      const callIndex = blocks.findIndex(
        (block) => block.kind === 'tool' && block.callId === callId
      );
      if (callIndex >= 0) {
        insertAt = callIndex + 1;
      }
    }
    blocks.splice(insertAt, 0, resultBlock);
    out[targetIndex] = { ...target, blocks };
  }
  return out;
}

function toItem(message: JsonObject, index: number, cwd: string): WebviewMessageItem {
  const blocks = toBlocks(message);
  let capturedContext: WebviewCapturedContextItem[] | undefined;
  if (message.role === 'user') {
    for (let blockIndex = blocks.length - 1; blockIndex >= 0; blockIndex -= 1) {
      const block = blocks[blockIndex];
      if (block?.kind !== 'text') continue;
      const parsed = parseCapturedContextEnvelope(block.text, cwd);
      if (!parsed) break;
      capturedContext = parsed.items;
      if (parsed.displayText) {
        blocks[blockIndex] = { kind: 'text', text: parsed.displayText };
      } else {
        blocks.splice(blockIndex, 1);
      }
      break;
    }
  }
  return {
    id: typeof message.id === 'string' ? message.id : `m${index}`,
    role: typeof message.role === 'string' ? message.role : 'unknown',
    text: messageText(message),
    blocks,
    attachments: normalizeAttachments(message.attachments, cwd),
    capturedContext,
    errorMessage:
      typeof message.errorMessage === 'string' && message.errorMessage.trim()
        ? sanitizeDisplayText(message.errorMessage, 600)
        : undefined,
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
    composer: ComposerSessionState;
    isTrusted: boolean;
    folders: WebviewSnapshot['folders'];
    // How many trailing messages to include. Grows as the webview requests
    // older batches. Defaults to DEFAULT_MESSAGE_WINDOW.
    messageLimit?: number;
    presentation?: {
      workingAnimation: string;
      chatFontFamily: string;
      chatFontSize: number;
      typewriterSpeed: string;
    };
    attachmentLimits?: WebviewSnapshot['attachmentLimits'];
  }
): WebviewSnapshot {
  const totalMessages = state.messages.length;
  const limit =
    typeof extra.messageLimit === 'number' && extra.messageLimit > 0
      ? extra.messageLimit
      : DEFAULT_MESSAGE_WINDOW;
  const windowOffset = Math.max(0, totalMessages - limit);
  const foldedMessages = foldToolResults(
    state.messages
      .slice(windowOffset)
      .map((message, index) => toItem(message, windowOffset + index, state.cwd)),
    state.messages.slice(windowOffset)
  );
  return {
    sequence,
    title: state.title,
    connectionState: state.connectionState,
    catalogGeneration: state.generation,
    switchingSession: state.switchingSession === true,
    workspaceFolderName: state.workspaceFolderName,
    sessionName: typeof state.state.sessionName === 'string' ? state.state.sessionName : undefined,
    sessionId: typeof state.state.sessionId === 'string' ? state.state.sessionId : undefined,
    sessionFile: typeof state.state.sessionFile === 'string' ? state.state.sessionFile : undefined,
    currentAssistantMessageId:
      state.currentAssistant &&
      state.currentAssistant.generation === state.generation &&
      state.currentAssistant.sessionFile === state.state.sessionFile &&
      !state.switchingSession &&
      state.messages.includes(state.currentAssistant.message)
        ? toItem(
            state.currentAssistant.message,
            state.messages.indexOf(state.currentAssistant.message),
            state.cwd
          ).id
        : undefined,
    isStreaming: state.state.isStreaming === true,
    isCompacting: state.state.isCompacting === true,
    compaction:
      state.state.isCompacting === true
        ? {
            progress: 'indeterminate',
            reason: state.compactionReason
              ? sanitizeDisplayText(state.compactionReason, 80)
              : undefined,
          }
        : undefined,
    messageCount:
      typeof state.state.messageCount === 'number' ? state.state.messageCount : undefined,
    pendingMessageCount:
      typeof state.state.pendingMessageCount === 'number'
        ? state.state.pendingMessageCount
        : undefined,
    messages: foldedMessages,
    messageWindow: {
      total: totalMessages,
      offset: windowOffset,
      hasOlder: windowOffset > 0,
    },
    queue: state.queue,
    draft: extra.composer.draft,
    localCommandAck: extra.composer.localCommandAck,
    localCommandReplacement: extra.composer.localCommandReplacement,
    localCommandConsumed: extra.composer.localCommandConsumed,
    composerResetSeq: extra.composer.composerResetSeq ?? 0,
    retry: state.retry
      ? {
          attempt: state.retry.attempt,
          errorMessage: state.retry.errorMessage
            ? sanitizeDisplayText(state.retry.errorMessage, 300)
            : undefined,
        }
      : undefined,
    statuses: state.statuses,
    widgets: state.widgets,
    model: state.state.model,
    thinkingLevel:
      typeof state.state.thinkingLevel === 'string' ? state.state.thinkingLevel : undefined,
    availableThinkingLevels: state.state.availableThinkingLevels,
    runtime: {
      sdkVersion: typeof state.state.sdkVersion === 'string' ? state.state.sdkVersion : undefined,
      commands: state.commands.length,
      extensions: state.commands.filter((command) => command.source === 'extension').length,
      prompts: state.commands.filter((command) => command.source === 'prompt').length,
      skills: state.commands.filter((command) => command.source === 'skill').length,
    },
    plan: derivePlan(foldedMessages),
    usage: summarizeUsage(state.lastSessionStats),
    approvals: state.pendingUi
      .filter(
        (request) =>
          request.method === 'select' || request.method === 'confirm' || request.method === 'editor'
      )
      .map((request) => ({
        id: request.id,
        method: request.method as 'select' | 'confirm' | 'editor',
        title: request.title,
        message: request.message,
        options: request.options,
        placeholder: request.placeholder,
        prefill: request.prefill,
      })),
    pendingContextItems: extra.composer.pendingContextItems,
    pendingImages: extra.composer.pendingImages.map(normalizePendingImage),
    attachmentLimits: extra.attachmentLimits,
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
    typewriterSpeed: extra.presentation?.typewriterSpeed,
  };
}

/** Newest assistant markdown task list → plan strip ("- [ ] step" lines). */
function derivePlan(
  messages: Array<{ role: string; blocks?: WebviewMessageBlock[] }>
): { items: Array<{ text: string; done: boolean }>; done: number } | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role !== 'assistant') {
      continue;
    }
    const text = (message.blocks ?? [])
      .filter((block) => block.kind === 'text')
      .map((block) => ('text' in block ? (block.text ?? '') : ''))
      .join('\n');
    const matches = Array.from(text.matchAll(/^[-*] \[([ xX])\] +(.+)$/gm));
    if (matches.length >= 2) {
      const items = matches.slice(0, 12).map((match) => ({
        text: match[2]!.trim().slice(0, 120),
        done: match[1] !== ' ',
      }));
      return { items, done: items.filter((item) => item.done).length };
    }
  }
  return undefined;
}
