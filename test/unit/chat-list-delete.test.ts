import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDeleteMessage, type ChatListRow } from '../../src/webview/chatListShared';

function row(overrides: Partial<ChatListRow> = {}): ChatListRow {
  return {
    id: 'open:a',
    title: 'Test chat',
    active: false,
    isOpen: true,
    openCommand: { resource: 'piRpcChat://a' },
    ...overrides,
  };
}

test('buildDeleteMessage: a chat with a session file deletes by sessionPath', () => {
  const message = buildDeleteMessage(row({ sessionPath: '/s/a.jsonl' }));
  assert.deepEqual(message, { type: 'deleteChat', sessionPath: '/s/a.jsonl' });
});

test('buildDeleteMessage: an OPEN chat with no session file yet (fresh draft) closes by resource — the actual reported bug', () => {
  const message = buildDeleteMessage(
    row({ sessionPath: undefined, isOpen: true, openCommand: { resource: 'piRpcChat://draft' } })
  );
  assert.deepEqual(message, { type: 'deleteChat', resource: 'piRpcChat://draft' });
});

test('buildDeleteMessage: sessionPath wins over resource when both are present', () => {
  const message = buildDeleteMessage(
    row({ sessionPath: '/s/a.jsonl', isOpen: true, openCommand: { resource: 'piRpcChat://a' } })
  );
  assert.deepEqual(message, { type: 'deleteChat', sessionPath: '/s/a.jsonl' });
});

test('buildDeleteMessage: neither open nor a session file — nothing to delete, no message', () => {
  const message = buildDeleteMessage(
    row({ sessionPath: undefined, isOpen: false, openCommand: {} })
  );
  assert.equal(message, undefined);
});
