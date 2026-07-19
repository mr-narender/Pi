import type {
  ExtensionUiRequest,
  JsonObject,
  JsonValue,
  RpcEvent,
  SessionState,
} from '../rpc/protocol';
import type {
  ControllerState,
  DiagnosticItem,
  EventRecord,
  ExtensionUiRecord,
  ToolRunState,
} from './types';

function pushDiagnostic(state: ControllerState, diagnostic: DiagnosticItem): ControllerState {
  return {
    ...state,
    diagnostics: [...state.diagnostics.slice(-99), diagnostic],
  };
}

function pushEvent(state: ControllerState, event: RpcEvent): ControllerState {
  const record: EventRecord = {
    id: `${String(event.type)}-${Date.now()}-${state.eventHistory.length + 1}`,
    type: String(event.type),
    timestamp: Date.now(),
    data: event,
  };
  return {
    ...state,
    eventHistory: [...state.eventHistory.slice(-199), record],
  };
}

function pushUiHistory(state: ControllerState, request: ExtensionUiRequest): ControllerState {
  const record: ExtensionUiRecord = {
    id: request.id,
    method: request.method,
    timestamp: Date.now(),
    data: request,
  };
  return {
    ...state,
    uiHistory: [...state.uiHistory.slice(-99), record],
  };
}

function asObject(value: unknown): JsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function shallowMerge(
  base: JsonObject | undefined,
  incoming: JsonObject | undefined
): JsonObject | undefined {
  if (!base) {
    return incoming;
  }
  if (!incoming) {
    return base;
  }
  return { ...base, ...incoming };
}

// Pi RPC messages do not carry a stable `id`. Session ids live on entries, not
// on the message objects streamed through events. To dedupe the streaming
// message lifecycle (message_start -> many message_update -> message_end, plus
// turn_end / agent_end that re-send the same message) we derive a stable key
// from `id` when present, otherwise from role + timestamp (the timestamp is
// assigned once when the message is created and stays constant while it
// streams). For tool results we also fold in toolCallId.
function messageKey(message: JsonObject | undefined): string | undefined {
  if (!message) {
    return undefined;
  }
  if (typeof message.id === 'string' && message.id) {
    return message.id;
  }
  const role = typeof message.role === 'string' ? message.role : 'unknown';
  const timestamp =
    typeof message.timestamp === 'number' || typeof message.timestamp === 'string'
      ? String(message.timestamp)
      : undefined;
  const toolCallId = typeof message.toolCallId === 'string' ? message.toolCallId : undefined;
  if (timestamp === undefined && toolCallId === undefined) {
    return undefined;
  }
  return `${role}:${toolCallId ?? ''}:${timestamp ?? ''}`;
}

function messageIndex(messages: JsonObject[], key: string | undefined): number {
  return key ? messages.findIndex((message) => messageKey(message) === key) : -1;
}

function messageAt(messages: JsonObject[], key: string | undefined): JsonObject | undefined {
  const index = messageIndex(messages, key);
  return index === -1 ? undefined : asObject(messages[index]);
}

function upsertMessage(
  messages: JsonObject[],
  incoming: JsonObject | undefined,
  merge = false
): JsonObject[] {
  if (!incoming) {
    return messages;
  }
  const key = messageKey(incoming);
  const index = messageIndex(messages, key);
  if (index === -1) {
    return [...messages, incoming].slice(-400);
  }
  const next = [...messages];
  next[index] = merge ? { ...next[index], ...incoming } : incoming;
  return next;
}

function ensureContentBlock(
  content: JsonValue[] | undefined,
  index: number,
  block: JsonObject
): JsonValue[] {
  const next = Array.isArray(content) ? [...content] : [];
  while (next.length <= index) {
    next.push({ type: 'text', text: '' });
  }
  const current = asObject(next[index]);
  next[index] = current && current.type === block.type ? { ...current, ...block } : block;
  return next;
}

