import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createNewChatSidebarModel,
  createResumeChatSidebarModel,
  createSessionsSidebarModel,
} from '../../src/ui/trees/sessionSidebarModel';

const baseRecent = { loading: false, filterText: '', items: [] };

test('sessions sidebar model leads with New Chat then lists existing chats', () => {
  const model = createSessionsSidebarModel({
    activeFolderName: 'workspace',
    activeState: {
      connectionState: 'ready',
      workspaceFolderName: 'workspace',
      state: { sessionFile: '/tmp/sessions/current.jsonl' },
    },
    recent: {
      loading: false,
      filterText: '',
      items: [
        {
          id: 'a',
          path: '/tmp/sessions/current.jsonl',
          displayName: 'Fix auth',
          sessionName: 'Fix auth',
          firstPromptPreview: 'Fix auth',
          workspaceLabel: 'workspace',
          modelLabel: 'sonnet',
          modifiedAt: Date.now(),
          createdAt: Date.now(),
          cwd: '/tmp',
          messageCount: 2,
        },
        {
          id: 'b',
          path: '/tmp/sessions/older.jsonl',
          displayName: 'Older chat',
          sessionName: 'Older chat',
          firstPromptPreview: 'Older chat',
          workspaceLabel: 'workspace',
          modelLabel: 'sonnet',
          modifiedAt: Date.now() - 60000,
          createdAt: Date.now() - 60000,
          cwd: '/tmp',
          messageCount: 1,
        },
      ],
    },
    hasDraft: false,
    hasPendingAttachments: false,
    now: Date.now(),
  });

  assert.equal(model[0]?.label, 'New Chat');
  assert.equal(model[0]?.command?.command, 'piRpc.newSession');
  assert.equal(model[1]?.kind, 'session');
  assert.equal(model[1]?.label, 'Fix auth');
  assert.equal(model[1]?.command?.command, 'piRpc.switchSession');
  assert.ok(String(model[1]?.description).includes('Current'));
  assert.equal(model[2]?.label, 'Older chat');
});

test('sessions sidebar model shows an empty state with only New Chat', () => {
  const model = createSessionsSidebarModel({
    activeFolderName: 'workspace',
    recent: baseRecent,
    hasDraft: false,
    hasPendingAttachments: false,
  });
  assert.equal(model[0]?.label, 'New Chat');
  assert.equal(model[1]?.label, 'No chats yet');
});

test('new chat sidebar model shows primary action and unsent draft warning', () => {
  const model = createNewChatSidebarModel({
    activeFolderName: 'workspace',
    recent: baseRecent,
    hasDraft: true,
    hasPendingAttachments: true,
  });

  assert.equal(model[0]?.label, 'Start fresh with Pi in this workspace');
  assert.equal(model[1]?.label, 'New Chat');
  assert.equal(model[2]?.label, 'Unsent draft and attachments stay in the active chat tab.');
});

test('resume chat sidebar model renders filter state and current marker', () => {
  const model = createResumeChatSidebarModel({
    activeFolderName: 'workspace-a',
    activeState: {
      connectionState: 'ready',
      workspaceFolderName: 'workspace-a',
      state: {
        sessionFile: '/tmp/sessions/current.jsonl',
        sessionName: 'Current Session',
        sessionId: 'sid',
        isStreaming: false,
        isCompacting: false,
        model: { provider: 'mock', id: 'model' },
        pendingMessageCount: 1,
      },
    },
    recent: {
      loading: false,
      filterText: 'bug',
      items: [
        {
          id: 'sid',
          path: '/tmp/sessions/current.jsonl',
          cwd: '/tmp/workspace-a',
          workspaceLabel: 'workspace-a',
          displayName: 'Current Session',
          firstPromptPreview: 'fix bug',
          modelLabel: 'mock/model',
          messageCount: 4,
          modifiedAt: Date.UTC(2024, 0, 2, 11, 0, 0),
          createdAt: Date.UTC(2024, 0, 2, 10, 0, 0),
        },
      ],
      sessionDir: '/tmp/sessions',
    },
    hasDraft: false,
    hasPendingAttachments: false,
    now: Date.UTC(2024, 0, 2, 12, 0, 0),
  });

  assert.equal(model[0]?.label, 'Search: bug');
  assert.equal(model[1]?.label, 'Refresh');
  assert.equal(model[2]?.label, 'Clear search');
  assert.match(model[3]?.description ?? '', /Current/);
  assert.match(model[3]?.accessibilityLabel ?? '', /Current Session/);
});

test('resume chat sidebar model renders unknown session times without NaN labels', () => {
  const model = createResumeChatSidebarModel({
    activeFolderName: 'workspace-a',
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
    hasDraft: false,
    hasPendingAttachments: false,
    now: Date.UTC(2024, 0, 2, 12, 0, 0),
  });

  const recentNode = model[2];
  assert.equal(recentNode?.description, 'workspace-a · Unknown');
  assert.ok(!recentNode?.description?.includes('NaN'));
  assert.match(recentNode?.tooltip ?? '', /Unknown/);
});

test('resume chat sidebar model shows loading and error states for recent chats', () => {
  const loadingModel = createResumeChatSidebarModel({
    recent: { ...baseRecent, loading: true },
    hasDraft: false,
    hasPendingAttachments: false,
  });
  assert.equal(loadingModel[2]?.label, 'Loading recent chats');

  const errorModel = createResumeChatSidebarModel({
    recent: { ...baseRecent, error: 'permission denied' },
    hasDraft: false,
    hasPendingAttachments: false,
  });
  assert.equal(errorModel[2]?.label, "Couldn't read recent chats");
  assert.equal(errorModel[3]?.label, 'Try again');
});
