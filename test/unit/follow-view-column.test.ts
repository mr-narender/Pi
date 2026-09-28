import assert from 'node:assert/strict';
import test from 'node:test';
import { chooseFollowViewColumn } from '../../src/live/followViewColumn';

test('chooseFollowViewColumn: active group is a normal files group — open right there (unchanged behavior)', () => {
  assert.deepEqual(chooseFollowViewColumn(false, []), { kind: 'active' });
});

test('chooseFollowViewColumn: the real bug case — chat owns the ONLY group, single-group layout', () => {
  // No other groups exist at all — must create one beside the chat rather
  // than give up. Before the fix, this exact case (the common, default
  // single-group layout) silently skipped opening anything.
  assert.deepEqual(chooseFollowViewColumn(true, []), { kind: 'beside' });
});

test('chooseFollowViewColumn: chat owns the active group, but a normal files group already exists — reuse it', () => {
  assert.deepEqual(chooseFollowViewColumn(true, [{ isChatOwned: false }]), {
    kind: 'reuse',
    groupIndex: 0,
  });
});

test('chooseFollowViewColumn: chat owns the active group AND every other group is also chat-owned — beside, not reuse', () => {
  assert.deepEqual(
    chooseFollowViewColumn(true, [{ isChatOwned: true }, { isChatOwned: true }]),
    { kind: 'beside' }
  );
});

test('chooseFollowViewColumn: picks the FIRST reusable non-chat group when several groups exist', () => {
  assert.deepEqual(
    chooseFollowViewColumn(true, [{ isChatOwned: true }, { isChatOwned: false }, { isChatOwned: false }]),
    { kind: 'reuse', groupIndex: 1 }
  );
});
