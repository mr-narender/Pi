import test from 'node:test';
import assert from 'node:assert/strict';
import { reduceEvent } from '../../src/state/reducer';
import { createInitialControllerState } from '../../src/state/types';
import type { RpcEvent } from '../../src/rpc/protocol';

function ev(value: Record<string, unknown>): RpcEvent {
  return value as unknown as RpcEvent;
}

// Pi RPC messages have no `id`. One streaming turn emits message_start, many
// message_update deltas, message_end, turn_end, and agent_end all carrying the
// SAME assistant message (stable timestamp). These must collapse into a single
// transcript bubble, not one per event/delta.
test('a single streaming turn yields exactly one assistant message', () => {
  let state = createInitialControllerState('w', '/tmp');
  const ts = 1_733_000_000_000;
  const base = { role: 'assistant', timestamp: ts, content: [] };

  state = reduceEvent(state, ev({ type: 'message_start', message: { ...base } }));
  state = reduceEvent(
    state,
    ev({
      type: 'message_update',
      message: { ...base },
      assistantMessageEvent: { type: 'text_start', contentIndex: 0, partial: {} },
    })
  );
  state = reduceEvent(
    state,
    ev({
      type: 'message_update',
      message: { ...base },
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Hel', partial: {} },
    })
  );
  state = reduceEvent(
    state,
    ev({
      type: 'message_update',
      message: { ...base },
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'lo', partial: {} },
    })
  );
  const finalMessage = {
    role: 'assistant',
    timestamp: ts,
    content: [{ type: 'text', text: 'Hello' }],
    stopReason: 'stop',
  };
  state = reduceEvent(state, ev({ type: 'message_end', message: finalMessage }));
  state = reduceEvent(state, ev({ type: 'turn_end', message: finalMessage, toolResults: [] }));
  state = reduceEvent(state, ev({ type: 'agent_end', messages: [finalMessage] }));

  assert.equal(state.messages.length, 1);
  assert.equal(state.messages[0]?.role, 'assistant');
  assert.deepEqual(state.messages[0]?.content, [{ type: 'text', text: 'Hello' }]);
});

test('distinct user and assistant messages in one turn are not merged', () => {
  let state = createInitialControllerState('w', '/tmp');
  const user = { role: 'user', timestamp: 1_733_000_000_000, content: 'Hi' };
  const assistant = {
    role: 'assistant',
    timestamp: 1_733_000_000_500,
    content: [{ type: 'text', text: 'Hello' }],
  };
  state = reduceEvent(state, ev({ type: 'message_start', message: user }));
  state = reduceEvent(state, ev({ type: 'message_start', message: assistant }));
  state = reduceEvent(state, ev({ type: 'agent_end', messages: [user, assistant] }));
  assert.equal(state.messages.length, 2);
});

// Pi 0.84 streams DELTA-ONLY message_update events (no `message` field). The
// reducer must still accumulate text onto the streaming assistant message.
test('delta-only message_update (Pi 0.84) accumulates assistant text', () => {
  let state = createInitialControllerState('w', '/tmp');
  state = reduceEvent(
    state,
    ev({ type: 'message_start', message: { role: 'assistant', timestamp: 42, content: [] } })
  );
  state = reduceEvent(
    state,
    ev({ type: 'message_update', assistantMessageEvent: { type: 'text_start', contentIndex: 0 } })
  );
  state = reduceEvent(
    state,
    ev({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Hello' },
    })
  );
  state = reduceEvent(
    state,
    ev({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: ' world' },
    })
  );
  const assistants = state.messages.filter((m) => (m as { role?: string }).role === 'assistant');
  assert.equal(assistants.length, 1);
  const content = (assistants[0] as { content?: Array<{ type?: string; text?: string }> }).content;
  assert.equal(content?.[0]?.text, 'Hello world');
});

// A turn that finishes with agent_end (but no agent_settled — e.g. post-turn
// memory/qmd work delays it) must still release the UI to 'ready' so the
// "Working…" banner clears, sends aren't queued, and the input clears.
test('agent_end releases connectionState to ready without agent_settled', () => {
  let state = createInitialControllerState('w', '/tmp');
  state = reduceEvent(state, ev({ type: 'agent_start' }));
  state = reduceEvent(state, ev({ type: 'turn_start' }));
  assert.equal(state.connectionState, 'busy');
  state = reduceEvent(
    state,
    ev({ type: 'turn_end', message: { role: 'assistant', timestamp: 1 } })
  );
  state = reduceEvent(state, ev({ type: 'agent_end', messages: [] }));
  assert.equal(state.connectionState, 'ready');
  assert.equal(state.state.isStreaming, false);
});

// While compacting, agent_end must stay busy (compaction is still running).
test('agent_end stays busy while compacting', () => {
  let state = createInitialControllerState('w', '/tmp');
  state = reduceEvent(state, ev({ type: 'compaction_start' }));
  assert.equal(state.state.isCompacting, true);
  state = reduceEvent(state, ev({ type: 'agent_end', messages: [] }));
  assert.equal(state.connectionState, 'busy');
});
