import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import {
  parseEnvelope,
  isJsonValue,
  type JsonObject,
  type RpcCommand,
  type RpcResponse,
} from '../../src/rpc/protocol';
import { RpcClient } from '../../src/rpc/client';
import { RpcTransport } from '../../src/rpc/transport';
import { createInitialControllerState } from '../../src/state/types';
import { reduceEvent, reduceExtensionUiRequest } from '../../src/state/reducer';
import { createWebviewSnapshot, normalizeAttachment } from '../../src/webview/model';
import { createEmptyComposerState } from '../../src/webview/composer';
import { LocalExtensionUiContext } from '../../src/ui/localExtensionUi';
import evidence from '../../docs/RPC_COVERAGE_EVIDENCE.json';

interface MockTransport {
  request(command: RpcCommand): Promise<RpcResponse>;
  notify(command: RpcCommand): Promise<void>;
  cancelPending(id: string, error: Error): boolean;
  on(): MockTransport;
}

function createRpcClientHarness(queue: unknown[] = []) {
  const requests: RpcCommand[] = [];
  const notifications: RpcCommand[] = [];
  const pending = [...queue];
  const transport: MockTransport = {
    async request(command) {
      requests.push(command);
      const data = pending.length > 0 ? (pending.shift() as JsonObject | undefined) : undefined;
      return {
        type: 'response',
        id: typeof command.id === 'string' ? command.id : undefined,
        command: String(command.type),
        success: true,
        data,
      };
    },
    async notify(command) {
      notifications.push(command);
    },
    cancelPending() {
      return false;
    },
    on() {
      return this;
    },
  };
  return {
    client: new RpcClient(7, transport as never, { shortTimeoutMs: 50, longTimeoutMs: 50 }),
    requests,
    notifications,
  };
}

function createTransportHarness() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const writes: RpcCommand[] = [];
  stdin.on('data', (chunk: Buffer | string) => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    for (const line of text.split('\n')) {
      if (line.trim()) {
        writes.push(JSON.parse(line) as RpcCommand);
      }
    }
  });
  const transport = new RpcTransport(stdin, stdout, null, {
    maxRecordBytes: 4096,
    maxBufferBytes: 4096,
    maxPendingRequests: 8,
    maxQueuedWrites: 8,
  });
  return {
    client: new RpcClient(3, transport, { shortTimeoutMs: 100, longTimeoutMs: 100 }),
    transport,
    stdout,
    writes,
  };
}

async function nextTick(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

function assistantMessage(id = 'm1', content: unknown[] = []): JsonObject {
  return { id, role: 'assistant', content } as JsonObject;
}

function reduceAll(events: unknown[]) {
  let state = createInitialControllerState('workspace', '/tmp/workspace');
  for (const event of events) {
    state = reduceEvent(state, event as never);
  }
  return state;
}

function update(id: string, assistantMessageEvent: JsonObject, message?: JsonObject): JsonObject {
  return {
    type: 'message_update',
    message: message ?? assistantMessage(id),
    assistantMessageEvent,
  } as JsonObject;
}

function runValidatorWithMutation(mutator: (rows: typeof evidence) => void): string {
  const tempDir = mkdtempSync(join(tmpdir(), 'pi-rpc-coverage-'));
  const tempEvidence = join(tempDir, 'evidence.json');
  const rows = JSON.parse(JSON.stringify(evidence)) as typeof evidence;
  mutator(rows);
  writeFileSync(tempEvidence, JSON.stringify(rows, null, 2));
  try {
    execFileSync('node', ['./scripts/validateCoverage.mjs', `--evidence=${tempEvidence}`], {
      encoding: 'utf8',
      stdio: 'pipe',
    });
    throw new Error('validator unexpectedly passed');
  } catch (error) {
    const output =
      error instanceof Error && 'stderr' in error
        ? String((error as { stderr?: string }).stderr ?? '')
        : String(error);
    rmSync(tempDir, { recursive: true, force: true });
    return output;
  }
}

test('rpc.cmd.prompt', async () => {
  const harness = createRpcClientHarness();
  await harness.client.prompt(
    'hello',
    [{ type: 'image', mimeType: 'image/png', data: 'abc' }],
    'steer'
  );
  assert.deepEqual(harness.requests[0], {
    type: 'prompt',
    id: 'g7-r1',
    message: 'hello',
    images: [{ type: 'image', mimeType: 'image/png', data: 'abc' }],
    streamingBehavior: 'steer',
  });
});

test('rpc.cmd.steer', async () => {
  const harness = createRpcClientHarness();
  await harness.client.steer('guide', [{ type: 'image', mimeType: 'image/jpeg', data: 'xyz' }]);
  assert.deepEqual(harness.requests[0], {
    type: 'steer',
    id: 'g7-r1',
    message: 'guide',
    images: [{ type: 'image', mimeType: 'image/jpeg', data: 'xyz' }],
  });
});

test('rpc.cmd.followUp', async () => {
  const harness = createRpcClientHarness();
  await harness.client.followUp('next', [{ type: 'image', mimeType: 'image/webp', data: '123' }]);
  assert.deepEqual(harness.requests[0], {
    type: 'follow_up',
    id: 'g7-r1',
    message: 'next',
    images: [{ type: 'image', mimeType: 'image/webp', data: '123' }],
  });
});

test('rpc.cmd.abort', async () => {
  const harness = createRpcClientHarness();
  await harness.client.abort();
  assert.deepEqual(harness.requests[0], { type: 'abort', id: 'g7-r1' });
});

test('rpc.cmd.newSession', async () => {
  const harness = createRpcClientHarness([{ cancelled: true }]);
  const result = await harness.client.newSession('/tmp/parent.jsonl');
  assert.deepEqual(result, { cancelled: true });
  assert.deepEqual(harness.requests[0], {
    type: 'new_session',
    id: 'g7-r1',
    parentSession: '/tmp/parent.jsonl',
  });
});

test('rpc.cmd.getState', async () => {
  const harness = createRpcClientHarness([
    {
      sessionId: 'sid',
      sessionName: 'demo',
      sessionFile: '/tmp/session.jsonl',
      isStreaming: true,
      isCompacting: false,
      steeringMode: 'all',
      followUpMode: 'one-at-a-time',
      autoCompactionEnabled: true,
      messageCount: 2,
      pendingMessageCount: 1,
    },
  ]);
  const result = await harness.client.getState();
  assert.equal(result?.sessionId, 'sid');
  assert.equal(result?.followUpMode, 'one-at-a-time');
  assert.deepEqual(harness.requests[0], { type: 'get_state', id: 'g7-r1' });
});

test('rpc.cmd.getMessages', async () => {
  const harness = createRpcClientHarness([
    { messages: [{ id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'hi' }] }] },
  ]);
  const result = await harness.client.getMessages();
  assert.deepEqual(result, {
    messages: [{ id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'hi' }] }],
  });
  assert.deepEqual(harness.requests[0], { type: 'get_messages', id: 'g7-r1' });
});

