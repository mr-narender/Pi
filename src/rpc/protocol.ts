export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue | undefined;
}

export const COMMAND_TYPES = [
  'prompt',
  'steer',
  'follow_up',
  'abort',
  'new_session',
  'get_state',
  'get_messages',
  'set_model',
  'cycle_model',
  'get_available_models',
  'set_thinking_level',
  'cycle_thinking_level',
  'set_steering_mode',
  'set_follow_up_mode',
  'compact',
  'set_auto_compaction',
  'set_auto_retry',
  'abort_retry',
  'bash',
  'abort_bash',
  'get_session_stats',
  'export_html',
  'switch_session',
  'fork',
  'clone',
  'get_fork_messages',
  'get_entries',
  'get_tree',
  'get_last_assistant_text',
  'set_session_name',
  'get_commands',
  'extension_ui_response',
] as const;

export type RpcCommandType = (typeof COMMAND_TYPES)[number];

export const EVENT_TYPES = [
  'agent_start',
  'agent_end',
  'agent_settled',
  'turn_start',
  'turn_end',
  'message_start',
  'message_update',
  'message_end',
  'tool_execution_start',
  'tool_execution_update',
  'tool_execution_end',
  'queue_update',
  'compaction_start',
  'compaction_end',
  'auto_retry_start',
  'auto_retry_end',
  'extension_error',
  'entry_appended',
  'session_info_changed',
  'thinking_level_changed',
] as const;

export type RpcEventType = (typeof EVENT_TYPES)[number];

export interface RpcResponseSuccess<T = JsonValue | undefined> {
  type: 'response';
  id?: string;
  command: string;
  success: true;
  data?: T;
}

export interface RpcResponseFailure {
  type: 'response';
  id?: string;
  command: string;
  success: false;
  error: string;
}

export type RpcResponse = RpcResponseSuccess | RpcResponseFailure;

export interface ExtensionUiRequest extends JsonObject {
  type: 'extension_ui_request';
  id: string;
  method:
    | 'select'
    | 'confirm'
    | 'input'
    | 'editor'
    | 'notify'
    | 'setStatus'
    | 'setWidget'
    | 'setTitle'
    | 'set_editor_text';
  title?: string;
  options?: string[];
  message?: string;
  placeholder?: string;
  prefill?: string;
  notifyType?: 'info' | 'warning' | 'error';
  statusKey?: string;
  statusText?: string;
  widgetKey?: string;
  widgetLines?: string[];
  widgetPlacement?: 'aboveEditor' | 'belowEditor';
  text?: string;
  timeout?: number;
}

export interface RpcEvent extends JsonObject {
  type: string;
  compatibility?: true;
}

export interface RpcCommand extends JsonObject {
  type: RpcCommandType | string;
  id?: string;
}

export interface ModelInfo extends JsonObject {
  id: string;
  name?: string;
  api?: string;
  provider?: string;
  baseUrl?: string;
  reasoning?: boolean;
  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
  cost?: JsonObject;
}

export interface SessionState extends JsonObject {
  model?: ModelInfo | null;
  thinkingLevel?: string;
  isStreaming?: boolean;
  isCompacting?: boolean;
  steeringMode?: string;
  followUpMode?: string;
  sessionFile?: string;
  sessionId?: string;
  sessionName?: string;
  autoCompactionEnabled?: boolean;
  messageCount?: number;
  pendingMessageCount?: number;
}

export interface QueueState {
  steering: string[];
  followUp: string[];
}

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) {
    return true;
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every((item) => isJsonValue(item));
  }
  return isJsonObject(value)
    ? Object.values(value).every((item) => item === undefined || isJsonValue(item))
    : false;
}

export function asRecord(value: unknown, label = 'value'): JsonObject {
  if (!isJsonObject(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

export function asString(value: unknown, label = 'value'): string {
  if (typeof value !== 'string') {
    throw new Error(`${label} must be a string`);
  }
  return value;
}

export function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function asStringArray(value: unknown, label = 'value'): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${label} must be a string array`);
  }
  return value;
}

export function isKnownEventType(type: string): type is RpcEventType {
  return EVENT_TYPES.includes(type as RpcEventType);
}

export function parseEnvelope(value: unknown): RpcResponse | ExtensionUiRequest | RpcEvent {
  const record = asRecord(value, 'rpc envelope');
  const type = asString(record.type, 'rpc envelope.type');
  if (type === 'response') {
    if (record.success === true) {
      if ('data' in record && record.data !== undefined && !isJsonValue(record.data)) {
        throw new Error('response.data must be valid JSON');
      }
      return {
        type: 'response',
        id: asOptionalString(record.id),
        command: asString(record.command, 'response.command'),
        success: true,
        data: 'data' in record ? (record.data as JsonValue | undefined) : undefined,
      };
    }
    return {
      type: 'response',
      id: asOptionalString(record.id),
      command: asString(record.command, 'response.command'),
      success: false,
      error: asString(record.error, 'response.error'),
    };
  }
  if (type === 'extension_ui_request') {
    const method = asString(
      record.method,
      'extension_ui_request.method'
    ) as ExtensionUiRequest['method'];
    return {
      type: 'extension_ui_request',
      id: asString(record.id, 'extension_ui_request.id'),
      method,
      title: asOptionalString(record.title),
      options: Array.isArray(record.options)
        ? asStringArray(record.options, 'extension_ui_request.options')
        : undefined,
      message: asOptionalString(record.message),
      placeholder: asOptionalString(record.placeholder),
      prefill: asOptionalString(record.prefill),
      notifyType:
        record.notifyType === 'warning' || record.notifyType === 'error'
          ? record.notifyType
          : 'info',
      statusKey: asOptionalString(record.statusKey),
      statusText: asOptionalString(record.statusText),
      widgetKey: asOptionalString(record.widgetKey),
      widgetLines: Array.isArray(record.widgetLines)
        ? asStringArray(record.widgetLines, 'extension_ui_request.widgetLines')
        : undefined,
      widgetPlacement: record.widgetPlacement === 'belowEditor' ? 'belowEditor' : 'aboveEditor',
      text: asOptionalString(record.text),
      timeout: typeof record.timeout === 'number' ? record.timeout : undefined,
    };
  }
  if (isKnownEventType(type)) {
    return record as RpcEvent;
  }
  return { ...record, type, compatibility: true } as RpcEvent;
}
