import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { build } from 'esbuild';
import {
  beginSend,
  createEmptyComposerState,
  type ComposerSessionState,
} from '../../src/webview/composer';

async function chatTabManager() {
  const vscode = {
    workspace: {
      isTrusted: true,
      getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }),
    },
    window: { showWarningMessage() {}, showErrorMessage() {} },
  };
  const compiled = await build({
    entryPoints: ['src/editorTabs/tabManager.ts'],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    external: ['vscode'],
  });
  const require = createRequire(`${process.cwd()}/package.json`);
  const module = { exports: {} as Record<string, any> };
  new Function('require', 'module', 'exports', compiled.outputFiles[0]!.text)(
    (id: string) => (id === 'vscode' ? vscode : require(id)),
    module,
    module.exports
  );
  return module.exports.ChatTabManager;
}

test('host accepts pathless text and image payloads with their original names', async () => {
  const ChatTabManager = await chatTabManager();
  const manager = Object.create(ChatTabManager.prototype);
  const addedContext: any[] = [];
  const addedImages: any[] = [];
  const context = {
    controller: { folder: { uri: { toString: () => 'vscode-remote://ssh/workspace' } } },
    target: {},
  };
  manager.uiState = {
    addContextItemForIdentity: async (_controller: unknown, _target: unknown, item: unknown) => {
      addedContext.push(item);
    },
    getComposerStateForIdentity: async () => ({ pendingImages: [] }),
    addImageItemsForIdentity: async (_controller: unknown, _target: unknown, items: unknown[]) => {
      addedImages.push(...items);
    },
  };
  manager.renderResource = async () => {};

  await manager.handleDroppedFile(
    context,
    {},
    'report.csv',
    'text/csv',
    7,
    Buffer.from('a,b\n1,2').toString('base64')
  );
  await manager.handleDroppedFile(
    context,
    {},
    'architecture.png',
    'image/png',
    4,
    Buffer.from([137, 80, 78, 71]).toString('base64')
  );
  await manager.handleDroppedFile(
    context,
    {},
    'forged.txt',
    'text/plain',
    1,
    'A'.repeat(Math.ceil((512 * 1024) / 3) * 4 + 5)
  );

  assert.equal(addedContext[0]?.kind, 'droppedFile');
  assert.equal(addedContext[0]?.workspaceRelativePath, 'report.csv');
  assert.equal(addedContext.length, 1, 'encoded payloads are bounded before host allocation');
  assert.equal(addedImages[0]?.name, 'architecture.png');
  assert.equal(addedImages[0]?.inMemoryBase64, 'iVBORw==');
});

function outgoingComposer(): ComposerSessionState {
  const state = createEmptyComposerState();
  state.draft = 'summarize these';
  state.pendingImages = [
    {
      itemId: 'image',
      name: 'diagram.png',
      mimeType: 'image/png',
      sizeBytes: 3,
      inMemoryBase64: 'YWJj',
      previewDataUrl: 'data:image/png;base64,YWJj',
    },
  ];
  return state;
}

test('send clears the visible attachment state before slow session preparation', async () => {
  const ChatTabManager = await chatTabManager();
  const manager = Object.create(ChatTabManager.prototype);
  const resource = { toString: () => 'pi-chat:/draft.chat' };
  const target = { workspaceFolderUri: 'file:///workspace', kind: 'workspaceDraft', draftId: 'd1' };
  let stored = outgoingComposer();
  const events: string[] = [];
  const controller = {
    generation: 1,
    snapshot: { state: {}, draft: stored.draft },
    setDraft() {},
  };
  const context = { controller, target, resource };
  manager.contextForResource = () => context;
  manager.hosts = new Map([[resource.toString(), {}]]);
  manager.uiState = {
    getComposerStateForIdentity: async () => structuredClone(stored),
    setComposerStateForIdentity: async (
      _controller: unknown,
      _target: unknown,
      next: ComposerSessionState
    ) => {
      stored = structuredClone(next);
      events.push('persist-clear');
    },
  };
  manager.renderResource = async () => {
    events.push('render-clear');
  };
  manager.preparePromptContext = async () => {
    events.push('prepare-session');
    return undefined;
  };

  await manager.handleRequestSend(resource, 'prompt');
  assert.ok(events.indexOf('render-clear') < events.indexOf('prepare-session'));
  assert.equal(stored.draft, 'summarize these', 'cancelled session creation restores the draft');
  assert.equal(stored.pendingImages[0]?.inMemoryBase64, 'YWJj');
});