test('rpc.cmd.setModel', async () => {
  const harness = createRpcClientHarness([{ id: 'model-1', provider: 'mock' }]);
  const result = await harness.client.setModel('mock', 'model-1');
  assert.deepEqual(result, { id: 'model-1', provider: 'mock' });
  assert.deepEqual(harness.requests[0], {
    type: 'set_model',
    id: 'g7-r1',
    provider: 'mock',
    modelId: 'model-1',
  });
});

test('rpc.cmd.cycleModel', async () => {
  const harness = createRpcClientHarness([
    { model: { provider: 'mock', id: 'next' }, thinkingLevel: 'high', isScoped: true },
  ]);
  const result = await harness.client.cycleModel();
  assert.deepEqual(result, {
    model: { provider: 'mock', id: 'next' },
    thinkingLevel: 'high',
    isScoped: true,
  });
  assert.deepEqual(harness.requests[0], { type: 'cycle_model', id: 'g7-r1' });
});

test('rpc.cmd.getAvailableModels', async () => {
  const harness = createRpcClientHarness([
    {
      models: [
        {
          id: 'm1',
          provider: 'mock',
          name: 'Mock 1',
          input: ['text', 'image'],
          reasoning: true,
          contextWindow: 200000,
        },
      ],
    },
  ]);
  const result = await harness.client.getAvailableModels();
  assert.equal(Array.isArray(result?.models), true);
  assert.deepEqual(harness.requests[0], { type: 'get_available_models', id: 'g7-r1' });
});

test('rpc.cmd.setThinkingLevel', async () => {
  const harness = createRpcClientHarness();
  await harness.client.setThinkingLevel('xhigh');
  assert.deepEqual(harness.requests[0], {
    type: 'set_thinking_level',
    id: 'g7-r1',
    level: 'xhigh',
  });
});

test('rpc.cmd.cycleThinking', async () => {
  const harness = createRpcClientHarness([{ level: 'medium' }]);
  const result = await harness.client.cycleThinkingLevel();
  assert.deepEqual(result, { level: 'medium' });
  assert.deepEqual(harness.requests[0], { type: 'cycle_thinking_level', id: 'g7-r1' });
});

test('rpc.cmd.setSteeringMode', async () => {
  const harness = createRpcClientHarness();
  await harness.client.setSteeringMode('one-at-a-time');
  assert.deepEqual(harness.requests[0], {
    type: 'set_steering_mode',
    id: 'g7-r1',
    mode: 'one-at-a-time',
  });
});

test('rpc.cmd.setFollowUpMode', async () => {
  const harness = createRpcClientHarness();
  await harness.client.setFollowUpMode('all');
  assert.deepEqual(harness.requests[0], {
    type: 'set_follow_up_mode',
    id: 'g7-r1',
    mode: 'all',
  });
});

test('rpc.cmd.compact', async () => {
  const harness = createRpcClientHarness([
    {
      summary: 'Compacted',
      firstKeptEntryId: 'e2',
      tokensBefore: 1200,
      estimatedTokensAfter: 300,
    },
  ]);
  const result = await harness.client.compact('keep the plan');
  assert.equal(result?.summary, 'Compacted');
  assert.deepEqual(harness.requests[0], {
    type: 'compact',
    id: 'g7-r1',
    customInstructions: 'keep the plan',
  });
});

test('rpc.cmd.setAutoCompaction', async () => {
  const harness = createRpcClientHarness();
  await harness.client.setAutoCompaction(true);
  assert.deepEqual(harness.requests[0], {
    type: 'set_auto_compaction',
    id: 'g7-r1',
    enabled: true,
  });
});

test('rpc.cmd.setAutoRetry', async () => {
  const harness = createRpcClientHarness();
  await harness.client.setAutoRetry(false);
  assert.deepEqual(harness.requests[0], {
    type: 'set_auto_retry',
    id: 'g7-r1',
    enabled: false,
  });
});

test('rpc.cmd.abortRetry', async () => {
  const harness = createRpcClientHarness();
  await harness.client.abortRetry();
  assert.deepEqual(harness.requests[0], { type: 'abort_retry', id: 'g7-r1' });
});

test('rpc.cmd.bash', async () => {
  const harness = createRpcClientHarness([
    {
      output: 'done',
      exitCode: 0,
      cancelled: false,
      truncated: false,
      fullOutputPath: '/tmp/bash.log',
    },
  ]);
  const result = await harness.client.bash('pwd', true);
  assert.equal(result?.fullOutputPath, '/tmp/bash.log');
  assert.deepEqual(harness.requests[0], {
    type: 'bash',
    id: 'g7-r1',
    command: 'pwd',
    excludeFromContext: true,
  });
});

test('rpc.cmd.abortBash', async () => {
  const harness = createRpcClientHarness();
  await harness.client.abortBash();
  assert.deepEqual(harness.requests[0], { type: 'abort_bash', id: 'g7-r1' });
});

test('rpc.cmd.getSessionStats', async () => {
  const harness = createRpcClientHarness([
    { messageCount: 4, toolCount: 2, totalTokens: 33, cost: 0.21, contextUsage: null },
  ]);
  const result = await harness.client.getSessionStats();
  assert.equal(result?.messageCount, 4);
  assert.deepEqual(harness.requests[0], { type: 'get_session_stats', id: 'g7-r1' });
});

test('rpc.cmd.exportHtml', async () => {
  const harness = createRpcClientHarness([{ path: '/tmp/session.html' }]);
  const result = await harness.client.exportHtml('/tmp/session.html');
  assert.equal(result?.path, '/tmp/session.html');
  assert.deepEqual(harness.requests[0], {
    type: 'export_html',
    id: 'g7-r1',
    outputPath: '/tmp/session.html',
  });
});

test('rpc.cmd.switchSession', async () => {
  const harness = createRpcClientHarness([{ cancelled: false }]);
  const result = await harness.client.switchSession('/tmp/other.jsonl');
  assert.equal(result?.cancelled, false);
  assert.deepEqual(harness.requests[0], {
    type: 'switch_session',
    id: 'g7-r1',
    sessionPath: '/tmp/other.jsonl',
  });
});

test('rpc.cmd.fork', async () => {
  const harness = createRpcClientHarness([{ cancelled: false, text: 'seed draft' }]);
  const result = await harness.client.fork('entry-1');
  assert.deepEqual(result, { cancelled: false, text: 'seed draft' });
  assert.deepEqual(harness.requests[0], {
    type: 'fork',
    id: 'g7-r1',
    entryId: 'entry-1',
  });
});

