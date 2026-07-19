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
