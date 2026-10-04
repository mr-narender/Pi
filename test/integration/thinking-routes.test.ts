import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { createEmptyComposerState } from '../../src/webview/composer';

test('thinking Agentic editor picker cancellation, stale model, errors and newer draft ownership', async () => {
  let resolvePick: ((p: any) => void) | undefined;
  let items: any[] = [];
  const result = await build({
    stdin: {
      contents:
        "export { ChatTabManager } from './src/editorTabs/tabManager'; export { pickThinkingLevel } from './src/commands/thinkingPicker';",
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
      window: {
        showQuickPick: (i: any[]) => {
          items = i;
          return new Promise((r) => {
            resolvePick = r;
          });
        },
      },
    }),
    module,
    module.exports
  );
  {
    const state = createEmptyComposerState();
    state.pendingImages = [{ itemId: 'chip', name: 'chip', mimeType: 'image/png', sizeBytes: 1 }];
    let applied = 0;
    let fail = false;
    const controller = {
      snapshot: { state: { sessionId: 'one', model: { provider: 'a', id: 'alpha' } } },
      getThinkingCapabilities: async () => ({ levels: ['off', 'xhigh', 'max'], revision: 'epoch' }),
      setThinkingLevel: async () => {
        if (fail) throw new Error('native failed');
        applied++;
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
        throw new Error('must not arm');
      },
    };
    const send = () => instance.handleRequestSend({}, 'prompt', true);
    state.draft = '/thinking  MAX  ';
    await send();
    assert.equal(applied, 1);
    assert.equal(state.draft, '');
    assert.equal(state.pendingImages.length, 1);
    state.draft = '/thinking low';
    await send();
    assert.equal(applied, 1);
    assert.match(state.recovery!.detail, /Available: off, xhigh, max/);
    const start = async () => {
      state.draft = '/thinking';
      resolvePick = undefined;
      const pending = send();
      for (let i = 0; i < 30 && !resolvePick; i++) await new Promise((r) => setTimeout(r, 0));
      assert.ok(resolvePick);
      assert.deepEqual(
        items.map((i) => i.level),
        ['off', 'xhigh', 'max']
      );
      return { pending };
    };
    let operation = await start();
    resolvePick!(undefined);
    await operation.pending;
    assert.equal(state.draft, '', 'Cancel consumes bare menu text');
    operation = await start();
    controller.snapshot.state.model.id = 'beta';
    resolvePick!(items[1]);
    await operation.pending;
    assert.equal(applied, 1);
    assert.equal(state.draft, '', 'stale model cannot restore consumed text');
    operation = await start();
    state.draft = 'new input';
    state.commandRevision = (state.commandRevision ?? 0) + 1;
    resolvePick!(items[1]);
    await operation.pending;
    assert.equal(state.draft, 'new input');
    assert.equal(applied, 2);
    fail = true;
    state.draft = '/thinking off';
    await send();
    assert.equal(state.draft, '/thinking off');
    assert.match(state.recovery!.detail, /native failed/);
    assert.equal(state.pendingImages.length, 1);
    fail = false;
    resolvePick = undefined;
    const menu = module.exports.pickThinkingLevel(controller);
    for (let i = 0; i < 30 && !resolvePick; i++) await new Promise((r) => setTimeout(r, 0));
    resolvePick!(items[2]);
    await menu;
  }
});