function appendBlockText(
  content: JsonValue[] | undefined,
  index: number,
  type: 'text' | 'thinking',
  delta: string,
  field: 'text' | 'thinking'
): JsonValue[] {
  const next = ensureContentBlock(content, index, { type });
  const current = asObject(next[index]) ?? { type, [field]: '' };
  const existing = typeof current[field] === 'string' ? current[field] : '';
  next[index] = { ...current, type, [field]: `${existing}${delta}` };
  return next;
}

function applyAssistantDelta(
  message: JsonObject | undefined,
  event: RpcEvent
): JsonObject | undefined {
  const base = message ? { ...message } : asObject(event.message);
  if (!base) {
    return base;
  }
  const delta = asObject(event.assistantMessageEvent);
  const partial = asObject(delta?.partial);
  let next = base;
  if (partial) {
    next = {
      ...base,
      ...partial,
      content:
        Array.isArray(partial.content) && partial.content.length > 0
          ? partial.content
          : base.content,
    };
  }
  const deltaType = typeof delta?.type === 'string' ? delta.type : undefined;
  const contentIndex = typeof delta?.contentIndex === 'number' ? delta.contentIndex : undefined;
  const content = Array.isArray(next.content) ? [...next.content] : [];

  switch (deltaType) {
    case 'start':
      next.content = content;
      return next;
    case 'text_start':
      if (contentIndex !== undefined) {
        next.content = ensureContentBlock(content, contentIndex, { type: 'text', text: '' });
      }
      return next;
    case 'text_delta':
      if (contentIndex !== undefined && typeof delta?.delta === 'string') {
        next.content = appendBlockText(content, contentIndex, 'text', delta.delta, 'text');
      }
      return next;
    case 'text_end':
      if (contentIndex !== undefined) {
        next.content = ensureContentBlock(content, contentIndex, {
          type: 'text',
          text: typeof delta?.content === 'string' ? delta.content : '',
        });
      }
      return next;
    case 'thinking_start':
      if (contentIndex !== undefined) {
        next.content = ensureContentBlock(content, contentIndex, {
          type: 'thinking',
          thinking: '',
        });
      }
      return next;
    case 'thinking_delta':
      if (contentIndex !== undefined && typeof delta?.delta === 'string') {
        next.content = appendBlockText(content, contentIndex, 'thinking', delta.delta, 'thinking');
      }
      return next;
    case 'thinking_end':
      if (contentIndex !== undefined) {
        next.content = ensureContentBlock(content, contentIndex, {
          type: 'thinking',
          thinking: typeof delta?.content === 'string' ? delta.content : '',
        });
      }
      return next;
    case 'toolcall_start':
      if (contentIndex !== undefined) {
        next.content = ensureContentBlock(content, contentIndex, {
          type: 'toolCall',
          id: typeof delta?.id === 'string' ? delta.id : undefined,
          name: typeof delta?.name === 'string' ? delta.name : undefined,
          arguments:
            typeof delta?.arguments === 'string' ? delta.arguments : asObject(delta?.arguments),
        });
      }
      return next;
    case 'toolcall_delta':
      if (contentIndex !== undefined && typeof delta?.delta === 'string') {
        const current = ensureContentBlock(content, contentIndex, {
          type: 'toolCall',
        });
        const block = asObject(current[contentIndex]) ?? { type: 'toolCall', arguments: '' };
        const existing =
          typeof block.arguments === 'string'
            ? block.arguments
            : JSON.stringify(block.arguments ?? {});
        current[contentIndex] = { ...block, arguments: `${existing}${delta.delta}` };
        next.content = current;
      }
      return next;
    case 'toolcall_end':
      if (contentIndex !== undefined) {
        next.content = ensureContentBlock(content, contentIndex, {
          ...(asObject(delta?.toolCall) ?? { type: 'toolCall' }),
        });
      }
      return next;
    case 'done':
      next.stopReason = typeof delta?.reason === 'string' ? delta.reason : undefined;
      return next;
    case 'error':
      next.stopReason = typeof delta?.reason === 'string' ? delta.reason : 'error';
      next.errorMessage = typeof delta?.errorMessage === 'string' ? delta.errorMessage : undefined;
      return next;
    default:
      return next;
  }
}

