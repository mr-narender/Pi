import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import type { JsonObject, JsonValue } from '../../src/rpc/protocol';
import { createInitialControllerState, type ToolRunState } from '../../src/state/types';
import { reduceEvent } from '../../src/state/reducer';
import { createEmptyComposerState } from '../../src/webview/composer';
import { createWebviewSnapshot } from '../../src/webview/model';
import { renderChatApp } from '../../src/webview/render';

function project(messages: JsonObject[], tools: ToolRunState[] = []) {
  const state = createInitialControllerState('workspace', '/tmp/workspace');
  state.connectionState = 'ready';
  state.messages = messages;
  state.tools = tools;
  return createWebviewSnapshot(state, 1, {
    composer: createEmptyComposerState(),
    isTrusted: true,
    folders: [],
  });
}

function transcript(durationMs?: JsonValue): JsonObject[] {
  return [
    {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'call', name: 'read', arguments: { path: 'a.ts' } }],
    },
    {
      role: 'toolResult',
      toolCallId: 'call',
      content: [{ type: 'text', text: 'file' }],
      durationMs,
    },
  ];
}

test('Pi assistant duration survives projection and renders its native elapsed time', () => {
  const snapshot = project([
    { role: 'assistant', content: [{ type: 'text', text: 'Done' }], durationMs: 2345 },
  ]);
  assert.equal(snapshot.messages[0]?.durationMs, 2345);
  const document = new JSDOM(renderChatApp(snapshot)).window.document;
  const duration = document.querySelector('.assistant-turn > .message-role .native-duration');
  assert.equal(duration?.textContent, '2.3 s');
  assert.equal(duration?.getAttribute('data-duration-ms'), '2345');
  assert.match(duration?.getAttribute('aria-label') ?? '', /Assistant generation time/);
});

test('persisted tool timing survives folding and displays zero as a real duration', () => {
  const snapshot = project(transcript(0));
  const result = snapshot.messages[0]?.blocks?.find((block) => block.kind === 'toolResult');
  assert.equal(result?.durationMs, 0);
  const document = new JSDOM(renderChatApp(snapshot)).window.document;
  assert.equal(document.querySelector('.tl-tool .native-duration')?.textContent, '0 ms');
  assert.equal(document.querySelectorAll('.tl-tool .native-duration').length, 1);
});

test('live tool timing fills an absent result duration by call identity', () => {
  const snapshot = project(transcript(), [
    { id: 'call', name: 'read', startedAt: 100, endedAt: 9999, durationMs: 42 },
  ]);
  const result = snapshot.messages[0]?.blocks?.find((block) => block.kind === 'toolResult');
  assert.equal(result?.durationMs, 42);
  assert.match(renderChatApp(snapshot), /data-duration-ms="42"/);
  const historical = project(transcript());
  assert.doesNotMatch(renderChatApp(historical), /native-duration/);
});

test('persisted native timing wins over live timing and timestamp differences', () => {
  const snapshot = project(transcript(12.5), [
    { id: 'call', name: 'read', startedAt: 100, endedAt: 9999, durationMs: 42 },
  ]);
  assert.equal(
    snapshot.messages[0]?.blocks?.find((block) => block.kind === 'toolResult')?.durationMs,
    12.5
  );
});

test('distinct call and result times retain one badge and both original values in the trace', () => {
  const snapshot = project(transcript(12.5));
  const call = snapshot.messages[0]?.blocks?.find((block) => block.kind === 'tool');
  assert.ok(call);
  call.durationMs = 7;
  const document = new JSDOM(renderChatApp(snapshot)).window.document;
  const tool = document.querySelector('.tl-tool')!;
  assert.equal(tool.querySelectorAll('.native-duration').length, 1);
  assert.equal(tool.querySelector('.native-duration')?.getAttribute('data-duration-ms'), '12.5');
  assert.match(
    tool.querySelector('.native-duration')?.getAttribute('aria-label') ?? '',
    /Tool execution time/
  );
  assert.match(
    tool.querySelector('.activity-record')!.textContent!,
    /Call execution time: 7 ms · Result execution time: 12.5 ms/
  );
});

