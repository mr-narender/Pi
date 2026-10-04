// Stage D: the context-fill gauge coloring is part of renderChatApp's status
// chip — assert the class thresholds through the real renderer.
import assert from 'node:assert/strict';
import test from 'node:test';
import { renderChatApp } from '../../src/webview/render';
import type { WebviewSnapshot } from '../../src/state/types';

function snapshot(percent?: number): WebviewSnapshot {
  return {
    sequence: 1,
    title: 'Current Chat',
    bindingState: 'current',
    connectionState: 'ready',
    workspaceFolderName: 'workspace',
    sessionName: 'Demo Session',
    sessionId: 'sid',
    sessionFile: '/tmp/workspace/session.jsonl',
    isStreaming: false,
    isCompacting: false,
    messageCount: 2,
    pendingMessageCount: 0,
    messages: [],
    queue: { steering: [], followUp: [] },
    draft: '',
    statuses: {},
    widgets: [],
    model: { provider: 'mock', id: 'model' },
    thinkingLevel: 'medium',
    pendingContextItems: [],
    pendingImages: [],
    focus: 'composer',
    isTrusted: true,
    folders: [{ name: 'workspace', uri: 'file:///tmp/workspace', active: true }],
    ...(percent === undefined ? {} : { usage: { totalTokens: 1000, contextPercent: percent } }),
  } as WebviewSnapshot;
}

test('usage gauge: <70% plain, >=70% warn, >=85% hot', () => {
  const plain = renderChatApp(snapshot(45));
  assert.ok(
    plain.includes('usage-part') && !plain.includes('usage-warn') && !plain.includes('usage-hot')
  );
  const warn = renderChatApp(snapshot(75));
  assert.ok(warn.includes('usage-part usage-warn'));
  assert.ok(warn.includes('context 75% full'));
  const hot = renderChatApp(snapshot(91));
  assert.ok(hot.includes('usage-part usage-hot'));
});

test('usage gauge: absent usage renders no gauge span and no context title fragment', () => {
  const html = renderChatApp(snapshot(undefined));
  assert.ok(!html.includes('usage-part'));
  assert.ok(!html.includes('context ') || !html.includes('% full'));
});
