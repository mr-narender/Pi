import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { createEmptyComposerState } from '../../src/webview/composer';
import { spawnMockPi, shutdown } from '../helpers/rpc';

test('model: actual Agentic editor direct refs, query picker, cancellation and origin-safe acknowledgement', async () => {
  let pick: any;
  let release: (() => void) | undefined;
  let opened = 0;
  const vscode = {
    workspace: { isTrusted: true },
    QuickPickItemKind: { Separator: -1 },
    window: {
      createQuickPick: () => {
        opened++;
        let accept: () => void;
        let hide: () => void;
        return {
          items: [] as any[],
          selectedItems: [] as any[],
          onDidChangeValue: () => {},
          onDidAccept: (fn: () => void) => {
            accept = fn;
          },
          onDidHide: (fn: () => void) => {
            hide = fn;
          },
          show() {
            release = () => {
              this.selectedItems = pick ? [pick] : [];
              if (pick) accept();
              else hide();
            };
          },
          hide() {
            hide();
          },
          dispose() {},
        };
      },
      showErrorMessage: () => {},
      showWarningMessage: () => {},
    },
  };
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
  const module = { exports: {} as Record<string, any> };
  new Function('require', 'module', 'exports', result.outputFiles[0]!.text)(
    () => vscode,
    module,
    module.exports
  );
  const models = [
    { provider: 'proxy/vendor', id: 'family/model', name: 'Family' },
    { provider: 'a', id: 'same' },
    { provider: 'b', id: 'same' },
  ];
  {
    const state = createEmptyComposerState();
    state.pendingImages = [{ itemId: 'chip', name: 'x', mimeType: 'image/png', sizeBytes: 1 }];
    let applied: string[] = [];
    let fail = false;
    const controller = {
      snapshot: { state: { sessionId: 'origin', model: models[0] }, isStreaming: true },
      getAvailableModels: async () => models,
      selectModel: async (provider: string, id: string) => {
        if (fail) throw new Error('provider RPC failed');
        applied.push(`${provider}/${id}`);
      },
      refreshState: async () => {},
      setDraft: () => {},
      prompt: () => {
        throw new Error('must never prompt');
      },
    };
    const instance = Object.create(module.exports['ChatTabManager'].prototype);
    instance.uiState = {
      captureIdentity: () => ({}),
      getComposerState: async () => structuredClone(state),
      getComposerStateForIdentity: async () => structuredClone(state),
      setComposerState: async (_c: unknown, next: typeof state) => Object.assign(state, next),
      setComposerStateForIdentity: async (_c: unknown, _t: unknown, next: typeof state) =>
        Object.assign(state, next),
    };
    instance.contextForResource = () => ({ controller, target: {}, resource: {} });
    instance.renderResource = instance.postSnapshot = async () => {};
    instance.preparePromptContext = () => {
      throw new Error('must not prepare');
    };
    const send = () => instance.handleRequestSend({}, 'steer');
    state.draft = '/model PROXY/VENDOR/FAMILY/MODEL';
    await send();
    assert.deepEqual(applied, ['proxy/vendor/family/model']);
    assert.equal(state.draft, '');
    assert.equal(state.pendingImages.length, 1);
    for (const query of ['', 'same', 'family model', 'not-found', 'family/model:high']) {
      state.draft = `/model ${query}`.trim();
      pick = undefined;
      release = undefined;
      const pending = send();
      for (let i = 0; i < 20 && !release; i++) await new Promise((r) => setTimeout(r, 0));
      assert.ok(release, `opens existing picker for ${query}`);
      assert.equal(
        state.draft,
        query ? `/model ${query}` : '',
        'bare invocation consumed before picker resolves'
      );
      assert.equal(state.pendingImages.length, 1);
      (release as unknown as () => void)();
      await pending;
      assert.equal(state.draft, query ? `/model ${query}` : '');
      assert.equal(applied.length, 1);
    }
    state.draft = '/model';
    pick = { model: models[0] };
    release = undefined;
    const pending = send();
    for (let i = 0; i < 20 && !release; i++) await new Promise((r) => setTimeout(r, 0));
    assert.ok(release);
    instance.contextForResource = () => ({ controller: { id: 'other' }, target: {}, resource: {} });
    state.draft = 'new input';
    state.pendingImages.push({ itemId: 'new', name: 'new', mimeType: 'image/png', sizeBytes: 1 });
    (release as unknown as () => void)();
    await pending;
    assert.equal(state.draft, 'new input');
    assert.equal(state.pendingImages.length, 2);
    assert.equal(
      applied.length,
      1,
      'a replaced Agentic editor controller cancels without applying a stale model'
    );
    instance.contextForResource = () => ({ controller, target: {}, resource: {} });
    fail = true;
    state.draft = '/model proxy/vendor/family/model';
    await send();
    assert.equal(state.draft, '/model proxy/vendor/family/model');
    assert.match(state.recovery!.detail, /provider RPC failed/);
    applied = [];
    fail = false;
    controller.getAvailableModels = async () => [];
    state.draft = '/model';
    await send();
    assert.match(state.recovery!.detail, /No available models/);
    assert.equal(state.draft, '');
    controller.getAvailableModels = async () => models;
    pick = { model: models[0] };
    release = undefined;
    state.draft = '/model';
    const stale = send();
    for (let i = 0; i < 20 && !release; i++) await new Promise((r) => setTimeout(r, 0));
    assert.ok(release);
    controller.snapshot.state.sessionId = 'replacement';
    (release as unknown as () => void)();
    await stale;
    assert.equal(applied.length, 0, 'replaced chat generation cannot apply a model');
  }
  assert.equal(opened, 7, 'five query pickers plus origin and session invalidation pickers');
});

