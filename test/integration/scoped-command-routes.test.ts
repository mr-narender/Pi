import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { createEmptyComposerState } from '../../src/webview/composer';

test('scopes: actual Agentic editor UI staging, cancellation, newer draft, two-chat origin, chips and explicit global save', async () => {
  const stages: Array<{ items: any[]; options: any; resolve: (value: any) => void }> = [];
  const vscode = {
    workspace: { isTrusted: true },
    window: {
      showQuickPick: (items: any[], options: any) =>
        new Promise((resolve) => stages.push({ items, options, resolve })),
    },
  };
  const built = await build({
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
  const mod = { exports: {} as any };
  new Function('require', 'module', 'exports', built.outputFiles[0]!.text)(
    () => vscode,
    mod,
    mod.exports
  );
  const stage = async () => {
    for (let i = 0; i < 50 && !stages.length; i++) await new Promise((r) => setTimeout(r, 0));
    assert.ok(stages.length, 'native picker stage opens');
    return stages.shift()!;
  };
  {
    const state = createEmptyComposerState();
    state.pendingImages = [{ itemId: 'chip', name: 'x', mimeType: 'image/png', sizeBytes: 1 }];
    const applied: any[] = [];
    let fail = false;
    const catalog = {
      models: [
        { provider: 'a', id: 'one' },
        { provider: 'b', id: 'two' },
        { provider: 'c', id: 'three' },
      ],
      scoped: [{ provider: 'b', id: 'two', thinkingLevel: 'high' }],
      revision: 'r1',
      globalPatterns: ['missing/*'],
      projectPatterns: ['b/two'],
      effectivePatterns: ['b/two'],
      projectOverride: true,
      diagnostics: [],
      globalDiagnostics: [{ code: 'no-match', pattern: 'missing/*' }],
    };
    const controller = {
      snapshot: { state: { sessionId: 'origin' } },
      getScopedModels: async () => structuredClone(catalog),
      applyScopedModels: async (...args: any[]) => {
        if (fail) throw new Error('SCOPES_SETTINGS_WRITE_FAILED');
        applied.push(args);
      },
      setDraft() {},
      prompt() {
        throw new Error('must not prompt');
      },
    };
    const instance = Object.create(mod.exports['ChatTabManager'].prototype);
    instance.uiState = {
      captureIdentity: () => ({}),
      getComposerState: async () => structuredClone(state),
      getComposerStateForIdentity: async () => structuredClone(state),
      setComposerState: async (_c: any, next: any) => Object.assign(state, next),
      setComposerStateForIdentity: async (_c: any, _t: any, next: any) =>
        Object.assign(state, next),
    };
    instance.contextForResource = () => ({ controller, target: {}, resource: {} });
    instance.renderResource = instance.postSnapshot = async () => {};
    instance.preparePromptContext = () => {
      throw new Error('must not prepare');
    };
    const send = () => instance.handleRequestSend({}, 'steer');
    for (const cancelAt of [1, 2]) {
      state.draft = '/scoped-models';
      const pending = send();
      const first = await stage();
      assert.equal(first.options.canPickMany, true);
      first.resolve(cancelAt === 1 ? undefined : [first.items[1], first.items[0]]);
      if (cancelAt === 2) (await stage()).resolve(undefined);
      await pending;
      assert.equal(applied.length, 0);
      assert.equal(state.draft, '', 'cancelled menu remains consumed');
      assert.equal(state.pendingImages.length, 1);
    }
    state.draft = '/scoped-models';
    const pending = send();
    const first = await stage();
    first.resolve([first.items[0], first.items[1]]);
    const decision = await stage();
    assert.match(decision.items[1].detail, /including unavailable patterns/);
    assert.match(decision.items[1].detail, /Project enabledModels overrides/);
    decision.resolve(decision.items[1]);
    await pending;
    assert.deepEqual(applied[0], [
      [
        { provider: 'b', id: 'two', thinkingLevel: 'high' },
        { provider: 'a', id: 'one' },
      ],
      'r1',
      true,
      true,
    ]);
    assert.equal(state.draft, '');
    assert.equal(state.pendingImages.length, 1);
    fail = true;
    state.draft = '/scoped-models';
    const failing = send();
    const f = await stage();
    f.resolve([f.items[0]]);
    const d = await stage();
    d.resolve(d.items[1]);
    await failing;
    assert.match(state.recovery!.detail, /WRITE_FAILED/);
    assert.equal(state.draft, '', 'save failure does not restore consumed text');
    fail = false;
    state.draft = '/scoped-models';
    const late = send();
    const l = await stage();
    l.resolve([l.items[0]]);
    const ld = await stage();
    state.draft = 'new typed draft';
    state.commandRevision = (state.commandRevision ?? 0) + 1;
    instance.contextForResource = () => ({
      controller: { snapshot: { state: { sessionId: 'second' } } },
      target: {},
      resource: {},
    });
    ld.resolve(ld.items[0]);
    await late;
    assert.equal(state.draft, 'new typed draft');
    const expectedApplied = 1;
    assert.equal(
      applied.length,
      expectedApplied,
      'a replaced Agentic editor controller cancels without applying stale scopes'
    );
    instance.contextForResource = () => ({ controller, target: {}, resource: {} });
    state.draft = '/scoped-models';
    const replaced = send();
    const r = await stage();
    controller.snapshot.state.sessionId = 'replacement';
    r.resolve([r.items[0]]);
    await replaced;
    assert.equal(applied.length, expectedApplied, 'replaced session cannot apply');
    assert.equal(state.draft, '', 'session replacement does not restore consumed text');
  }
});
