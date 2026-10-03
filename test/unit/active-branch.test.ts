import test from 'node:test';
import assert from 'node:assert/strict';
import { selectActiveBranchMessages } from '../../src/sessions/activeBranch';

function msg(role: string, text: string) {
  return { role, content: [{ type: 'text', text }] };
}

test('returns only the active branch after a fork (dropped branch not resurrected)', () => {
  // Linear: u1 -> a1 -> u2(PING) -> a2  then FORK at u1 creates u2b(KNOCK) -> a2b.
  const records = [
    { type: 'session', version: 3 },
    { type: 'message', id: 'u1', parentId: null, message: msg('user', 'hello') },
    { type: 'message', id: 'a1', parentId: 'u1', message: msg('assistant', 'hi') },
    { type: 'message', id: 'u2', parentId: 'a1', message: msg('user', 'PING') },
    { type: 'message', id: 'a2', parentId: 'u2', message: msg('assistant', 'pong') },
    // forked branch off a1 — this is the ACTIVE tip (written last)
    { type: 'message', id: 'u2b', parentId: 'a1', message: msg('user', 'KNOCK') },
    { type: 'message', id: 'a2b', parentId: 'u2b', message: msg('assistant', 'who') },
  ];
  const out = selectActiveBranchMessages<{ role: string; content: { text: string }[] }>(records);
  const texts = out.map((m) => m.content[0]?.text);
  assert.deepEqual(texts, ['hello', 'hi', 'KNOCK', 'who']);
  assert.ok(!texts.includes('PING'), 'dropped branch must not appear');
});

test('non-message entries (model_change) are traversed but not included', () => {
  const records = [
    { type: 'message', id: 'u1', parentId: null, message: msg('user', 'a') },
    { type: 'model_change', id: 'mc', parentId: 'u1', provider: 'anthropic', modelId: 'x' },
    { type: 'message', id: 'a1', parentId: 'mc', message: msg('assistant', 'b') },
  ];
  const out = selectActiveBranchMessages<{ role: string; content: { text: string }[] }>(records);
  assert.deepEqual(
    out.map((m) => m.content[0]?.text),
    ['a', 'b']
  );
});

test('legacy v1 sessions (no id/parentId) fall back to linear order', () => {
  const records = [
    { type: 'message', message: msg('user', 'one') },
    { type: 'message', message: msg('assistant', 'two') },
  ];
  const out = selectActiveBranchMessages<{ role: string; content: { text: string }[] }>(records);
  assert.deepEqual(
    out.map((m) => m.content[0]?.text),
    ['one', 'two']
  );
});

test('limit keeps the most recent messages', () => {
  const records = [
    { type: 'message', id: 'a', parentId: null, message: msg('user', '1') },
    { type: 'message', id: 'b', parentId: 'a', message: msg('assistant', '2') },
    { type: 'message', id: 'c', parentId: 'b', message: msg('user', '3') },
  ];
  const out = selectActiveBranchMessages<{ role: string; content: { text: string }[] }>(records, 2);
  assert.deepEqual(
    out.map((m) => m.content[0]?.text),
    ['2', '3']
  );
});
