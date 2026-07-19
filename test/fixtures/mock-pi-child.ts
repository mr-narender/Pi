import * as readline from 'node:readline';

interface State {
  model: { provider: string; id: string; name: string; input: string[]; reasoning: boolean };
  thinkingLevel: string;
  isStreaming: boolean;
  isCompacting: boolean;
  steeringMode: string;
  followUpMode: string;
  sessionFile: string;
  sessionId: string;
  sessionName?: string;
  autoCompactionEnabled: boolean;
  messageCount: number;
  pendingMessageCount: number;
}

const state: State = {
  model: {
    provider: 'mock',
    id: 'mock-model',
    name: 'Mock Model',
    input: ['text'],
    reasoning: true,
  },
  thinkingLevel: 'medium',
  isStreaming: false,
  isCompacting: false,
  steeringMode: 'all',
  followUpMode: 'one-at-a-time',
  sessionFile: '/tmp/mock-session.jsonl',
  sessionId: 'mock-session',
  sessionName: 'Mock Session',
  autoCompactionEnabled: true,
  messageCount: 1,
  pendingMessageCount: 0,
};

const messages = [
  { role: 'user', content: 'hello', id: 'm1' },
  { role: 'assistant', content: [{ type: 'text', text: 'hello from mock pi' }], id: 'm2' },
];
const entries = [
  {
    id: 'e1',
    type: 'message',
    parentId: null,
    timestamp: new Date().toISOString(),
    message: messages[0],
  },
];
const commands = [
  {
    name: 'rpc-input',
    description: 'Mock extension command',
    source: 'extension',
    sourceInfo: { source: 'path', path: '/mock/ext.ts' },
  },
  {
    name: 'skill:pi-agent-workflow',
    description: 'Mock skill',
    source: 'skill',
    sourceInfo: { source: 'path', path: '/mock/SKILL.md' },
  },
];

function send(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function response(id: string | undefined, command: string, data?: unknown): void {
  send({ type: 'response', id, command, success: true, data });
}

async function handle(record: Record<string, unknown>): Promise<void> {
  const type = String(record.type ?? '');
  const id = typeof record.id === 'string' ? record.id : undefined;
  switch (type) {
    case 'get_state':
      response(id, type, state);
      return;
    case 'get_messages':
      response(id, type, { messages });
      return;
    case 'get_entries':
      response(id, type, { entries, leafId: 'e1' });
      return;
    case 'get_tree':
      response(id, type, { tree: [{ entry: entries[0], children: [] }], leafId: 'e1' });
      return;
    case 'get_commands':
      response(id, type, { commands });
      return;
    case 'get_session_stats':
      response(id, type, {
        cost: 0.01,
        totalMessages: messages.length,
        contextUsage: { tokens: 10, contextWindow: 1000, percent: 1 },
      });
      return;
    case 'prompt': {
      state.isStreaming = true;
      response(id, type, {});
      send({ type: 'agent_start' });
      send({ type: 'message_start', message: { role: 'assistant', id: 'stream-1', content: [] } });
      send({
        type: 'message_update',
        message: { role: 'assistant', id: 'stream-1', content: [] },
        assistantMessageEvent: { type: 'text_start', contentIndex: 0, partial: {} },
      });
      send({
        type: 'message_update',
        message: { role: 'assistant', id: 'stream-1', content: [] },
        assistantMessageEvent: {
          type: 'text_delta',
          contentIndex: 0,
          delta: 'mock reply',
          partial: {},
        },
      });
      send({
        type: 'message_end',
        message: {
          role: 'assistant',
          id: 'stream-1',
          content: [{ type: 'text', text: 'mock reply' }],
        },
      });
      send({
        type: 'turn_end',
        message: {
          role: 'assistant',
          id: 'stream-1',
          content: [{ type: 'text', text: 'mock reply' }],
        },
        toolResults: [],
      });
      send({ type: 'agent_end', messages: [], willRetry: false });
      send({ type: 'agent_settled' });
      state.isStreaming = false;
      return;
    }
    case 'steer':
      response(id, type, {});
      send({ type: 'queue_update', steering: [String(record.message ?? '')], followUp: [] });
      return;
    case 'follow_up':
      response(id, type, {});
      send({ type: 'queue_update', steering: [], followUp: [String(record.message ?? '')] });
      return;
    case 'abort':
    case 'abort_retry':
    case 'abort_bash':
      response(id, type, {});
      send({ type: 'agent_settled' });
      return;
    case 'new_session':
    case 'clone':
    case 'switch_session':
      response(id, type, { cancelled: false });
      return;
    case 'fork':
      response(id, type, { cancelled: false, text: 'fork text' });
      return;
    case 'get_fork_messages':
      response(id, type, { messages: [{ entryId: 'e1', text: 'hello' }] });
      return;
    case 'set_model':
      state.model = {
        provider: String(record.provider ?? 'mock'),
        id: String(record.modelId ?? 'mock-model'),
        name: 'Selected',
        input: ['text'],
        reasoning: true,
      };
      response(id, type, state.model);
      return;
    case 'cycle_model':
      response(id, type, {
        model: state.model,
        thinkingLevel: state.thinkingLevel,
        isScoped: false,
      });
      return;
    case 'get_available_models':
      response(id, type, { models: [state.model] });
      return;
    case 'set_thinking_level':
      state.thinkingLevel = String(record.level ?? 'medium');
      response(id, type, {});
      return;
    case 'cycle_thinking_level':
      response(id, type, { level: state.thinkingLevel });
      return;
    case 'set_steering_mode':
      state.steeringMode = String(record.mode ?? state.steeringMode);
      response(id, type, {});
      return;
    case 'set_follow_up_mode':
      state.followUpMode = String(record.mode ?? state.followUpMode);
      response(id, type, {});
      return;
    case 'compact':
      response(id, type, {
        summary: 'compact',
        firstKeptEntryId: 'e1',
        tokensBefore: 10,
        estimatedTokensAfter: 2,
        details: {},
      });
      return;
    case 'set_auto_compaction':
      state.autoCompactionEnabled = record.enabled === true;
      response(id, type, {});
      return;
    case 'set_auto_retry':
      response(id, type, {});
      return;
    case 'bash':
      response(id, type, {
        output: 'ok',
        exitCode: 0,
        cancelled: false,
        truncated: false,
        command: record.command,
        excludeFromContext: record.excludeFromContext,
      });
      return;
    case 'export_html':
      response(id, type, { path: String(record.outputPath ?? '/tmp/mock.html') });
      return;
    case 'get_last_assistant_text':
      response(id, type, { text: 'hello from mock pi' });
      return;
    case 'set_session_name':
      state.sessionName = String(record.name ?? '');
      response(id, type, {});
      return;
    case 'extension_ui_response':
      return;
    default:
      send({
        type: 'response',
        id,
        command: type,
        success: false,
        error: `Unsupported mock command: ${type}`,
      });
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const record = JSON.parse(line) as Record<string, unknown>;
  void handle(record);
});