test('rpc.cmd.clone', async () => {
  const harness = createRpcClientHarness([{ cancelled: false }]);
  const result = await harness.client.clone();
  assert.deepEqual(result, { cancelled: false });
  assert.deepEqual(harness.requests[0], { type: 'clone', id: 'g7-r1' });
});

test('rpc.cmd.getForkMessages', async () => {
  const harness = createRpcClientHarness([
    {
      messages: [
        { id: 'e1', text: 'first' },
        { id: 'e2', text: 'second' },
      ],
    },
  ]);
  const result = await harness.client.getForkMessages('entry-2');
  assert.deepEqual(result, {
    messages: [
      { id: 'e1', text: 'first' },
      { id: 'e2', text: 'second' },
    ],
  });
  assert.deepEqual(harness.requests[0], {
    type: 'get_fork_messages',
    id: 'g7-r1',
    entryId: 'entry-2',
  });
});

test('rpc.cmd.getEntries', async () => {
  const harness = createRpcClientHarness([
    { entries: [{ id: 'e2', parentId: 'e1', timestamp: '2024-01-01T00:00:00Z' }], leafId: 'e2' },
  ]);
  const result = await harness.client.getEntries('e1');
  assert.deepEqual(result, {
    entries: [{ id: 'e2', parentId: 'e1', timestamp: '2024-01-01T00:00:00Z' }],
    leafId: 'e2',
  });
  assert.deepEqual(harness.requests[0], { type: 'get_entries', id: 'g7-r1', since: 'e1' });
});

test('rpc.cmd.getTree', async () => {
  const harness = createRpcClientHarness([
    {
      tree: [{ id: 'root', children: [{ id: 'leaf', children: [], label: 'Leaf' }] }],
      leafId: 'leaf',
    },
  ]);
  const result = await harness.client.getTree();
  assert.equal((result?.tree as JsonObject[])?.[0]?.id, 'root');
  assert.deepEqual(harness.requests[0], { type: 'get_tree', id: 'g7-r1' });
});

test('rpc.cmd.getLastAssistantText', async () => {
  const harness = createRpcClientHarness([{ text: 'final answer' }]);
  const result = await harness.client.getLastAssistantText();
  assert.deepEqual(result, { text: 'final answer' });
  assert.deepEqual(harness.requests[0], { type: 'get_last_assistant_text', id: 'g7-r1' });
});

test('rpc.cmd.setSessionName', async () => {
  const harness = createRpcClientHarness();
  await harness.client.setSessionName('Renamed');
  assert.deepEqual(harness.requests[0], {
    type: 'set_session_name',
    id: 'g7-r1',
    name: 'Renamed',
  });
});

test('rpc.cmd.getCommands', async () => {
  const harness = createRpcClientHarness([
    {
      commands: [
        {
          name: '/workflow',
          source: 'extension',
          sourceInfo: { path: '/tmp/ext.js', source: 'extension', scope: 'workspace' },
        },
      ],
    },
  ]);
  const result = await harness.client.getCommands();
  assert.equal(Array.isArray(result?.commands), true);
  assert.deepEqual(harness.requests[0], { type: 'get_commands', id: 'g7-r1' });
});

test('rpc.cmd.extensionUiResponse', async () => {
  const harness = createRpcClientHarness();
  await harness.client.respondExtensionUi({ id: 'ui-1', value: 'picked' });
  assert.deepEqual(harness.notifications[0], {
    type: 'extension_ui_response',
    id: 'ui-1',
    value: 'picked',
  });
});

test('rpc.response.failure', async () => {
  const harness = createTransportHarness();
  const first = harness.client.getState();
  await nextTick();
  const firstRequest = harness.writes[0];
  assert.ok(firstRequest);
  harness.stdout.write(
    `${JSON.stringify({
      type: 'response',
      id: firstRequest.id,
      command: 'get_state',
      success: false,
      error: 'boom',
    })}\n`
  );
  await assert.rejects(first, /boom/);

  const second = harness.client.getState();
  await nextTick();
  const secondRequest = harness.writes[1];
  assert.ok(secondRequest);
  harness.stdout.write(
    `${JSON.stringify({
      type: 'response',
      id: secondRequest.id,
      command: 'get_state',
      success: true,
      data: { sessionId: 'ok' },
    })}\n`
  );
  const result = await second;
  assert.equal(result?.sessionId, 'ok');
});

test('rpc.response.parseFailure', async () => {
  const harness = createTransportHarness();
  const failures: RpcResponse[] = [];
  harness.transport.on('responseFailure', (response: RpcResponse) => failures.push(response));
  const pending = harness.client.getState();
  await nextTick();
  const request = harness.writes[0];
  assert.ok(request);
  harness.stdout.write(
    `${JSON.stringify({ type: 'response', command: 'parse', success: false, error: 'bad json' })}\n`
  );
  harness.stdout.write(
    `${JSON.stringify({
      type: 'response',
      id: request.id,
      command: 'get_state',
      success: true,
      data: { sessionId: 'steady' },
    })}\n`
  );
  const result = await pending;
  assert.equal(result?.sessionId, 'steady');
  assert.equal(failures[0]?.command, 'parse');
});

test('rpc.event.agentStart', () => {
  const state = createInitialControllerState('workspace', '/tmp/workspace');
  state.messages = [{ id: 'old', role: 'user', content: 'keep' }];
  const next = reduceEvent(state, { type: 'agent_start' } as never);
  assert.equal(next.connectionState, 'busy');
  assert.equal(next.state.isStreaming, true);
  assert.equal(next.messages.length, 1);
});

test('rpc.event.agentEnd', () => {
  const state = createInitialControllerState('workspace', '/tmp/workspace');
  state.state.isStreaming = true;
  const next = reduceEvent(state, {
    type: 'agent_end',
    messages: [{ id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'done' }] }],
  } as never);
  assert.equal(next.state.isStreaming, false);
  assert.equal(next.messages[0]?.id, 'm1');
});

test('rpc.event.agentSettled', () => {
  const state = createInitialControllerState('workspace', '/tmp/workspace');
  state.connectionState = 'busy';
  state.state.isCompacting = false;
  const next = reduceEvent(state, { type: 'agent_settled' } as never);
  assert.equal(next.connectionState, 'ready');
  assert.equal(next.state.isStreaming, false);
});

test('rpc.event.turnStart', () => {
  const next = reduceEvent(createInitialControllerState('workspace', '/tmp/workspace'), {
    type: 'turn_start',
  } as never);
  assert.equal(next.connectionState, 'busy');
});

test('rpc.event.turnEnd', () => {
  const state = createInitialControllerState('workspace', '/tmp/workspace');
  state.messages = [{ id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'partial' }] }];
  const next = reduceEvent(state, {
    type: 'turn_end',
    message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'final' }] },
    toolResults: [{ id: 't1', role: 'toolResult', content: 'ok' }],
  } as never);
  assert.deepEqual(
    next.messages.map((message) => message.id),
    ['m1', 't1']
  );
  assert.deepEqual(next.messages[0]?.content, [{ type: 'text', text: 'final' }]);
});

