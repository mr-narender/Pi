import test from 'node:test';
import assert from 'node:assert/strict';
import packageJson from '../../package.json';
import { buildChatPath, parseChatPath } from '../../src/editorTabs/uriContract';
import { renderChatApp } from '../../src/webview/render';
import { toPersistedChatSnapshot } from '../../src/editorTabs/persistedSnapshot';
import type { WebviewSnapshot } from '../../src/state/types';

function snapshot(overrides: Partial<WebviewSnapshot> = {}): WebviewSnapshot {
  return {
    sequence: 1,
    title: 'Current Chat',
    bindingState: 'current',
    uiMode: 'simple',
    connectionState: 'ready',
    workspaceFolderName: 'workspace',
    sessionName: 'Demo Session',
    sessionId: 'sid',
    sessionFile: '/tmp/workspace/session.jsonl',
    isStreaming: false,
    isCompacting: false,
    messageCount: 2,
    pendingMessageCount: 0,
    messages: [
      { id: 'm1', role: 'user', text: 'hello', attachments: [] },
      { id: 'm2', role: 'assistant', text: 'hi', attachments: [] },
    ],
    queue: { steering: [], followUp: [] },
    draft: 'draft',
    statuses: {},
    widgets: [],
    model: { provider: 'mock', id: 'model' },
    thinkingLevel: 'medium',
    pendingContextItems: [],
    pendingImages: [
      {
        itemId: 'img-1',
        name: 'diagram.png',
        mimeType: 'image/png',
        sizeBytes: 42,
        previewDataUrl: 'data:image/png;base64,AAAA',
      },
    ],
    focus: 'composer',
    preview: {
      command: 'prompt',
      draft: 'draft',
      rpcMessage: 'draft',
      rpcImages: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }],
      imageItems: [{ itemId: 'img-1', name: 'diagram.png', mimeType: 'image/png', sizeBytes: 42 }],
    },
    acceptedSendSnapshot: {
      command: 'prompt',
      draft: 'draft',
      rpcMessage: 'draft',
      rpcImages: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }],
      serializedContextEnvelope: undefined,
      contextItems: [],
      imageItems: [{ itemId: 'img-1', name: 'diagram.png', mimeType: 'image/png', sizeBytes: 42 }],
      acceptedAt: '2024-01-01T00:00:00.000Z',
      state: 'accepted',
    },
    isTrusted: true,
    folders: [{ name: 'workspace', uri: 'file:///tmp/workspace', active: true }],
    ...overrides,
  };
}

test('editorTabs.api.customReadonlyDecision', () => {
  const customEditors = packageJson.contributes.customEditors ?? [];
  const contribution = customEditors.find((item) => item.viewType === 'piRpc.chatEditor');
  assert.ok(contribution);
  assert.equal(contribution.displayName, 'Pi Chat');
});

test('editorTabs.uri.parseRoundTrip', () => {
  const targets = [
    {
      workspaceFolderUri: 'file:///workspace-a',
      kind: 'workspaceDraft' as const,
    },
    {
      workspaceFolderUri: 'file:///workspace-a',
      kind: 'sessionFile' as const,
      sessionFile: '/tmp/workspace-a/.pi/session-a.jsonl',
    },
    {
      workspaceFolderUri: 'file:///workspace-b',
      kind: 'sessionId' as const,
      sessionId: 'sid-b',
    },
  ];

  for (const target of targets) {
    const path = buildChatPath(target);
    assert.deepEqual(parseChatPath(path), target);
  }
});

test('editorTabs.manifest.customEditorContribution', () => {
  const contribution = packageJson.contributes.customEditors.find(
    (item) => item.viewType === 'piRpc.chatEditor'
  );
  assert.ok(contribution);
  assert.deepEqual(contribution.selector, [{ filenamePattern: '*.chat' }]);
  assert.equal(contribution.priority, 'default');

  const titleMenu = packageJson.contributes.menus['editor/title'];
  assert.ok(
    titleMenu.some((item) => item.command === 'piRpcInternal.openChat'),
    'missing editor/title launcher'
  );
  assert.ok(
    titleMenu.some((item) => item.command === 'piRpc.newSession'),
    'missing editor/title new chat action'
  );
});

test('editorTabs.open.oneDraftPerWorkspace', () => {
  const first = buildChatPath({
    workspaceFolderUri: 'file:///workspace-a',
    kind: 'workspaceDraft',
  });
  const second = buildChatPath({
    workspaceFolderUri: 'file:///workspace-a',
    kind: 'workspaceDraft',
  });
  assert.equal(first, second);
});

test('editorTabs.open.multiRootIsolation', () => {
  const left = buildChatPath({
    workspaceFolderUri: 'file:///workspace-a',
    kind: 'sessionFile',
    sessionFile: '/tmp/shared/session.jsonl',
  });
  const right = buildChatPath({
    workspaceFolderUri: 'file:///workspace-b',
    kind: 'sessionFile',
    sessionFile: '/tmp/shared/session.jsonl',
  });
  assert.notEqual(left, right);
});

test('editorTabs.render.headerHasModelChipAndMore', () => {
  const html = renderChatApp(snapshot());
  assert.match(html, /class="model-chip"/);
  assert.match(html, /mock\/model/);
  assert.match(html, /aria-label="More actions"/);
  assert.doesNotMatch(html, />New</);
  assert.doesNotMatch(html, />History</);
  assert.match(html, /Current · workspace · Demo Session · Ready/);
});

test('editorTabs.revive.noPromptReplay', () => {
  const persisted = toPersistedChatSnapshot(snapshot());
  const text = JSON.stringify(persisted);
  assert.equal(text.includes('AAAA'), false);
  assert.equal(text.includes('rpcImages'), false);
  assert.equal('draft' in persisted, false);
  assert.equal(
    'previewDataUrl' in (persisted.pendingImages[0] as unknown as Record<string, unknown>),
    false
  );
  assert.equal(persisted.pendingImages[0]?.requiresReselect, true);
});
