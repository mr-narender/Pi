import test from 'node:test';
import assert from 'node:assert/strict';
import { renderChatApp } from '../../src/webview/render';
import type { WebviewSnapshot } from '../../src/state/types';

function snapshot(overrides: Partial<WebviewSnapshot> = {}): WebviewSnapshot {
  return {
    sequence: 1,
    title: 'Pi RPC Chat',
    connectionState: 'ready',
    workspaceFolderName: 'workspace',
    sessionName: 'Demo Session',
    sessionId: 'sid',
    sessionFile: '/tmp/workspace/session.jsonl',
    isStreaming: false,
    isCompacting: false,
    messageCount: 2,
    pendingMessageCount: 1,
    messages: [
      { id: 'm1', role: 'user', text: 'hello', attachments: [] },
      { id: 'm2', role: 'assistant', text: 'hi', attachments: [] },
    ],
    queue: { steering: ['one'], followUp: [] },
    draft: 'draft',
    statuses: { mode: 'active' },
    widgets: [],
    model: { provider: 'mock', id: 'model' },
    thinkingLevel: 'medium',
    pendingImages: [],
    isTrusted: true,
    folders: [{ name: 'workspace', uri: 'file:///tmp/workspace', active: true }],
    ...overrides,
  };
}

test('renderChatApp includes semantic header, session summary, and primary actions', () => {
  const html = renderChatApp(snapshot());
  assert.match(html, /role="banner"/);
  assert.match(html, /aria-label="Current session summary"/);
  assert.match(html, /Start Pi/);
  assert.match(html, /New Session/);
  assert.match(html, /Resume Session/);
  assert.match(html, /Ask Pi/);
  assert.match(html, /Conversation/);
});

test('renderChatApp exposes empty and restricted states without losing accessibility labels', () => {
  const html = renderChatApp(
    snapshot({
      isTrusted: false,
      messages: [],
      pendingImages: [{ name: 'diagram.png', mimeType: 'image/png', size: 42 }],
    })
  );
  assert.match(html, /Restricted mode/);
  assert.match(html, /No messages yet/);
  assert.match(html, /diagram\.png/);
  assert.match(html, /aria-label="Primary chat actions"/);
  assert.match(html, /aria-label="Active workspace folder"/);
});