test('rpc.event.messageStart', () => {
  const next = reduceEvent(createInitialControllerState('workspace', '/tmp/workspace'), {
    type: 'message_start',
    message: { id: 'u1', role: 'custom', content: 'opaque' },
  } as never);
  assert.equal(next.messages[0]?.role, 'custom');
  assert.equal(next.messages[0]?.content, 'opaque');
});

test('rpc.event.messageUpdate', () => {
  const next = reduceAll([
    { type: 'message_start', message: assistantMessage('m1') },
    update('m1', { type: 'text_start', contentIndex: 0, partial: {} }),
    update('m1', { type: 'text_delta', contentIndex: 0, delta: 'hel', partial: {} }),
    update('m1', { type: 'thinking_start', contentIndex: 1, partial: {} }),
    update('m1', { type: 'thinking_delta', contentIndex: 1, delta: 'plan', partial: {} }),
    update('m1', { type: 'text_delta', contentIndex: 0, delta: 'lo', partial: {} }),
    update('m1', {
      type: 'toolcall_start',
      contentIndex: 2,
      id: 'tool-1',
      name: 'bash',
      arguments: '{',
      partial: {},
    }),
    update('m1', { type: 'toolcall_delta', contentIndex: 2, delta: '"cwd":"/tmp"}', partial: {} }),
  ]);
  assert.equal(next.messages.length, 1);
  assert.deepEqual(next.messages[0]?.content, [
    { type: 'text', text: 'hello' },
    { type: 'thinking', thinking: 'plan' },
    { type: 'toolCall', id: 'tool-1', name: 'bash', arguments: '{"cwd":"/tmp"}' },
  ]);
});

test('rpc.event.messageEnd', () => {
  const state = reduceAll([
    { type: 'message_start', message: assistantMessage('m1') },
    update('m1', { type: 'text_start', contentIndex: 0, partial: {} }),
    update('m1', { type: 'text_delta', contentIndex: 0, delta: 'hel', partial: {} }),
  ]);
  const next = reduceEvent(state, {
    type: 'message_end',
    message: {
      id: 'm1',
      role: 'assistant',
      content: [{ type: 'text', text: 'hello' }],
      stopReason: 'stop',
    },
  } as never);
  assert.equal(next.messages.length, 1);
  assert.deepEqual(next.messages[0], {
    id: 'm1',
    role: 'assistant',
    content: [{ type: 'text', text: 'hello' }],
    stopReason: 'stop',
  });
});

test('rpc.event.toolStart', () => {
  const next = reduceEvent(createInitialControllerState('workspace', '/tmp/workspace'), {
    type: 'tool_execution_start',
    toolCallId: 'tool-1',
    toolName: 'edit',
    args: { path: 'a.ts' },
  } as never);
  assert.equal(next.connectionState, 'busy');
  assert.deepEqual(next.tools[0]?.args, { path: 'a.ts' });
});

test('rpc.event.toolUpdate', () => {
  const state = createInitialControllerState('workspace', '/tmp/workspace');
  state.tools = [
    { id: 'tool-1', name: 'edit', partialResult: { text: 'old' }, startedAt: Date.now() },
  ];
  const next = reduceEvent(state, {
    type: 'tool_execution_update',
    toolCallId: 'tool-1',
    partialResult: { text: 'new', details: { truncated: true } },
  } as never);
  assert.deepEqual(next.tools[0]?.partialResult, { text: 'new', details: { truncated: true } });
});

test('rpc.event.toolEnd', () => {
  const state = createInitialControllerState('workspace', '/tmp/workspace');
  state.tools = [{ id: 'tool-1', name: 'edit', startedAt: Date.now() }];
  const next = reduceEvent(state, {
    type: 'tool_execution_end',
    toolCallId: 'tool-1',
    result: {
      text: 'done',
      content: [{ type: 'image', mimeType: 'image/png', data: 'abc' }],
      details: { diff: true },
    },
    isError: true,
  } as never);
  assert.equal(next.tools[0]?.isError, true);
  assert.deepEqual(next.tools[0]?.result, {
    text: 'done',
    content: [{ type: 'image', mimeType: 'image/png', data: 'abc' }],
    details: { diff: true },
  });
});

test('rpc.event.queueUpdate', () => {
  const next = reduceEvent(createInitialControllerState('workspace', '/tmp/workspace'), {
    type: 'queue_update',
    steering: ['s1', 2, 's2'],
    followUp: ['f1', null, 'f2'],
  } as never);
  assert.deepEqual(next.queue, { steering: ['s1', 's2'], followUp: ['f1', 'f2'] });
});

test('rpc.event.compactionStart', () => {
  const next = reduceEvent(createInitialControllerState('workspace', '/tmp/workspace'), {
    type: 'compaction_start',
  } as never);
  assert.equal(next.connectionState, 'busy');
  assert.equal(next.state.isCompacting, true);
});

test('rpc.event.compactionEnd', () => {
  const state = createInitialControllerState('workspace', '/tmp/workspace');
  state.state.isCompacting = true;
  const next = reduceEvent(state, { type: 'compaction_end' } as never);
  assert.equal(next.connectionState, 'ready');
  assert.equal(next.state.isCompacting, false);
});

test('rpc.event.retryStart', () => {
  const next = reduceEvent(createInitialControllerState('workspace', '/tmp/workspace'), {
    type: 'auto_retry_start',
  } as never);
  assert.equal(next.connectionState, 'busy');
});

test('rpc.event.retryEnd', () => {
  const next = reduceEvent(createInitialControllerState('workspace', '/tmp/workspace'), {
    type: 'auto_retry_end',
  } as never);
  assert.equal(next.connectionState, 'ready');
});

test('rpc.event.extensionError', () => {
  const next = reduceEvent(createInitialControllerState('workspace', '/tmp/workspace'), {
    type: 'extension_error',
    error: 'boom',
    extensionPath: '/tmp/ext.js',
  } as never);
  assert.equal(next.diagnostics.at(-1)?.message, 'boom');
  assert.equal(next.diagnostics.at(-1)?.detail, '/tmp/ext.js');
});

test('rpc.compat.entryAppended', () => {
  const next = reduceEvent(createInitialControllerState('workspace', '/tmp/workspace'), {
    type: 'entry_appended',
    entry: { id: 'e1', type: 'message', timestamp: '2024-01-01T00:00:00Z' },
  } as never);
  assert.deepEqual(next.entries, [
    { id: 'e1', type: 'message', timestamp: '2024-01-01T00:00:00Z' },
  ]);
});

