import assert from 'node:assert/strict';
import test from 'node:test';
import { applyPendingDeletions, type ChatListModel } from '../../src/webview/chatListShared';

function modelWith(sessionPaths: string[], loading = false): ChatListModel {
  return {
    loading,
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

test('pending deletion hides a session throughout a slow scan until the operation resolves', () => {
  const pending = [{ id: '/s/a.jsonl' }];
  for (const loading of [false, true]) {
    const rows = applyPendingDeletions(modelWith(['/s/a.jsonl', '/s/b.jsonl'], loading), pending);
    assert.deepEqual(
      rows.map((row) => row.sessionPath),
      ['/s/b.jsonl']
    );
  }
  assert.deepEqual(pending, [{ id: '/s/a.jsonl' }], 'a loading snapshot cannot clear the deletion');
});

test('pending deletion also hides an unsaved draft by resource and never times out', () => {
  const model: ChatListModel = {
    loading: false,
    rows: [
      {
        id: 'open:a',
        title: 'A',
        active: true,
        isOpen: true,
        openCommand: { resource: 'pi-chat:a' },
      },
      {
        id: 'open:b',
        title: 'B',
        active: false,
        isOpen: true,
        openCommand: { resource: 'pi-chat:b' },
      },
    ],
  };
  assert.deepEqual(
    applyPendingDeletions(model, [{ id: 'pi-chat:a' }]).map((row) => row.id),
    ['open:b']
  );
  assert.equal(applyPendingDeletions(model, []), model.rows);
});
