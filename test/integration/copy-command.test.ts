import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { createEmptyComposerState } from '../../src/webview/composer';

test('copy: actual Agentic editor clipboard, busy no-model, empty, arguments and origin ownership', async () => {
  const copied: string[] = [];
  let clipboardFails = false;
  const result = await build({
    stdin: {
      contents: "export { ChatTabManager } from './src/editorTabs/tabManager'; ",
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    external: ['vscode'],
  });
  const module = { exports: {} as any };
  new Function('require', 'module', 'exports', result.outputFiles[0]!.text)(
    () => ({
      workspace: { isTrusted: true },
      env: {
        clipboard: {
          writeText: async (text: string) => {
            if (clipboardFails) throw new Error('clipboard unavailable');
            copied.push(text);
          },
        },
      },
    }),
    module,
    module.exports
  );
  {
    const state = createEmptyComposerState();
    state.pendingImages = [{ itemId: 'chip', name: 'chip', mimeType: 'image/png', sizeBytes: 1 }];
    let text: string | null = '  newest committed text  ';
    let calls = 0;
    let readText: (() => Promise<string | null>) | undefined;
    const controller = {
      generation: 1,
      snapshot: { state: { sessionId: 'origin', isStreaming: true, model: undefined } },
      copyLastAssistantText: async () => {
        calls++;
        return readText ? readText() : text;
      },
      setDraft: () => {},
      prompt: () => {
        throw new Error('must not prompt');
      },
    };
    const instance = Object.create(module.exports['ChatTabManager'].prototype);
    instance.uiState = {
      captureIdentity: () => ({}),
      getComposerState: async () => structuredClone(state),
      getComposerStateForIdentity: async () => structuredClone(state),
      setComposerState: async (_c: any, s: any) => Object.assign(state, s),
      setComposerStateForIdentity: async (_c: any, _i: any, s: any) => Object.assign(state, s),
    };
    instance.contextForResource = () => ({ controller, target: {}, resource: {} });
    instance.renderResource = instance.postSnapshot = async () => {};
    instance.preparePromptContext = () => {
      throw new Error('must not prepare');
    };
    instance.follow = {
      armOnce: () => {
        throw new Error('must not follow');
      },
    };
    const send = () => instance.handleRequestSend({}, 'prompt', true);
    state.draft = '/copy';
    await send();
    assert.equal(calls, 1, 'copy must invoke the actual controller backend');
    assert.equal(copied.at(-1), 'newest committed text');
    assert.equal(state.draft, '');
    assert.equal(state.pendingImages.length, 1);
    for (text of [null, '', '   ']) {
      state.draft = '/copy';
      const before = copied.length;
      await send();
      assert.equal(state.draft, '/copy');
      assert.match(state.recovery!.detail, /No agent messages to copy yet/);
      assert.equal(copied.length, before);
    }
    state.draft = '/copy extra';
    const before = calls;
    await send();
    assert.equal(calls, before);
    assert.equal(state.draft, '/copy extra');
    assert.match(state.recovery!.detail, /does not accept arguments/);
    text = 'captured';
    clipboardFails = true;
    state.draft = '/copy';
    await send();
    assert.equal(state.draft, '/copy');
    assert.match(state.recovery!.detail, /clipboard unavailable/);
    clipboardFails = false;
    let finish!: (text: string) => void;
    readText = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    const begin = async () => {
      state.draft = '/copy';
      const pending = send();
      for (let i = 0; i < 30 && !finish; i++) await new Promise((r) => setTimeout(r, 0));
      assert.ok(finish);
      return { pending };
    };
    let operation = await begin();
    state.draft = 'newer draft';
    state.commandRevision = (state.commandRevision ?? 0) + 1;
    finish('captured text');
    await operation.pending;
    assert.equal(state.draft, 'newer draft');
    assert.equal(copied.at(-1), 'captured text');
    finish = undefined as any;
    operation = await begin();
    controller.generation++;
    const count = copied.length;
    finish('obsolete text');
    await operation.pending;
    assert.equal(copied.length, count);
    assert.equal(state.draft, '/copy');
    assert.equal(state.pendingImages.length, 1);
  }
});