test('rpc.compat.sessionInfoChanged', () => {
  const next = reduceEvent(createInitialControllerState('workspace', '/tmp/workspace'), {
    type: 'session_info_changed',
    name: 'Renamed Session',
  } as never);
  assert.equal(next.state.sessionName, 'Renamed Session');
});

test('rpc.compat.thinkingLevelChanged', () => {
  const next = reduceEvent(createInitialControllerState('workspace', '/tmp/workspace'), {
    type: 'thinking_level_changed',
    level: 'max',
  } as never);
  assert.equal(next.state.thinkingLevel, 'max');
});

test('rpc.delta.start', () => {
  const next = reduceAll([
    { type: 'message_start', message: assistantMessage('m1') },
    update('m1', { type: 'start', partial: { role: 'assistant' } }),
  ]);
  assert.deepEqual(next.messages[0], { id: 'm1', role: 'assistant', content: [] });
});

test('rpc.delta.textLifecycle', () => {
  const next = reduceAll([
    { type: 'message_start', message: assistantMessage('m1') },
    update('m1', { type: 'text_start', contentIndex: 0, partial: {} }),
    update('m1', { type: 'text_delta', contentIndex: 0, delta: 'he', partial: {} }),
    update('m1', { type: 'text_delta', contentIndex: 0, delta: 'llo', partial: {} }),
    update('m1', { type: 'text_end', contentIndex: 0, content: 'hello', partial: {} }),
  ]);
  assert.deepEqual(next.messages[0]?.content, [{ type: 'text', text: 'hello' }]);
});

test('rpc.delta.thinkingLifecycle', () => {
  const next = reduceAll([
    { type: 'message_start', message: assistantMessage('m1') },
    update('m1', { type: 'thinking_start', contentIndex: 0, partial: {} }),
    update('m1', { type: 'thinking_delta', contentIndex: 0, delta: 'pla', partial: {} }),
    update('m1', { type: 'thinking_delta', contentIndex: 0, delta: 'n', partial: {} }),
    update('m1', { type: 'thinking_end', contentIndex: 0, content: 'plan', partial: {} }),
  ]);
  assert.deepEqual(next.messages[0]?.content, [{ type: 'thinking', thinking: 'plan' }]);
});

test('rpc.delta.toolLifecycle', () => {
  const next = reduceAll([
    { type: 'message_start', message: assistantMessage('m1') },
    update('m1', {
      type: 'toolcall_start',
      contentIndex: 0,
      id: 'tool-1',
      name: 'bash',
      arguments: '{',
      partial: {},
    }),
    update('m1', {
      type: 'toolcall_delta',
      contentIndex: 0,
      delta: '"command":"pwd"}',
      partial: {},
    }),
    update('m1', {
      type: 'toolcall_end',
      contentIndex: 0,
      toolCall: { type: 'toolCall', id: 'tool-1', name: 'bash', arguments: { command: 'pwd' } },
      partial: {},
    }),
  ]);
  assert.deepEqual(next.messages[0]?.content, [
    { type: 'toolCall', id: 'tool-1', name: 'bash', arguments: { command: 'pwd' } },
  ]);
});

test('rpc.delta.done', () => {
  const next = reduceAll([
    { type: 'message_start', message: assistantMessage('m1') },
    update('m1', { type: 'done', reason: 'length', partial: {} }),
  ]);
  assert.equal(next.messages[0]?.stopReason, 'length');
});

test('rpc.delta.error', () => {
  const next = reduceAll([
    { type: 'message_start', message: assistantMessage('m1') },
    update('m1', { type: 'error', reason: 'aborted', errorMessage: 'stopped', partial: {} }),
  ]);
  assert.equal(next.messages[0]?.stopReason, 'aborted');
  assert.equal(next.messages[0]?.errorMessage, 'stopped');
});

test('rpc.event.messageUpdate accumulates multi-chunk text across stored partial state', () => {
  const next = reduceAll([
    { type: 'message_start', message: assistantMessage('m1') },
    update('m1', { type: 'text_start', contentIndex: 0, partial: {} }),
    update('m1', { type: 'text_delta', contentIndex: 0, delta: 'hel', partial: {} }),
    update('m1', { type: 'text_delta', contentIndex: 0, delta: 'lo', partial: {} }),
  ]);
  assert.equal((next.messages[0]?.content as JsonObject[])[0]?.text, 'hello');
});

test('rpc.event.messageUpdate keeps interleaved blocks isolated by contentIndex', () => {
  const next = reduceAll([
    { type: 'message_start', message: assistantMessage('m1') },
    update('m1', { type: 'text_start', contentIndex: 0, partial: {} }),
    update('m1', { type: 'thinking_start', contentIndex: 1, partial: {} }),
    update('m1', { type: 'text_delta', contentIndex: 0, delta: 'A', partial: {} }),
    update('m1', { type: 'thinking_delta', contentIndex: 1, delta: 'B', partial: {} }),
    update('m1', { type: 'text_delta', contentIndex: 0, delta: 'C', partial: {} }),
    update('m1', { type: 'thinking_delta', contentIndex: 1, delta: 'D', partial: {} }),
  ]);
  assert.deepEqual(next.messages[0]?.content, [
    { type: 'text', text: 'AC' },
    { type: 'thinking', thinking: 'BD' },
  ]);
});

test('rpc.ui.select', () => {
  const next = reduceExtensionUiRequest(
    createInitialControllerState('workspace', '/tmp/workspace'),
    {
      type: 'extension_ui_request',
      id: 'u1',
      method: 'select',
      title: 'Pick',
      options: ['a', 'b'],
    }
  );
  assert.equal(next.uiHistory.at(-1)?.method, 'select');
  assert.equal(next.pendingUi.at(-1)?.id, 'u1');
});

test('rpc.ui.confirm', () => {
  const next = reduceExtensionUiRequest(
    createInitialControllerState('workspace', '/tmp/workspace'),
    {
      type: 'extension_ui_request',
      id: 'u2',
      method: 'confirm',
      title: 'Confirm',
      message: 'Proceed?',
    }
  );
  assert.equal(next.uiHistory.at(-1)?.method, 'confirm');
  assert.equal(next.pendingUi.at(-1)?.message, 'Proceed?');
});

test('rpc.ui.input', () => {
  const next = reduceExtensionUiRequest(
    createInitialControllerState('workspace', '/tmp/workspace'),
    {
      type: 'extension_ui_request',
      id: 'u3',
      method: 'input',
      title: 'Input',
      placeholder: 'type here',
    }
  );
  assert.equal(next.pendingUi.at(-1)?.method, 'input');
  assert.equal(next.pendingUi.at(-1)?.placeholder, 'type here');
});