test('model wire: existing stock-shaped catalog and set_model RPC apply before next state query', async () => {
  const spawned = await spawnMockPi();
  try {
    const catalog = await spawned.client.getAvailableModels();
    assert.ok(Array.isArray(catalog?.models));
    await spawned.client.setModel('proxy/vendor', 'family/model');
    const state = await spawned.client.getState();
    assert.equal((state?.model as any).provider, 'proxy/vendor');
    assert.equal((state?.model as any).id, 'family/model');
  } finally {
    await shutdown(spawned);
  }
});

test('model picker changes only the model and never turns optional thinking into a failure', async () => {
  let accepted: (() => void) | undefined;
  const vscode = {
    QuickPickItemKind: { Separator: -1 },
    window: {
      createQuickPick: () => {
        let onAccept: () => void;
        let onHide: () => void;
        return {
          items: [] as any[],
          selectedItems: [] as any[],
          onDidChangeValue() {},
          onDidAccept(fn: () => void) {
            onAccept = fn;
          },
          onDidHide(fn: () => void) {
            onHide = fn;
          },
          show() {
            accepted = () => {
              this.selectedItems = [this.items.find((item: any) => item.model)!];
              onAccept();
            };
          },
          hide() {
            onHide();
          },
          dispose() {},
        };
      },
      showErrorMessage() {},
      showWarningMessage() {},
    },
  };
  const built = await build({
    stdin: {
      contents: "export { pickChatModel } from './src/commands/modelPicker';",
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    external: ['vscode'],
  });
  const mod = { exports: {} as any };
  new Function('require', 'module', 'exports', built.outputFiles[0]!.text)(
    () => vscode,
    mod,
    mod.exports
  );
  let thinkingCalls = 0;
  const controller = {
    snapshot: {
      generation: 1,
      state: { sessionId: 'one', sessionFile: '/one.jsonl', model: { provider: 'old', id: 'old' } },
    },
    modelEpoch: 0,
    getAvailableModels: async () => [
      { provider: 'openai', id: 'reasoning', reasoning: true, name: 'Reasoning' },
    ],
    selectModel: async (provider: string, id: string) => {
      controller.snapshot.state.model = { provider, id };
    },
    getThinkingCapabilities: async () => {
      thinkingCalls++;
      throw new Error('/thinking is unsupported by this backend');
    },
    refreshState: async () => {},
  };
  const pending = mod.exports.pickChatModel(controller);
  for (let i = 0; i < 20 && !accepted; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(accepted);
  accepted!();
  assert.deepEqual(await pending, { provider: 'openai', id: 'reasoning' });
  assert.equal(thinkingCalls, 0);
});