test('session preparation failure restores submitted content without overwriting newer input', async () => {
  const ChatTabManager = await chatTabManager();
  const manager = Object.create(ChatTabManager.prototype);
  const resource = { toString: () => 'pi-chat:/draft.chat' };
  const target = { workspaceFolderUri: 'file:///workspace', kind: 'workspaceDraft', draftId: 'd1' };
  let stored = outgoingComposer();
  const controller = {
    generation: 1,
    snapshot: { state: {}, draft: stored.draft },
    setDraft(value: string) {
      this.snapshot.draft = value;
    },
  };
  const context = { controller, target, resource };
  manager.contextForResource = () => context;
  manager.hosts = new Map([[resource.toString(), {}]]);
  manager.uiState = {
    getComposerStateForIdentity: async () => structuredClone(stored),
    setComposerStateForIdentity: async (
      _controller: unknown,
      _target: unknown,
      next: ComposerSessionState
    ) => {
      stored = structuredClone(next);
    },
  };
  manager.renderResource = async () => {};
  manager.preparePromptContext = async () => {
    throw new Error('startup failed');
  };

  await manager.handleRequestSend(resource, 'prompt');
  assert.equal(stored.draft, 'summarize these');
  assert.equal(stored.pendingImages[0]?.inMemoryBase64, 'YWJj');
  assert.equal(stored.recovery?.kind, 'preflightError');

  stored = outgoingComposer();
  manager.preparePromptContext = async () => {
    stored = { ...stored, draft: 'new unsent input' };
    return undefined;
  };
  await manager.handleRequestSend(resource, 'prompt');
  assert.equal(stored.draft, 'new unsent input');
  assert.deepEqual(stored.pendingImages, []);
});

test('failed transport restores the submitted draft and usable image chip when no newer edit exists', async () => {
  const ChatTabManager = await chatTabManager();
  const manager = Object.create(ChatTabManager.prototype);
  const state = outgoingComposer();
  const { preview, accepted } = beginSend('prompt', state);
  let stored = state;
  let renders = 0;
  const controller = {
    setDraft(value: string) {
      this.draft = value;
    },
    draft: '',
    prompt: async () => {
      throw new Error('offline');
    },
  };
  manager.uiState = {
    getComposerStateForIdentity: async () => stored,
    setComposerStateForIdentity: async (
      _controller: unknown,
      _target: unknown,
      next: ComposerSessionState
    ) => {
      stored = next;
    },
  };
  manager.renderResource = async () => {
    renders += 1;
  };

  await manager.sendPreview({}, controller, {}, state, preview, accepted);
  assert.equal(stored.draft, 'summarize these');
  assert.equal(stored.pendingImages[0]?.inMemoryBase64, 'YWJj');
  assert.equal(controller.draft, 'summarize these');
  assert.equal(stored.recovery?.kind, 'sendFailure');
  assert.equal(renders, 2);
});

test('failed transport never overwrites a newer unsent draft', async () => {
  const ChatTabManager = await chatTabManager();
  const manager = Object.create(ChatTabManager.prototype);
  const state = outgoingComposer();
  const { preview, accepted } = beginSend('prompt', state);
  let stored = state;
  const controller = {
    setDraft() {},
    prompt: async () => {
      stored = { ...stored, draft: 'new unsent text' };
      throw new Error('offline');
    },
  };
  manager.uiState = {
    getComposerStateForIdentity: async () => stored,
    setComposerStateForIdentity: async (
      _controller: unknown,
      _target: unknown,
      next: ComposerSessionState
    ) => {
      stored = next;
    },
  };
  manager.renderResource = async () => {};

  await manager.sendPreview({}, controller, {}, state, preview, accepted);
  assert.equal(stored.draft, 'new unsent text');
  assert.deepEqual(stored.pendingImages, []);
});