test('rpc.ui.editor', () => {
  const next = reduceExtensionUiRequest(
    createInitialControllerState('workspace', '/tmp/workspace'),
    {
      type: 'extension_ui_request',
      id: 'u4',
      method: 'editor',
      title: 'Editor',
      prefill: 'line1\nline2',
    }
  );
  assert.equal(next.pendingUi.at(-1)?.method, 'editor');
  assert.equal(next.pendingUi.at(-1)?.prefill, 'line1\nline2');
});

test('rpc.ui.notify', () => {
  const next = reduceExtensionUiRequest(
    createInitialControllerState('workspace', '/tmp/workspace'),
    {
      type: 'extension_ui_request',
      id: 'u5',
      method: 'notify',
      notifyType: 'warning',
      message: 'Heads up',
    }
  );
  assert.equal(next.pendingUi.length, 0);
  assert.equal(next.diagnostics.at(-1)?.kind, 'warning');
  assert.equal(next.diagnostics.at(-1)?.message, 'Heads up');
});

test('rpc.ui.setStatus', () => {
  let state = createInitialControllerState('workspace', '/tmp/workspace');
  state = reduceExtensionUiRequest(state, {
    type: 'extension_ui_request',
    id: 'u6',
    method: 'setStatus',
    statusKey: 'mode',
    statusText: 'busy',
  });
  state = reduceExtensionUiRequest(state, {
    type: 'extension_ui_request',
    id: 'u6-clear',
    method: 'setStatus',
    statusKey: 'mode',
  });
  assert.equal(state.statuses.mode, undefined);
});

test('rpc.ui.setWidget', () => {
  let state = createInitialControllerState('workspace', '/tmp/workspace');
  state = reduceExtensionUiRequest(state, {
    type: 'extension_ui_request',
    id: 'u7',
    method: 'setWidget',
    widgetKey: 'summary',
    widgetLines: ['one', 'two'],
    widgetPlacement: 'belowEditor',
  });
  assert.deepEqual(state.widgets, [
    { key: 'summary', lines: ['one', 'two'], placement: 'belowEditor' },
  ]);
  state = reduceExtensionUiRequest(state, {
    type: 'extension_ui_request',
    id: 'u7-clear',
    method: 'setWidget',
    widgetKey: 'summary',
    widgetLines: [],
  });
  assert.deepEqual(state.widgets, []);
});

test('rpc.ui.setTitle', () => {
  const title = 'x'.repeat(150);
  const next = reduceExtensionUiRequest(
    createInitialControllerState('workspace', '/tmp/workspace'),
    {
      type: 'extension_ui_request',
      id: 'u8',
      method: 'setTitle',
      title,
    }
  );
  assert.equal(next.title, 'x'.repeat(120));
});

test('rpc.ui.setEditorText', () => {
  const next = reduceExtensionUiRequest(
    createInitialControllerState('workspace', '/tmp/workspace'),
    {
      type: 'extension_ui_request',
      id: 'u9',
      method: 'set_editor_text',
      text: 'draft body',
    }
  );
  assert.equal(next.draft, 'draft body');
});

test('rpc.ui.local.onTerminalInput', () => {
  const ui = new LocalExtensionUiContext();
  assert.equal(typeof ui.onTerminalInput().dispose, 'function');
});

test('rpc.ui.local.setWorkingMessage', () => {
  const ui = new LocalExtensionUiContext();
  assert.equal(ui.setWorkingMessage(), undefined);
});

test('rpc.ui.local.setWorkingVisible', () => {
  const ui = new LocalExtensionUiContext();
  assert.equal(ui.setWorkingVisible(), undefined);
});

test('rpc.ui.local.setWorkingIndicator', () => {
  const ui = new LocalExtensionUiContext();
  assert.equal(ui.setWorkingIndicator(), undefined);
});

test('rpc.ui.local.setHiddenThinkingLabel', () => {
  const ui = new LocalExtensionUiContext();
  assert.equal(ui.setHiddenThinkingLabel(), undefined);
});

test('rpc.ui.local.setFooter', () => {
  const ui = new LocalExtensionUiContext();
  assert.equal(ui.setFooter(), undefined);
});

test('rpc.ui.local.setHeader', () => {
  const ui = new LocalExtensionUiContext();
  assert.equal(ui.setHeader(), undefined);
});

test('rpc.ui.local.custom', async () => {
  const ui = new LocalExtensionUiContext();
  assert.equal(await ui.custom(), undefined);
});

test('rpc.ui.local.pasteToEditor', () => {
  const ui = new LocalExtensionUiContext();
  let seen: JsonObject | undefined;
  const request = ui.pasteToEditor(
    {
      applyExtensionUiRequest(value: JsonObject) {
        seen = value;
      },
    } as never,
    'hello'
  );
  assert.equal(request.method, 'set_editor_text');
  assert.equal(seen?.text, 'hello');
});

test('rpc.ui.local.getEditorText', () => {
  const ui = new LocalExtensionUiContext();
  assert.equal(ui.getEditorText(), '');
});

test('rpc.ui.local.addAutocompleteProvider', () => {
  const ui = new LocalExtensionUiContext();
  assert.equal(ui.addAutocompleteProvider(), undefined);
});

test('rpc.ui.local.setEditorComponent', () => {
  const ui = new LocalExtensionUiContext();
  assert.equal(ui.setEditorComponent(), undefined);
});

test('rpc.ui.local.getEditorComponent', () => {
  const ui = new LocalExtensionUiContext();
  assert.equal(ui.getEditorComponent(), undefined);
});

test('rpc.ui.local.themeGetter', () => {
  const ui = new LocalExtensionUiContext();
  assert.equal(ui.theme.mode, 'rpc');
});

test('rpc.ui.local.getAllThemes', () => {
  const ui = new LocalExtensionUiContext();
  assert.deepEqual(ui.getAllThemes(), []);
});

test('rpc.ui.local.getTheme', () => {
  const ui = new LocalExtensionUiContext();
  assert.equal(ui.getTheme(), undefined);
});

test('rpc.ui.local.setTheme', () => {
  const ui = new LocalExtensionUiContext();
  assert.deepEqual(ui.setTheme(), {
    success: false,
    error: 'Themes are not switchable through the Pi VS Code compatibility mode.',
  });
});

test('rpc.ui.local.getToolsExpanded', () => {
  const ui = new LocalExtensionUiContext();
  assert.equal(ui.getToolsExpanded(), false);
});

test('rpc.ui.local.setToolsExpanded', () => {
  const ui = new LocalExtensionUiContext();
  assert.equal(ui.setToolsExpanded(), undefined);
});

