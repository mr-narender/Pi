import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { createEmptyComposerState } from '../../src/webview/composer';

test('core safety: real editor/sidebar handlers retain origin drafts/chips across two chats without starting Pi', async () => {
  const result = await build({
    stdin: {
      contents:
        "export { ChatTabManager } from './src/editorTabs/tabManager'; export { ChatPanelProvider } from './src/webview/provider';",
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
    (id: string) => (id === 'vscode' ? { workspace: { isTrusted: true } } : require(id)),
    module,
    module.exports
  );
  const editor = Object.create(module.exports.ChatTabManager.prototype);
  const sidebar = Object.create(module.exports.ChatPanelProvider.prototype);
  const controllers = ['origin', 'other'].map((id) => ({
    id,
    captureEngineIntent: () => ({
      valid: () => true,
      tree: async () => {
        throw new Error('Owned local GUI command unavailable');
      },
    }),
  }));
  const states = controllers.map(() => {
    const state = createEmptyComposerState();
    state.draft = '/tree'; // Implemented bare menu; owned unavailable capability below.
    state.pendingImages = [
      {
        itemId: 'image',
        name: 'fixture.png',
        mimeType: 'image/png',
        sizeBytes: 3,
        inMemoryBase64: 'AAAA',
      },
    ];
    state.pendingContextItems = [
      {
        kind: 'pastedText',
        itemId: 'context',
        workspaceFolder: 'fixture',
        workspaceRelativePath: 'fixture',
        lineStart: 1,
        lineEnd: 1,
        languageId: 'text',
        sanitizedContent: 'fixture',
        capturedAt: 'fixture',
        persistedRef: {
          workspaceRelativePath: 'fixture',
          lineStart: 1,
          lineEnd: 1,
          languageId: 'text',
          contentFingerprint: 'fixture',
          content: 'fixture',
        },
      },
    ];
    return state;
  });
  let armed = 0;
  let startCalls = 0;
  const getState = async (controller: unknown) =>
    states[controllers.indexOf(controller as (typeof controllers)[number])]!;
  editor.uiState = {
    getComposerStateForIdentity: getState,
    setComposerStateForIdentity: async (controller: any, _identity: any, next: any) =>
      Object.assign(states[controllers.indexOf(controller)]!, next),
  };
  editor.contextForResource = (resource: { index: number }) => ({
    controller: controllers[resource.index],
    target: {},
    resource,
  });
  editor.renderResource = async () => {};
  editor.keyFor = () => 'origin';
  editor.follow = {
    armOnce: () => {
      armed++;
    },
  };
  editor.preparePromptContext = async () => {
    startCalls++;
    throw new Error('Unexpected native start');
  };
  sidebar.uiState = {
    captureIdentity: () => ({}),
    getComposerState: getState,
    getComposerStateForIdentity: getState,
    setComposerStateForIdentity: async (controller: any, _identity: any, next: any) =>
      Object.assign(states[controllers.indexOf(controller)]!, next),
    setComposerState: async () => {},
  };
  sidebar.postSnapshot = async () => {};
  for (const route of ['editor', 'sidebar']) {
    for (const index of [0, 1]) {
      for (const command of ['prompt', 'steer', 'follow_up']) {
        states[index]!.draft = '/tree';
        const before = structuredClone(states);
        if (route === 'editor') await editor.handleRequestSend({ index }, command, true);
        else await sidebar.handleRequestSend(controllers[index], command);
        for (const i of [0, 1]) {
          assert.equal(states[i]!.draft, i === index ? '' : before[i]!.draft);
          assert.deepEqual(states[i]!.pendingImages, before[i]!.pendingImages);
          assert.deepEqual(states[i]!.pendingContextItems, before[i]!.pendingContextItems);
          assert.equal(states[i]!.acceptedSendSnapshot, undefined);
        }
        assert.match(states[index]!.recovery!.detail, /local GUI command/);
      }
    }
  }
  assert.equal(startCalls, 0);
  assert.equal(armed, 0, 'a rejected local command must not arm follow-agent for the next prompt');
});
