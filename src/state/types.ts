import type {
  ExtensionUiRequest,
  JsonObject,
  ModelInfo,
  QueueState,
  SessionState,
} from '../rpc/protocol';

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
    title: 'Pi RPC',
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

export interface WebviewMessageItem {
  id: string;
  role: string;
  text: string;
  attachments: WebviewAttachmentItem[];
}

export interface WebviewSnapshot {
  sequence: number;
  title: string;
  connectionState: ControllerState['connectionState'];
  workspaceFolderName: string;
  messages: WebviewMessageItem[];
  queue: QueueState;
  draft: string;
  statuses: Record<string, string>;
  widgets: WidgetState[];
  model?: ModelInfo | null;
  thinkingLevel?: string;
  pendingImages: Array<{ name: string; mimeType: string; size: number }>;
  isTrusted: boolean;
  folders: Array<{ name: string; uri: string; active: boolean }>;
}