test('rpc.shape.state', () => {
  const parsed = parseEnvelope({
    type: 'response',
    id: '1',
    command: 'get_state',
    success: true,
    data: {
      model: null,
      thinkingLevel: 'medium',
      isStreaming: true,
      isCompacting: false,
      steeringMode: 'all',
      followUpMode: 'one-at-a-time',
      sessionFile: '/tmp/session.jsonl',
      sessionId: 'sid',
      sessionName: 'demo',
      autoCompactionEnabled: true,
      messageCount: 7,
      pendingMessageCount: 2,
    },
  });
  assert.equal(parsed.type, 'response');
  assert.equal(parsed.success, true);
  if (parsed.type === 'response' && parsed.success) {
    assert.equal((parsed.data as JsonObject).sessionId, 'sid');
    assert.equal((parsed.data as JsonObject).pendingMessageCount, 2);
  }
});

test('rpc.shape.model', () => {
  const parsed = parseEnvelope({
    type: 'response',
    id: '2',
    command: 'get_state',
    success: true,
    data: {
      model: {
        id: 'model-1',
        name: 'Mock',
        api: 'responses',
        provider: 'mock',
        baseUrl: 'https://example.invalid',
        reasoning: true,
        input: ['text', 'image'],
        contextWindow: 200000,
        maxTokens: 8192,
        cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
        metadata: { region: 'test' },
      },
    },
  });
  assert.equal(parsed.type, 'response');
  assert.equal(parsed.success, true);
  if (parsed.type === 'response' && parsed.success) {
    const model = (parsed.data as JsonObject).model as JsonObject;
    assert.equal(model.baseUrl, 'https://example.invalid');
    assert.deepEqual(model.metadata, { region: 'test' });
  }
});

test('rpc.shape.blocks', () => {
  const state = createInitialControllerState('workspace', '/tmp/workspace');
  state.messages = [
    {
      id: 'm1',
      role: 'assistant',
      content: [
        { type: 'text', text: 'hello' },
        { type: 'thinking', thinking: 'plan' },
        { type: 'toolCall', name: 'bash', arguments: { command: 'pwd' } },
        { type: 'image', mimeType: 'image/png', data: 'abc' },
        { type: 'other', value: true },
      ],
    },
  ];
  const snapshot = createWebviewSnapshot(state, 1, {
    uiMode: 'simple',
    composer: createEmptyComposerState(),
    isTrusted: true,
    folders: [{ name: 'workspace', uri: 'file:///tmp/workspace', active: true }],
  });
  assert.ok(snapshot.messages[0]?.text.includes('hello'));
  assert.ok(snapshot.messages[0]?.text.includes('[thinking]\nplan'));
  assert.ok(snapshot.messages[0]?.text.includes('[tool:bash]'));
  assert.ok(snapshot.messages[0]?.text.includes('[image:image/png]'));
  assert.ok(snapshot.messages[0]?.text.includes('[unknown block]'));
});