test('invalid or missing duration never invents assistant or tool elapsed time', () => {
  for (const durationMs of [undefined, -1, Number.NaN, Number.POSITIVE_INFINITY, '42']) {
    const snapshot = project(
      [
        { role: 'assistant', content: [{ type: 'text', text: 'Done' }], durationMs },
        ...transcript(durationMs),
      ],
      [{ id: 'different-call', name: 'read', startedAt: 100, endedAt: 9999, durationMs: 42 }]
    );
    assert.equal(snapshot.messages[0]?.durationMs, undefined);
    assert.doesNotMatch(renderChatApp(snapshot), /native-duration/);
  }
});

test('zero assistant duration remains visible and invalid projected values remain hidden', () => {
  const snapshot = project([
    { role: 'assistant', content: [{ type: 'text', text: 'Done' }], durationMs: 0 },
  ]);
  assert.match(renderChatApp(snapshot), /data-duration-ms="0"/);
  snapshot.messages[0]!.durationMs = Number.NaN;
  assert.doesNotMatch(renderChatApp(snapshot), /native-duration/);
});

test('completed live calls display native timing before a result message arrives', () => {
  const snapshot = project(transcript().slice(0, 1), [
    { id: 'call', name: 'read', startedAt: 100, endedAt: 9999, durationMs: 100 },
  ]);
  const document = new JSDOM(renderChatApp(snapshot)).window.document;
  assert.equal(document.querySelector('.tl-tool .native-duration')?.textContent, '100 ms');
});

test('standalone tool results display native timing without an owning assistant', () => {
  const snapshot = project([
    { role: 'toolResult', content: [{ type: 'text', text: 'Done' }], durationMs: 100 },
  ]);
  assert.match(renderChatApp(snapshot), /data-duration-ms="100"/);
});

test('native end-event timing projects before result arrival and persists after reload', () => {
  let state = createInitialControllerState('workspace', '/tmp/workspace');
  state.messages = transcript().slice(0, 1);
  state = reduceEvent(state, {
    type: 'tool_execution_start',
    toolCallId: 'call',
    toolName: 'read',
    args: {},
  });
  state = reduceEvent(state, {
    type: 'tool_execution_end',
    toolCallId: 'call',
    result: {},
    isError: false,
    durationMs: 0,
  });
  assert.equal(state.tools[0]?.durationMs, 0);
  assert.match(renderChatApp(project(state.messages, state.tools)), /data-duration-ms="0"/);
  state = reduceEvent(state, { type: 'message_end', message: transcript(0)[1]! });
  const loaded = project(state.messages);
  const document = new JSDOM(renderChatApp(loaded)).window.document;
  assert.equal(document.querySelectorAll('.tl-tool .native-duration').length, 1);
  assert.equal(document.querySelector('.tl-tool .native-duration')?.textContent, '0 ms');
});

test('invalid end-event timing never becomes a live elapsed estimate', () => {
  for (const durationMs of [undefined, -1, Number.NaN, Number.POSITIVE_INFINITY, '42']) {
    let state = createInitialControllerState('workspace', '/tmp/workspace');
    state.messages = transcript().slice(0, 1);
    state = reduceEvent(state, {
      type: 'tool_execution_start',
      toolCallId: 'call',
      toolName: 'read',
      args: {},
    });
    state = reduceEvent(state, {
      type: 'tool_execution_end',
      toolCallId: 'call',
      result: {},
      isError: false,
      durationMs,
    });
    assert.equal(state.tools[0]?.durationMs, undefined);
    assert.doesNotMatch(renderChatApp(project(state.messages, state.tools)), /native-duration/);
  }
});
