import type {
  ExtensionUiRequest,
  JsonObject,
  ModelInfo,
  QueueState,
  SessionState,
} from '../rpc/protocol';
import type {
  AcceptedSendSnapshot,
  ChatUiMode,
  ComposerFocusTarget,
  PendingContextItem,
  RecoveryState,
  SendPreviewState,
} from '../webview/composer';

export interface DiagnosticItem {
  id: string;
  kind: 'info' | 'warning' | 'error';
  message: string;
  detail?: string;
  timestamp: number;
}

export interface ToolRunState {
  id: string;
  name: string;
  args?: JsonObject;
  result?: JsonObject;
  partialResult?: JsonObject;
  isError?: boolean;
  startedAt: number;
  endedAt?: number;
}

export interface WidgetState {
  key: string;
  lines: string[];
  placement: 'aboveEditor' | 'belowEditor';
}

export interface EventRecord {
  id: string;
  type: string;
  timestamp: number;
  data: JsonObject;
}

export interface ExtensionUiRecord {
  id: string;
  method: ExtensionUiRequest['method'];
  timestamp: number;
  data: ExtensionUiRequest;
}

export interface ControllerState {
  generation: number;
  connectionState:
    | 'unconfigured'
    | 'locating'
    | 'versionChecking'
    | 'starting'
    | 'handshaking'
    | 'ready'
    | 'busy'
    | 'faulted'
    | 'stopped'
    | 'unsupported';
  workspaceFolderName: string;
  cwd: string;
  state: SessionState;
  messages: JsonObject[];
  entries: JsonObject[];
  tree: JsonObject[];
  commands: JsonObject[];
  queue: QueueState;
  tools: ToolRunState[];
  diagnostics: DiagnosticItem[];
  stderrTail: string[];
  statuses: Record<string, string>;
  widgets: WidgetState[];
  title: string;
  draft: string;
  pendingUi: ExtensionUiRequest[];
  uiHistory: ExtensionUiRecord[];
  eventHistory: EventRecord[];
  lastEventType?: string;
  lastSessionStats?: JsonObject;
  lastExportPath?: string;
  leafId?: string | null;
  restartCount: number;
}

export function createInitialControllerState(
  workspaceFolderName: string,
  cwd: string
): ControllerState {
  return {
    generation: 0,
    connectionState: 'stopped',
    workspaceFolderName,
    cwd,
    state: {},
    messages: [],
    entries: [],
    tree: [],
    commands: [],
    queue: { steering: [], followUp: [] },
    tools: [],
    diagnostics: [
      {
        id: 'xui-capability',
        kind: 'info',
        message:
          'Pi local-only RPC compatibility APIs such as custom UI, themes, and editor components remain disabled/no-op in VS Code by design.',
        timestamp: Date.now(),
      },
    ],
    stderrTail: [],
    statuses: {},
    widgets: [],
    title: 'Pi',
    draft: '',
    pendingUi: [],
    uiHistory: [],
    eventHistory: [],
    restartCount: 0,
  };
}

export interface WebviewAttachmentPreviewItem {
  key: string;
  value: string;
}

export interface WebviewAttachmentFileRef {
  uri: string;
  path: string;
}

export interface WebviewAttachmentItem {
  id?: string;
  type: string;
  name?: string;
  mimeType?: string;
  size?: number;
  hasContent: boolean;
  extractedText?: string;
  previewItems: WebviewAttachmentPreviewItem[];
  fileRef?: WebviewAttachmentFileRef;
}

export type WebviewMessageBlock =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool'; name: string; args?: string }
  | { kind: 'toolResult'; name?: string; text: string; isError?: boolean }
  | { kind: 'image'; mimeType: string };

export interface WebviewMessageItem {
  id: string;
  role: string;
  // Flattened plain text (used for previews/search and as a fallback).
  text: string;
  // Structured content so the webview can render thinking, tool calls, tool
  // results, images, and fenced code distinctly. Optional for backward-compat
  // with persisted snapshots; the webview falls back to `text`.
  blocks?: WebviewMessageBlock[];
  attachments: WebviewAttachmentItem[];
}

export interface WebviewPendingImageItem {
  itemId: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  width?: number;
  height?: number;
  previewDataUrl?: string;
  requiresReselect?: boolean;
}

export interface WebviewSnapshot {
  sequence: number;
  title: string;
  bindingState?: 'current' | 'cached' | 'draft';
  uiMode: ChatUiMode;
  connectionState: ControllerState['connectionState'];
  workspaceFolderName: string;
  sessionName?: string;
  sessionId?: string;
  sessionFile?: string;
  isStreaming: boolean;
  isCompacting: boolean;
  messageCount?: number;
  pendingMessageCount?: number;
  messages: WebviewMessageItem[];
  // Windowing: `messages` is the trailing slice of the full transcript.
  // total = full message count, offset = index of the first sent message,
  // hasOlder = there are older messages not yet loaded into the webview.
  messageWindow?: { total: number; offset: number; hasOlder: boolean };
  queue: QueueState;
  draft: string;
  // Bumped whenever the extension authoritatively replaces the composer text
  // (send-clear, copy-to-composer, restore). The webview uses a change in this
  // value to overwrite the textarea; otherwise it preserves the live text and
  // caret while the user types.
  composerResetSeq?: number;
  statuses: Record<string, string>;
  widgets: WidgetState[];
  model?: ModelInfo | null;
  thinkingLevel?: string;
  // Compact usage summary for the header (tokens / context% / cost).
  usage?: { totalTokens: number; contextPercent?: number; cost?: number };
  pendingContextItems: PendingContextItem[];
  pendingImages: WebviewPendingImageItem[];
  focus: ComposerFocusTarget;
  preview?: SendPreviewState;
  acceptedSendSnapshot?: AcceptedSendSnapshot;
  recovery?: RecoveryState;
  isTrusted: boolean;
  folders: Array<{ name: string; uri: string; active: boolean }>;
  // Presentation settings (from config).
  workingAnimation?: string;
  chatFontFamily?: string;
  chatFontSize?: number;
  typewriterSpeed?: string;
}
