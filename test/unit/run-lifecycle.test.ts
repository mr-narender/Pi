import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialControllerState } from '../../src/state/types';
import { reduceEvent } from '../../src/state/reducer';
import { createWebviewSnapshot } from '../../src/webview/model';
import { renderChatApp } from '../../src/webview/render';
import { createEmptyComposerState } from '../../src/webview/composer';

test('agent_end and automatic retry keep runtime working until settled while composer stays available', () => {
  let state = reduceEvent(createInitialControllerState('owned', '/owned'), { type: 'agent_start' });
  state = reduceEvent(state, { type: 'agent_end', messages: [], willRetry: true });
  assert.equal(state.connectionState, 'busy');
  assert.notEqual(state.runOutcome, 'completed');
  state = reduceEvent(state, { type: 'auto_retry_start', attempt: 1 });
  state = reduceEvent(state, { type: 'auto_retry_end', success: true });
  assert.equal(state.connectionState, 'busy');
  const snapshot = createWebviewSnapshot(state, 1, {
    composer: { ...createEmptyComposerState(), draft: 'steer this task' },
    isTrusted: true,
    folders: [],
  });
  const html = renderChatApp(snapshot);
  assert.match(html, /steer this task/);
  assert.match(html, /data-send-command="steer"/);
  assert.match(html, /data-send-command="follow_up"/);
  assert.doesNotMatch(html, /<textarea[^>]*disabled/);
  state = reduceEvent(state, { type: 'agent_settled', aborted: false });
  assert.equal(state.runOutcome, 'completed');
  assert.equal(state.connectionState, 'ready');
});

test('aborted and failed runs never become successful completion', () => {
  const running = reduceEvent(createInitialControllerState('owned', '/owned'), {
    type: 'agent_start',
  });
  assert.equal(
    reduceEvent(running, { type: 'agent_settled', aborted: true }).runOutcome,
    'aborted'
  );
  let failed = reduceEvent(running, {
    type: 'message_end',
    message: { role: 'assistant', stopReason: 'error', content: [] },
  });
  failed = reduceEvent(failed, { type: 'agent_end', messages: [], willRetry: false });
  assert.equal(reduceEvent(failed, { type: 'agent_settled', aborted: false }).runOutcome, 'failed');
  const reservedAbort = { ...running, runOutcome: 'aborted' as const };
  assert.equal(reduceEvent(reservedAbort, { type: 'agent_settled' }).runOutcome, 'aborted');
});

test('an earlier failed history message does not poison a subsequent successful run', () => {
  const state = {
    ...createInitialControllerState('owned', '/owned'),
    messages: [{ role: 'assistant', stopReason: 'error' }],
  };
  const running = reduceEvent(state, { type: 'agent_start' });
  assert.equal(
    reduceEvent(running, { type: 'agent_settled', aborted: false }).runOutcome,
    'completed'
  );
});