function replaceEntries(entries: JsonObject[], incoming: JsonObject[]): JsonObject[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  for (const entry of incoming) {
    byId.set(entry.id, entry);
  }
  return [...byId.values()].slice(-400);
}

function resetUi(
  _state: ControllerState
): Pick<ControllerState, 'queue' | 'tools' | 'pendingUi' | 'statuses' | 'widgets' | 'title'> {
  return {
    queue: { steering: [], followUp: [] },
    tools: [],
    pendingUi: [],
    statuses: {},
    widgets: [],
    title: 'Pi',
  };
}

export function reduceEvent(state: ControllerState, event: RpcEvent): ControllerState {
  const type = String(event.type);
  let next = pushEvent(state, event);
  switch (type) {
    case 'agent_start':
      next = {
        ...next,
        connectionState: 'busy',
        state: { ...next.state, isStreaming: true },
      };
      break;
    case 'agent_end':
      next = {
        ...next,
        connectionState: 'busy',
        state: {
          ...next.state,
          isStreaming: false,
        },
      };
      if (Array.isArray(event.messages)) {
        for (const message of event.messages
          .map(asObject)
          .filter((item): item is JsonObject => !!item)) {
          next = { ...next, messages: upsertMessage(next.messages, message) };
        }
      }
      break;
    case 'agent_settled':
      next = {
        ...next,
        connectionState: next.state.isCompacting ? 'busy' : 'ready',
        state: { ...next.state, isStreaming: false },
      };
      break;
    case 'turn_start':
      next = { ...next, connectionState: 'busy' };
      break;
    case 'turn_end': {
      next = { ...next, connectionState: 'busy' };
      const message = asObject(event.message);
      if (message) {
        next = { ...next, messages: upsertMessage(next.messages, message) };
      }
      const toolResults = Array.isArray(event.toolResults)
        ? event.toolResults.map(asObject).filter((item): item is JsonObject => !!item)
        : [];
      for (const toolResult of toolResults) {
        next = { ...next, messages: upsertMessage(next.messages, toolResult) };
      }
      break;
    }
    case 'message_start': {
      const message = asObject(event.message);
      next = { ...next, messages: upsertMessage(next.messages, message) };
      break;
    }
    case 'message_update': {
      const current = asObject(event.message);
      const stored = messageAt(next.messages, messageKey(current));
      const mergedSnapshot = stored
        ? {
            ...stored,
            ...current,
            content:
              Array.isArray(current?.content) && current.content.length > 0
                ? current.content
                : stored.content,
          }
        : current;
      const merged = applyAssistantDelta(mergedSnapshot, event);
      next = { ...next, messages: upsertMessage(next.messages, merged) };
      break;
    }
    case 'message_end': {
      const message = asObject(event.message);
      next = { ...next, messages: upsertMessage(next.messages, message) };
      break;
    }
    case 'tool_execution_start': {
      const tool: ToolRunState = {
        id:
          typeof event.toolCallId === 'string' ? event.toolCallId : `tool-${next.tools.length + 1}`,
        name: typeof event.toolName === 'string' ? event.toolName : 'unknown',
        args: asObject(event.args),
        startedAt: Date.now(),
      };
      next = {
        ...next,
        connectionState: 'busy',
        tools: [...next.tools.filter((item) => item.id !== tool.id), tool].slice(-100),
      };
      break;
    }
    case 'tool_execution_update':
      next = {
        ...next,
        tools: next.tools.map((tool) =>
          tool.id === event.toolCallId
            ? { ...tool, partialResult: asObject(event.partialResult) }
            : tool
        ),
      };
      break;
    case 'tool_execution_end':
      next = {
        ...next,
        tools: next.tools.map((tool) =>
          tool.id === event.toolCallId
            ? {
                ...tool,
                result: asObject(event.result),
                isError: event.isError === true,
                endedAt: Date.now(),
              }
            : tool
        ),
      };
      break;
    case 'queue_update':
      next = {
        ...next,
        queue: {
          steering: asStringArray(event.steering),
          followUp: asStringArray(event.followUp),
        },
      };
      break;
    case 'compaction_start':
      next = {
        ...next,
        connectionState: 'busy',
        state: { ...next.state, isCompacting: true },
      };
      break;
    case 'compaction_end':
      next = {
        ...next,
        connectionState: next.state.isStreaming ? 'busy' : 'ready',
        state: { ...next.state, isCompacting: false },
      };
      break;
    case 'auto_retry_start':
      next = { ...next, connectionState: 'busy' };
      break;
    case 'auto_retry_end':
      next = { ...next, connectionState: next.state.isStreaming ? 'busy' : 'ready' };
      break;
    case 'entry_appended': {
      const entry = asObject(event.entry);
      if (entry) {
        next = { ...next, entries: replaceEntries(next.entries, [entry]) };
      }
      break;
    }
    case 'session_info_changed':
      next = {
        ...next,
        state: {
          ...next.state,
          sessionName:
            typeof event.name === 'string'
              ? event.name
              : (next.state.sessionName as string | undefined),
        },
      };
      break;
    case 'thinking_level_changed':
      next = {
        ...next,
        state: {
          ...next.state,
          thinkingLevel:
            typeof event.level === 'string'
              ? event.level
              : (next.state.thinkingLevel as string | undefined),
        },
      };
      break;
    case 'extension_error':
      next = pushDiagnostic(next, {
        id: `extension-error-${Date.now()}`,
        kind: 'warning',
        message: typeof event.error === 'string' ? event.error : 'Extension error',
        detail: typeof event.extensionPath === 'string' ? event.extensionPath : undefined,
        timestamp: Date.now(),
      });
      break;
    default:
      break;
  }
  return { ...next, lastEventType: type };
}