test('rpc.shape.messages', () => {
  const state = createInitialControllerState('workspace', '/tmp/workspace');
  state.messages = [
    { id: 'u1', role: 'user', content: 'hello' },
    { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
    { id: 't1', role: 'toolResult', content: 'ok' },
    { id: 'b1', role: 'bashExecution', content: 'pwd' },
    { id: 'c1', role: 'custom', content: 'opaque' },
    { id: 'bs1', role: 'branchSummary', content: 'branch' },
    { id: 'cs1', role: 'compactionSummary', content: 'compacted' },
  ];
  const snapshot = createWebviewSnapshot(state, 1, {
    uiMode: 'simple',
    composer: createEmptyComposerState(),
    isTrusted: true,
    folders: [{ name: 'workspace', uri: 'file:///tmp/workspace', active: true }],
  });
  assert.deepEqual(
    snapshot.messages.map((message) => message.role),
    [
      'user',
      'assistant',
      'toolResult',
      'bashExecution',
      'custom',
      'branchSummary',
      'compactionSummary',
    ]
  );
});

test('rpc.shape.entries', async () => {
  const harness = createRpcClientHarness([
    {
      entries: [
        {
          id: 'e1',
          parentId: null,
          timestamp: '2024-01-01T00:00:00Z',
          type: 'session_info',
          header: { version: 3, cwd: '/tmp', id: 'sid', parentSession: '/tmp/parent.jsonl' },
        },
      ],
      leafId: 'e1',
    },
    {
      tree: [
        {
          id: 'e1',
          children: [
            { id: 'e2', children: [], label: 'Leaf', labelTimestamp: '2024-01-01T00:01:00Z' },
          ],
        },
      ],
      leafId: 'e2',
    },
  ]);
  const entries = await harness.client.getEntries();
  const tree = await harness.client.getTree();
  assert.equal((entries?.entries as JsonObject[])?.[0]?.type, 'session_info');
  assert.equal((tree?.tree as JsonObject[])?.[0]?.id, 'e1');
  assert.equal(tree?.leafId, 'e2');
});

test('rpc.shape.toolResult', () => {
  let state = createInitialControllerState('workspace', '/tmp/workspace');
  state = reduceEvent(state, {
    type: 'tool_execution_start',
    toolCallId: 'tool-1',
    toolName: 'render',
    args: { path: 'a.ts' },
  } as never);
  state = reduceEvent(state, {
    type: 'tool_execution_update',
    toolCallId: 'tool-1',
    partialResult: { text: 'partial', details: { step: 1 } },
  } as never);
  state = reduceEvent(state, {
    type: 'tool_execution_end',
    toolCallId: 'tool-1',
    result: {
      text: 'final',
      content: [{ type: 'image', mimeType: 'image/png', data: 'abc' }],
      details: { diff: true },
      extra: { bounded: true },
    },
    isError: false,
  } as never);
  assert.deepEqual(state.tools[0]?.partialResult, { text: 'partial', details: { step: 1 } });
  assert.deepEqual(state.tools[0]?.result, {
    text: 'final',
    content: [{ type: 'image', mimeType: 'image/png', data: 'abc' }],
    details: { diff: true },
    extra: { bounded: true },
  });
});

test('rpc.shape.commandData', () => {
  const parsed = parseEnvelope({
    type: 'response',
    id: '3',
    command: 'export_html',
    success: true,
    data: {
      bash: {
        output: 'ok',
        exitCode: null,
        cancelled: true,
        truncated: true,
        fullOutputPath: '/tmp/bash.log',
      },
      compaction: {
        summary: 'Compacted',
        firstKeptEntryId: 'e4',
        tokensBefore: 1200,
        estimatedTokensAfter: null,
      },
      stats: { messageCount: 4, toolCount: 1, cost: 1.2, contextUsage: null },
      fork: { cancelled: false, text: 'seed' },
      commands: [
        {
          name: '/workflow',
          source: 'skill',
          sourceInfo: { path: '/tmp/skill.md', source: 'skill', scope: 'workspace' },
        },
      ],
    },
  });
  assert.equal(parsed.type, 'response');
  assert.equal(parsed.success, true);
  if (parsed.type === 'response' && parsed.success) {
    const data = parsed.data as JsonObject;
    assert.equal((data.bash as JsonObject).truncated, true);
    assert.equal(((data.commands as JsonObject[])[0]?.sourceInfo as JsonObject).source, 'skill');
  }
});

test('rpc.shape.attachment', () => {
  const state = createInitialControllerState('workspace', '/tmp/workspace');
  state.messages = [
    {
      id: 'm1',
      role: 'user',
      content: 'hello',
      attachments: [
        {
          id: 'img1',
          type: 'image',
          fileName: 'photo<script>.jpg',
          name: 'ignored-name.jpg',
          mimeType: 'image/jpeg',
          size: 102400,
          content: 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=',
          extractedText: 'token=super-secret ' + 'x'.repeat(500),
          preview: {
            caption: '<b>Preview</b>',
            uri: 'data:image/png;base64,abcdef',
            path: './docs/photo.jpg',
            width: 640,
            height: 480,
            nested: { html: '<i>unsafe</i>' },
          },
        },
        {
          id: 'img2',
          type: 'image',
          name: 'outside.png',
          mimeType: 'image/png',
          size: 12,
          preview: { filePath: '../outside.png', uri: 'https://example.invalid/remote.png' },
        },
      ],
    },
  ];
  const firstAttachment = (
    (state.messages[0] as JsonObject).attachments as JsonObject[] | undefined
  )?.[0];
  const normalized = normalizeAttachment(firstAttachment, state.cwd);
  assert.equal(normalized?.type, 'image');
  assert.equal(normalized?.name, 'photo<script>.jpg');
  assert.equal(normalized?.mimeType, 'image/jpeg');
  assert.equal(normalized?.size, 102400);
  assert.equal(normalized?.hasContent, true);
  assert.equal(normalized?.extractedText?.includes('[REDACTED]'), true);
  assert.equal(
    normalized?.previewItems.some((item) => item.key === 'caption'),
    true
  );
  assert.equal(
    normalized?.previewItems.find((item) => item.key === 'uri')?.value,
    '[data URI omitted]'
  );
  assert.equal(normalized?.fileRef?.path, 'docs/photo.jpg');

  const composer = createEmptyComposerState();
  composer.pendingImages.push({
    itemId: 'img-1',
    name: 'image.png',
    mimeType: 'image/png',
    sizeBytes: 42,
    inMemoryBase64: 'AAAA',
    previewDataUrl: 'data:image/png;base64,AAAA',
  });
  const snapshot = createWebviewSnapshot(state, 2, {
    uiMode: 'simple',
    composer,
    isTrusted: true,
    folders: [{ name: 'workspace', uri: 'file:///tmp/workspace', active: true }],
  });
  assert.equal(snapshot.pendingImages[0]?.name, 'image.png');
  assert.equal(snapshot.pendingImages[0]?.sizeBytes, 42);
  assert.equal(
    'inMemoryBase64' in (snapshot.pendingImages[0] as unknown as Record<string, unknown>),
    false
  );
  assert.equal(snapshot.messages[0]?.attachments[0]?.id, 'img1');
  assert.equal(snapshot.messages[0]?.attachments[0]?.fileRef?.path, 'docs/photo.jpg');
  assert.equal(snapshot.messages[0]?.attachments[1]?.fileRef, undefined);
  const rendered = JSON.stringify(snapshot.messages[0]?.attachments[0]);
  assert.equal(rendered.includes('QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo='), false);
  assert.equal(rendered.includes('token=super-secret'), false);
  assert.equal(rendered.includes('data:image/png;base64,abcdef'), false);
});

test('validateCoverage rejects wrong source file evidence', () => {
  const output = runValidatorWithMutation((rows) => {
    rows.find((row) => row.id === 'C-001')!.sourceFile = 'src/state/reducer.ts';
  });
  assert.match(output, /missing symbol RpcClient\.prompt in src\/state\/reducer\.ts for C-001/);
});

test('validateCoverage rejects wrong symbol evidence', () => {
  const output = runValidatorWithMutation((rows) => {
    rows.find((row) => row.id === 'E-001')!.symbol = 'reduceSessionUiRequest';
  });
  assert.match(
    output,
    /missing symbol reduceSessionUiRequest in src\/state\/reducer\.ts for E-001/
  );
});

test('validateCoverage rejects wrong test file evidence', () => {
  const output = runValidatorWithMutation((rows) => {
    rows.find((row) => row.id === 'U-001')!.testFile = 'test/unit/package-manifest.test.ts';
  });
  assert.match(
    output,
    /missing literal test title rpc\.ui\.select in test\/unit\/package-manifest\.test\.ts for U-001/
  );
});

test('validateCoverage rejects wrong test title evidence', () => {
  const output = runValidatorWithMutation((rows) => {
    rows.find((row) => row.id === 'D-001')!.testTitle = 'rpc.shape.notState';
  });
  assert.match(
    output,
    /missing literal test title rpc\.shape\.notState in test\/unit\/rpc-coverage\.test\.ts for D-001/
  );
});

test('coverage evidence rows remain unique', () => {
  const ids = new Set<string>();
  for (const row of evidence) {
    assert.equal(ids.has(row.id), false, `duplicate evidence row ${row.id}`);
    ids.add(row.id);
  }
  assert.equal(ids.size, 90);
  const validatorOutput = JSON.parse(
    execFileSync('node', ['./scripts/validateCoverage.mjs'], { encoding: 'utf8' })
  );
  assert.equal(validatorOutput.ok, true);
});

test('coverage evidence points to explicit files and titles', () => {
  const source = readFileSync('docs/RPC_COVERAGE_EVIDENCE.json', 'utf8');
  assert.ok(source.includes('"sourceFile"'));
  assert.ok(source.includes('"testFile"'));
  assert.ok(source.includes('"testTitle"'));
});

test('isJsonValue handles very deeply nested payloads without a stack overflow', () => {
  // Simulates resuming a large session whose message/entry tree is deep.
  let deep: unknown = { leaf: true };
  for (let i = 0; i < 200000; i += 1) {
    deep = { child: deep };
  }
  assert.equal(isJsonValue(deep), true);

  let arr: unknown = [1];
  for (let i = 0; i < 200000; i += 1) {
    arr = [arr];
  }
  assert.equal(isJsonValue(arr), true);

  // parseEnvelope must accept a response whose data is deeply nested.
  const env = parseEnvelope({
    type: 'response',
    id: 'x',
    command: 'get_tree',
    success: true,
    data: deep,
  });
  assert.equal(env.type, 'response');
});

test('isJsonValue still rejects non-JSON values', () => {
  assert.equal(
    isJsonValue(() => 1),
    false
  );
  assert.equal(isJsonValue(undefined), false);
  assert.equal(isJsonValue([1, undefined]), false);
  assert.equal(isJsonValue({ a: 1, b: 'x', c: [true, null] }), true);
});
