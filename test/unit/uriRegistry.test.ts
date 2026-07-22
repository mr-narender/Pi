import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chatShortId,
  chatPathFor,
  initChatUriRegistry,
  rememberChatUri,
  lookupChatUri,
  __resetChatUriRegistry,
} from '../../src/editorTabs/uriRegistry';
import type { ChatTabTarget } from '../../src/editorTabs/uriContract';

function fakeMemento() {
  const data = new Map<string, unknown>();
  return {
    data,
    get<T>(key: string, def: T): T {
      return (data.has(key) ? (data.get(key) as T) : def) as T;
    },
    update(key: string, value: unknown): Promise<void> {
      data.set(key, value);
      return Promise.resolve();
    },
  };
}

const sessionTarget: ChatTabTarget = {
  workspaceFolderUri: 'file:///Users/x/proj',
  kind: 'sessionFile',
  sessionFile: '/Users/x/.pi/agent/sessions/--Users-x-proj--/2026-07-19T03-37_019f7872.jsonl',
};
const draftTarget: ChatTabTarget = {
  workspaceFolderUri: 'file:///Users/x/proj',
  kind: 'workspaceDraft',
};

test.beforeEach(() => __resetChatUriRegistry());

test('chatShortId is deterministic and identity-specific', () => {
  assert.equal(chatShortId(sessionTarget), chatShortId({ ...sessionTarget }));
  assert.notEqual(chatShortId(sessionTarget), chatShortId(draftTarget));
  assert.match(chatShortId(sessionTarget), /^[0-9a-f]{10}$/);
});

test('chatPathFor is short, clean, and space-free (no path-encoding edge cases)', () => {
  const path = chatPathFor(sessionTarget);
  assert.match(path, /^\/chat-[0-9a-f]{10}\.chat$/);
  assert.equal(path.includes(' '), false);
  assert.equal(path.includes('Users'), false);
  assert.equal(path.includes('.pi'), false);
  assert.match(chatPathFor(draftTarget), /^\/new-chat-[0-9a-f]{10}\.chat$/);
});

test('remember then lookup round-trips the full identity', () => {
  const path = chatPathFor(sessionTarget);
  assert.equal(lookupChatUri(path), undefined);
  rememberChatUri(path, sessionTarget);
  assert.deepEqual(lookupChatUri(path), sessionTarget);
});

test('mappings survive restore: rehydrate from persisted memento', () => {
  const memento = fakeMemento();
  initChatUriRegistry(memento);
  const path = chatPathFor(sessionTarget);
  rememberChatUri(path, sessionTarget);
  assert.ok(memento.data.get('piRpc.chatUriMap'), 'mapping should be persisted');

  // Simulate a fresh window (new in-memory store) that rehydrates from state.
  __resetChatUriRegistry();
  assert.equal(lookupChatUri(path), undefined);
  initChatUriRegistry(memento);
  assert.deepEqual(lookupChatUri(path), sessionTarget);
});

test('different sessions map to distinct short paths', () => {
  const a = chatPathFor(sessionTarget);
  const b = chatPathFor({
    ...sessionTarget,
    sessionFile: '/Users/x/.pi/agent/sessions/--Users-x-proj--/2026-07-19T03-40_aaaa.jsonl',
  });
  assert.notEqual(a, b);
});
