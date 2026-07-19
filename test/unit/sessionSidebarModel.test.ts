import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSessionSidebarModel,
  createHelpSidebarModel,
} from '../../src/ui/trees/sessionSidebarModel';

const baseRecent = { loading: false, filterText: '', items: [] };

test('session sidebar model highlights first-run quick start and empty recent sessions', () => {
  const model = createSessionSidebarModel({
    activeFolderName: 'workspace',
    activeState: {
      connectionState: 'stopped',
      workspaceFolderName: 'workspace',
      state: {},
      leafId: null,
    },
    recent: baseRecent,
    isTrusted: true,
    isFirstRun: true,
    now: Date.UTC(2024, 0, 2, 12, 0, 0),
  });

  assert.equal(model[0]?.label, 'Quick Start');
  assert.deepEqual(
    model[0]?.children?.map((item) => item.label),
    ['Choose Workspace', 'Start Pi', 'New Session', 'Resume Session', 'Open Chat']
  );
  assert.equal(model[2]?.children?.[1]?.label, 'No recent sessions yet');
  assert.equal(model[3]?.label, 'First Run Tips');
});

test('session sidebar model renders current session marker, filter state, and accessibility text', () => {
  const model = createSessionSidebarModel({
    activeFolderName: 'workspace-a',
    activeState: {
      connectionState: 'ready',
      workspaceFolderName: 'workspace-a',
      leafId: 'leaf',
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
    isTrusted: false,
    isFirstRun: false,
    now: Date.UTC(2024, 0, 2, 12, 0, 0),
  });

  const recentSection = model[2];
  assert.equal(recentSection?.children?.[0]?.label, 'Filter: bug');
  assert.equal(recentSection?.children?.[1]?.label, 'Clear session search');
  assert.match(recentSection?.children?.[2]?.description ?? '', /Current/);
  assert.match(recentSection?.children?.[2]?.accessibilityLabel ?? '', /Current Session/);
  assert.match(model[0]?.description ?? '', /Restricted Mode/);
  assert.equal(model[1]?.children?.[2]?.description, 'mock/model');
});

test('session sidebar model renders unknown session times without NaN labels', () => {
  const model = createSessionSidebarModel({
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
    isTrusted: true,
    isFirstRun: false,
    now: Date.UTC(2024, 0, 2, 12, 0, 0),
  });

  const recentNode = model[2]?.children?.[1];
  assert.equal(recentNode?.description, 'workspace-a · Unknown');
  assert.ok(!recentNode?.description?.includes('NaN'));
  assert.match(recentNode?.tooltip ?? '', /Unknown/);
});

test('session sidebar model shows loading and error states for recent sessions', () => {
  const loadingModel = createSessionSidebarModel({
    recent: { ...baseRecent, loading: true },
    isTrusted: true,
    isFirstRun: false,
  });
  assert.equal(loadingModel[2]?.children?.[1]?.label, 'Loading recent sessions…');

  const errorModel = createSessionSidebarModel({
    recent: { ...baseRecent, error: 'permission denied' },
    isTrusted: true,
    isFirstRun: false,
  });
  assert.equal(errorModel[2]?.children?.[1]?.label, 'Could not read recent sessions');
});

test('help sidebar model explains branch terminology in plain language', () => {
  const model = createHelpSidebarModel({ isFirstRun: true });
  assert.equal(model[0]?.label, 'Start here');
  assert.deepEqual(
    model[0]?.children?.map((item) => item.label),
    ['Start Pi', 'New Session', 'Resume Session', 'Open Chat']
  );
  assert.equal(model[1]?.children?.[0]?.label, 'Start Branch');
  assert.match(model[1]?.children?.[1]?.description ?? '', /Copy the current conversation path/);
  assert.match(model[1]?.children?.[2]?.description ?? '', /current marker/);
});
