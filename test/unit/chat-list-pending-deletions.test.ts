import assert from 'node:assert/strict';
import test from 'node:test';
import { applyPendingDeletions, type ChatListModel } from '../../src/webview/chatListShared';

function modelWith(sessionPaths: string[]): ChatListModel {
  return {
    loading: false,
    rows: sessionPaths.map((path) => ({
      id: `recent:${path}`,
      title: path,
      active: false,
      isOpen: false,
      openCommand: { sessionPath: path },
      sessionPath: path,
    })),
  };
}

test('applyPendingDeletions: hides a row whose deletion is pending and not yet reflected by the real data', () => {
  const model = modelWith(['/s/a.jsonl', '/s/b.jsonl']);
  const { rows, stillPending } = applyPendingDeletions(
    model,
    [{ id: '/s/a.jsonl', startedAt: 1000 }],
    1100
  );
  assert.deepEqual(
    rows.map((r) => r.sessionPath),
    ['/s/b.jsonl']
  );
  assert.deepEqual(stillPending, [{ id: '/s/a.jsonl', startedAt: 1000 }]);
});

test('applyPendingDeletions: stops tracking once the real data confirms it is actually gone', () => {
  // The row is no longer in the model at all — the rescan caught up.
  const model = modelWith(['/s/b.jsonl']);
  const { rows, stillPending } = applyPendingDeletions(
    model,
    [{ id: '/s/a.jsonl', startedAt: 1000 }],
    1100
  );
  assert.deepEqual(
    rows.map((r) => r.sessionPath),
    ['/s/b.jsonl']
  );
  assert.deepEqual(stillPending, []);
});

test('applyPendingDeletions: gives up hiding after the timeout — a failed delete must not vanish forever', () => {
  const model = modelWith(['/s/a.jsonl']);
  const { rows, stillPending } = applyPendingDeletions(
    model,
    [{ id: '/s/a.jsonl', startedAt: 1000 }],
    1000 + 5001,
    5000
  );
  assert.deepEqual(
    rows.map((r) => r.sessionPath),
    ['/s/a.jsonl']
  );
  assert.deepEqual(stillPending, []);
});

test('applyPendingDeletions: also matches on an open-chat resource (no session file yet)', () => {
  const model: ChatListModel = {
    loading: false,
    rows: [
      {
        id: 'open:a',
        title: 'A',
        active: true,
        isOpen: true,
        openCommand: { resource: 'piRpcChat://a' },
      },
      {
        id: 'open:b',
        title: 'B',
        active: false,
        isOpen: true,
        openCommand: { resource: 'piRpcChat://b' },
      },
    ],
  };
  const { rows } = applyPendingDeletions(model, [{ id: 'piRpcChat://a', startedAt: 0 }], 10);
  assert.deepEqual(
    rows.map((r) => r.id),
    ['open:b']
  );
});

test('applyPendingDeletions: no pending deletions is a no-op (same rows reference)', () => {
  const model = modelWith(['/s/a.jsonl']);
  const { rows, stillPending } = applyPendingDeletions(model, [], 0);
  assert.equal(rows, model.rows);
  assert.deepEqual(stillPending, []);
});
