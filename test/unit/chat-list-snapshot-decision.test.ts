import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decideSnapshotPush,
  type ChatListModel,
  type SnapshotDecisionState,
} from '../../src/webview/chatListShared';

const rows: ChatListModel['rows'] = [
  { id: 'open:a', title: 'Alpha', active: true, isOpen: true, openCommand: { resource: 'a' } },
];

test('decideSnapshotPush: true first-ever load (nothing shown yet) is pushed', () => {
  const state: SnapshotDecisionState = { hasShownRealData: false };
  const decision = decideSnapshotPush({ rows: [], loading: true }, state);
  assert.equal(decision.push, true);
  assert.equal(decision.hasShownRealData, false);
});

test('decideSnapshotPush: a loading tick AFTER real data has shown is suppressed (the reload-flash bug)', () => {
  // Simulates: real rows already rendered, then recentSessions.refresh()
  // fires its intermediate loading:true event (e.g. from opening a Recent
  // chat, which calls refresh() explicitly) — this used to blank the whole
  // list to "Loading chats…" and back, which read as "the list reloaded".
  const afterFirstLoad = decideSnapshotPush({ rows, loading: false }, { hasShownRealData: false });
  assert.equal(afterFirstLoad.push, true);
  assert.equal(afterFirstLoad.hasShownRealData, true);

  const duringRefresh = decideSnapshotPush(
    { rows: [], loading: true },
    { lastIdentity: afterFirstLoad.lastIdentity, hasShownRealData: true }
  );
  assert.equal(duringRefresh.push, false, 'loading tick after real data must not blank the list');
  assert.equal(duringRefresh.hasShownRealData, true);
});

test('decideSnapshotPush: identical rows are not re-pushed (stable-identity diff)', () => {
  const first = decideSnapshotPush({ rows, loading: false }, { hasShownRealData: false });
  const second = decideSnapshotPush({ rows, loading: false }, first);
  assert.equal(second.push, false);
});

test('decideSnapshotPush: a genuine row change (active flag flips) is pushed', () => {
  const first = decideSnapshotPush({ rows, loading: false }, { hasShownRealData: false });
  const changed: ChatListModel['rows'] = [{ ...rows[0]!, active: false }];
  const second = decideSnapshotPush({ rows: changed, loading: false }, first);
  assert.equal(second.push, true);
});

test('decideSnapshotPush: once real data has shown, an error state still pushes (not swallowed like loading is)', () => {
  const first = decideSnapshotPush({ rows, loading: false }, { hasShownRealData: false });
  const errored = decideSnapshotPush({ rows: [], loading: false, error: 'boom' }, first);
  assert.equal(errored.push, true);
});

test('decideSnapshotPush: a favorite flip or title change (same ids) is pushed', () => {
  const first = decideSnapshotPush({ rows, loading: false }, { hasShownRealData: false });
  const starred = decideSnapshotPush(
    { rows: [{ ...rows[0]!, favorite: true }], loading: false },
    first
  );
  assert.equal(starred.push, true, 'favorite flip must re-push');
  const renamed = decideSnapshotPush(
    { rows: [{ ...rows[0]!, title: 'fix the login redirect bug' }], loading: false },
    first
  );
  assert.equal(renamed.push, true, 'title change (rename / late preview) must re-push');
});