export function reduceExtensionUiRequest(
  state: ControllerState,
  request: ExtensionUiRequest
): ControllerState {
  let next = pushUiHistory(state, request);
  if (request.method === 'setStatus' && request.statusKey) {
    const statuses = { ...next.statuses };
    if (request.statusText) {
      statuses[request.statusKey] = request.statusText;
    } else {
      delete statuses[request.statusKey];
    }
    return { ...next, statuses };
  }
  if (request.method === 'setWidget' && request.widgetKey) {
    const widgets = next.widgets.filter((item) => item.key !== request.widgetKey);
    if (request.widgetLines && request.widgetLines.length > 0) {
      widgets.push({
        key: request.widgetKey,
        lines: request.widgetLines,
        placement: request.widgetPlacement ?? 'aboveEditor',
      });
    }
    return { ...next, widgets };
  }
  if (request.method === 'setTitle' && request.title) {
    return { ...next, title: request.title.slice(0, 120) };
  }
  if (request.method === 'set_editor_text' && typeof request.text === 'string') {
    return { ...next, draft: request.text };
  }
  if (request.method === 'notify') {
    return pushDiagnostic(next, {
      id: `notify-${Date.now()}`,
      kind:
        request.notifyType === 'error'
          ? 'error'
          : request.notifyType === 'warning'
            ? 'warning'
            : 'info',
      message: request.message ?? 'Notification',
      timestamp: Date.now(),
    });
  }
  const pendingUi = [...next.pendingUi.filter((item) => item.id !== request.id), request].slice(
    -32
  );
  return { ...next, pendingUi };
}

export function resetControllerProjection(state: ControllerState): ControllerState {
  return {
    ...state,
    ...resetUi(state),
    messages: [],
    entries: [],
    tree: [],
    leafId: undefined,
  };
}

export function mergeSessionState(
  previous: SessionState,
  current: SessionState | undefined
): SessionState {
  return shallowMerge(previous, current) ?? {};
}
