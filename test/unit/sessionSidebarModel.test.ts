import test from 'node:test';
import assert from 'node:assert/strict';
import { createOpenChatListModel } from '../../src/ui/trees/sessionSidebarModel';

const baseRecent = { loading: false, filterText: '', items: [] };

test('leads with New Chat even with nothing else to show', () => {
  const model = createOpenChatListModel({ openChats: [], recent: baseRecent });
  assert.equal(model[0]?.label, 'New Chat');
  assert.equal(model[0]?.command?.command, 'piRpc.newSession');
  assert.equal(model[1]?.label, 'No chats yet');
});

test('open chats are listed flat (no section header), active one marked with check-icon', () => {
  const model = createOpenChatListModel({
    openChats: [
      { resource: 'pi-chat:/a', title: 'Fix auth bug', sessionFile: '/s/a.jsonl', active: true },
      { resource: 'pi-chat:/b', title: 'Refactor sidebar', sessionFile: '/s/b.jsonl', active: false },
    ],
    recent: baseRecent,
  });
  assert.equal(model[0]?.label, 'New Chat');
  assert.equal(model[1]?.label, 'Fix auth bug');
  assert.equal(model[1]?.icon, 'check');
  assert.equal(model[1]?.description, 'Current');
  assert.equal(model[1]?.command?.command, 'piRpcInternal.revealOpenChat');
  assert.deepEqual(model[1]?.command?.arguments, [{ resource: 'pi-chat:/a' }]);
  assert.equal(model[2]?.label, 'Refactor sidebar');
  assert.equal(model[2]?.icon, 'comment-discussion');
  assert.equal(model[2]?.description, undefined);
});

test('THE actual fix: a session that is both open AND in recent history appears ONLY once, under Open', () => {
  const model = createOpenChatListModel({
    openChats: [{ resource: 'pi-chat:/a', title: 'Fix auth bug', sessionFile: '/s/a.jsonl', active: true }],
    recent: {
      loading: false,
      filterText: '',
      items: [
        {
          id: 'a',
          path: '/s/a.jsonl', // SAME path as the open chat above
          displayName: 'Fix auth bug',
          sessionName: 'Fix auth bug',
          firstPromptPreview: 'fix it',
          workspaceLabel: 'ws',
          modelLabel: 'sonnet',
          modifiedAt: Date.now(),
          createdAt: Date.now(),
          cwd: '/tmp',
          messageCount: 2,
        },
        {
          id: 'b',
          path: '/s/b.jsonl', // genuinely different, not open
          displayName: 'Older chat',
          sessionName: 'Older chat',
          firstPromptPreview: 'older',
          workspaceLabel: 'ws',
          modelLabel: 'sonnet',
          modifiedAt: Date.now() - 60000,
          createdAt: Date.now() - 60000,
          cwd: '/tmp',
          messageCount: 1,
        },
      ],
    },
  });
  const labels = model.map((n) => n.label);
  // "Fix auth bug" appears exactly ONCE across the whole list, not twice.
  assert.equal(labels.filter((l) => l === 'Fix auth bug').length, 1);
  // "Older chat" (genuinely not open, not deduped) still appears once.
  assert.equal(labels.filter((l) => l === 'Older chat').length, 1);
});

test('Recent rows use piRpc.switchSession (reuses an existing tab if the session is already open)', () => {
  const model = createOpenChatListModel({
    openChats: [],
    recent: {
      loading: false,
      filterText: '',
      items: [
        {
          id: 'a',
          path: '/s/a.jsonl',
          displayName: 'Some chat',
          sessionName: 'Some chat',
          firstPromptPreview: 'x',
          workspaceLabel: 'ws',
          modelLabel: 'sonnet',
          modifiedAt: Date.now(),
          createdAt: Date.now(),
          cwd: '/tmp',
          messageCount: 1,
        },
      ],
    },
  });
  const recentNode = model[1]; // [0]=New Chat, [1]=entry (no header row)
  assert.equal(recentNode?.command?.command, 'piRpc.switchSession');
  assert.deepEqual(recentNode?.command?.arguments, [{ sessionPath: '/s/a.jsonl', label: 'Some chat' }]);
});

test('unknown session times render without NaN labels', () => {
  const model = createOpenChatListModel({
    openChats: [],
    recent: {
      loading: false,
      filterText: '',
      items: [
        {
          id: 'sid',
          path: '/tmp/sessions/unknown.jsonl',
          cwd: '/tmp/workspace-a',
          workspaceLabel: 'workspace-a',
          displayName: 'Broken Session',
          firstPromptPreview: 'fix timestamps',
          messageCount: 1,
          modifiedAt: 0,
          createdAt: 0,
        },
      ],
      sessionDir: '/tmp/sessions',
    },
    now: Date.UTC(2024, 0, 2, 12, 0, 0),
  });
  const recentNode = model[1];
  assert.ok(!recentNode?.description?.includes('NaN'));
  assert.match(recentNode?.tooltip ?? '', /Unknown/);
});

test('loading and error states for recent chats', () => {
  const loadingModel = createOpenChatListModel({
    openChats: [],
    recent: { ...baseRecent, loading: true },
  });
  assert.equal(loadingModel[1]?.label, 'Loading chats');

  const errorModel = createOpenChatListModel({
    openChats: [],
    recent: { ...baseRecent, error: 'permission denied' },
  });
  assert.equal(errorModel[1]?.label, "Couldn't read chats");
  assert.equal(errorModel[2]?.label, 'Try again');
});
