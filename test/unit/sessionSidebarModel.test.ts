import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCurrentChatSidebarModel,
  createNewChatSidebarModel,
  createResumeChatSidebarModel,
} from '../../src/ui/trees/sessionSidebarModel';

const baseRecent = { loading: false, filterText: '', items: [] };

test('new chat sidebar model shows primary action and unsent draft warning', () => {
  const model = createNewChatSidebarModel({
    activeFolderName: 'workspace',
    recent: baseRecent,
    hasDraft: true,
    hasPendingAttachments: true,
  });

  assert.equal(model[0]?.label, 'Start fresh with Pi in this workspace');
  assert.equal(model[1]?.label, 'New Chat');
  assert.equal(model[2]?.label, 'Unsent draft and attachments stay in Current Chat.');
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

test('current chat sidebar model summarizes workspace, model, status, and stop action', () => {
  const model = createCurrentChatSidebarModel({
    activeFolderName: 'workspace-a',
    activeState: {
      connectionState: 'busy',
      workspaceFolderName: 'workspace-a',
      state: {
        sessionFile: '/tmp/sessions/current.jsonl',
        sessionName: 'Current Session',
        sessionId: 'sid',
        isStreaming: true,
        isCompacting: false,
        model: { provider: 'mock', id: 'model' },
        pendingMessageCount: 1,
      },
    },
    recent: baseRecent,
    hasDraft: false,
    hasPendingAttachments: false,
  });

  assert.equal(model[0]?.label, 'Open Current Chat');
  assert.equal(model[1]?.description, 'workspace-a');
  assert.equal(model[3]?.description, 'mock/model');
  assert.equal(model[4]?.description, 'Pi is replying');
  assert.equal(model[5]?.label, 'Advanced');
  assert.equal(model[6]?.label, 'Stop');
});
