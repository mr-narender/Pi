import test from 'node:test';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { chatPathFor, rememberChatUri, lookupChatUri } from '../../src/editorTabs/uriRegistry';
import assert from 'node:assert/strict';
import packageJson from '../../package.json';
import { chatTargetSessionKey, normalizeSessionFilePath } from '../../src/editorTabs/uriContract';
import { renderChatApp } from '../../src/webview/render';
import { toPersistedChatSnapshot } from '../../src/editorTabs/persistedSnapshot';
import type { WebviewSnapshot } from '../../src/state/types';

function snapshot(overrides: Partial<WebviewSnapshot> = {}): WebviewSnapshot {
  return {
    sequence: 1,
    title: 'Current Chat',
    bindingState: 'current',
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
  assert.equal(contribution.displayName, 'π Chat');
});

test('editorTabs.uri.shortIdMapRoundTrip', () => {
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
    const path = chatPathFor(target);
    rememberChatUri(path, target);
    assert.deepEqual(lookupChatUri(path), target);
  }
});

test('native chat URIs restore current mappings and reject obsolete path/query identities', async () => {
  const result = await build({
    stdin: {
      contents:
        "export * from './src/editorTabs/uri'; export {initChatUriRegistry, __resetChatUriRegistry} from './src/editorTabs/uriRegistry';",
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    external: ['vscode'],
  });
  const require = createRequire(`${process.cwd()}/package.json`);
  const module = { exports: {} as Record<string, any> };
  new Function('require', 'module', 'exports', result.outputFiles[0]!.text)(
    (id: string) => (id === 'vscode' ? { Uri: { from: (value: unknown) => value } } : require(id)),
    module,
    module.exports
  );
  const api = module.exports;
  const data = new Map<string, unknown>();
  const memento = {
    get: (key: string, fallback: unknown) => data.get(key) ?? fallback,
    update: async (key: string, value: unknown) => {
      data.set(key, value);
    },
  };
  api.initChatUriRegistry(memento);
  const target = {
    workspaceFolderUri: 'file:///workspace',
    kind: 'sessionFile',
    sessionFile: '/tmp/session.jsonl',
  };
  const current = api.buildChatUri(target);
  assert.match(current.path, /^\/chat-[0-9a-f]{10}\.chat$/);
  assert.deepEqual(api.parseChatUri(current), target);
  api.__resetChatUriRegistry();
  assert.equal(api.parseChatUri(current), undefined);
  api.initChatUriRegistry(memento);
  assert.deepEqual(api.parseChatUri(current), target, 'persisted short-id map restores the tab');
  const workspace = Buffer.from(target.workspaceFolderUri).toString('base64url');
  const session = Buffer.from(target.sessionFile).toString('base64url');
  assert.equal(
    api.parseChatUri({
      scheme: 'pi-chat',
      path: `/${workspace}/session-file/${session}.chat`,
      query: '',
    }),
    undefined
  );
  assert.equal(
    api.parseChatUri({
      scheme: 'pi-chat',
      path: '/unknown.chat',
      query: `w=${workspace}&k=sessionFile&f=${session}`,
    }),
    undefined
  );
  assert.equal(api.parseChatUri({ ...current, scheme: 'file' }), undefined);
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
  const first = chatPathFor({
    workspaceFolderUri: 'file:///workspace-a',
    kind: 'workspaceDraft',
  });
  const second = chatPathFor({
    workspaceFolderUri: 'file:///workspace-a',
    kind: 'workspaceDraft',
  });
  assert.equal(first, second);
});

test('editorTabs.open.multiRootIsolation', () => {
  const left = chatPathFor({
    workspaceFolderUri: 'file:///workspace-a',
    kind: 'sessionFile',
    sessionFile: '/tmp/shared/session.jsonl',
  });
  const right = chatPathFor({
    workspaceFolderUri: 'file:///workspace-b',
    kind: 'sessionFile',
    sessionFile: '/tmp/shared/session.jsonl',
  });
  assert.notEqual(left, right);
});

test('editorTabs.render.headerHasModelChipAndMore', () => {
  const html = renderChatApp(snapshot());
  assert.match(html, /class="composer-status" id="status-chip" data-command="piRpc.chatSettings"/);
  assert.match(html, /mock\/model/);
  // Chat actions moved to the native editor title bar (piRpc.chatActions).
  assert.doesNotMatch(html, /aria-label="Chat actions"/);
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

test('different sessions keep distinct identity even if the short label collides', () => {
  const a = chatPathFor({
    workspaceFolderUri: 'file:///w',
    kind: 'sessionFile',
    sessionFile: '/s/2026_019f7872-aaaa.jsonl',
  });
  const b = chatPathFor({
    workspaceFolderUri: 'file:///w',
    kind: 'sessionFile',
    sessionFile: '/s/2026_019f7872-bbbb.jsonl',
  });
  assert.notEqual(a, b);
});

test('regression: session identity survives a query-less restore through the short-id map', () => {
  // VS Code may drop a custom URI's query when it restores a tab, so the full
  // identity is recovered from the persisted short-id map by its path.
  const target = {
    workspaceFolderUri: 'file:///Users/x/proj',
    kind: 'sessionFile' as const,
    sessionFile: '/Users/x/.pi/agent/sessions/--Users-x-proj--/2026_abc.jsonl',
  };
  const path = chatPathFor(target);
  assert.equal(path.includes('?'), false, 'path must not depend on a query');
  rememberChatUri(path, target);
  assert.deepEqual(lookupChatUri(path), target);
});

test('chatTargetSessionKey ignores path-slash/normalization drift (fixes Windows resume binding)', () => {
  const a = chatTargetSessionKey({
    workspaceFolderUri: 'file:///w',
    kind: 'sessionFile',
    sessionFile: '/s/dir/2026_abc.jsonl',
  });
  // Same file, non-normalized path (extra segment + `..`) → must be the SAME key,
  // so the tab binds as "current" instead of showing an empty cached transcript.
  const b = chatTargetSessionKey({
    workspaceFolderUri: 'file:///w',
    kind: 'sessionFile',
    sessionFile: '/s/dir/nested/../2026_abc.jsonl',
  });
  assert.equal(a, b);
});

test('normalizeSessionFilePath resolves . and .. segments', () => {
  assert.equal(
    normalizeSessionFilePath('/a/b/../c/./f.jsonl'),
    normalizeSessionFilePath('/a/c/f.jsonl')
  );
});

test('different session files still produce different keys', () => {
  const a = chatTargetSessionKey({
    workspaceFolderUri: 'file:///w',
    kind: 'sessionFile',
    sessionFile: '/s/2026_aaa.jsonl',
  });
  const b = chatTargetSessionKey({
    workspaceFolderUri: 'file:///w',
    kind: 'sessionFile',
    sessionFile: '/s/2026_bbb.jsonl',
  });
  assert.notEqual(a, b);
});
