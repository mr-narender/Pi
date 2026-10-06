import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { createEmptyComposerState } from '../../src/webview/composer';

{
  test(`compiled lifecycle editor: all send modes, hidden local effects, cancel/stale/newer/retyped and chips`, async () => {
    const panels: any[] = [];
    const output = await build({
      stdin: {
        contents: "export {ChatTabManager} from './src/editorTabs/tabManager'; ",
        resolveDir: process.cwd(),
      },
      bundle: true,
      write: false,
      platform: 'node',
      format: 'cjs',
      external: ['vscode'],
    });
    const module = { exports: {} as any };
    const vscode = {
      workspace: { isTrusted: true },
      Uri: { from: (value: any) => value },
      ViewColumn: { Beside: 2 },
      window: {
        showQuickPick: async (items: any[]) => items[0],
        showOpenDialog: async () => [{ fsPath: 'owned.jsonl' }],
        createWebviewPanel: () => {
          const panel = { webview: { html: '' }, dispose: () => {} };
          panels.push(panel);
          return panel;
        },
      },
    };
    const require = createRequire(`${process.cwd()}/package.json`);
    new Function('require', 'module', 'exports', output.outputFiles[0]!.text)(
      (id: string) => (id === 'vscode' ? vscode : require(id)),
      module,
      module.exports
    );
    const state = createEmptyComposerState();
    state.pendingImages = [{ itemId: 'image', name: 'owned', mimeType: 'image/png', sizeBytes: 1 }];
    const other = createEmptyComposerState();
    other.draft = 'other draft';
    let generation = 1;
    let cancelled = false;
    let gate: (() => void) | undefined;
    let calls = 0;
    let bound = 0;
    const controller = {
      generation: 1,
      folder: { uri: { toString: () => 'file:///owned' } },
      snapshot: { state: { sessionId: 'old', sessionFile: '/owned/old' } },
      setDraft: () => {},
      captureLifecycleIntent: () => {
        const captured = generation;
        return {
          valid: () => captured === generation,
          forkMessages: async () => [{ entryId: 'user', text: 'original' }],
          run: async () => {
            calls++;
            gate?.();
            if (!cancelled && captured === generation)
              controller.snapshot.state = { sessionId: 'next', sessionFile: '/owned/next' };
            return {
              cancelled,
              replacementIdentity: { sessionId: 'next', sessionFile: '/owned/next' },
              editorText: 'fork text',
              valid: () => captured === generation,
            };
          },
        };
      },
    };
    const instance = Object.create(module.exports['ChatTabManager'].prototype);
    instance.uiState = {
      captureIdentity: () => ({}),
      getComposerStateForIdentity: async () => structuredClone(state),
      setComposerStateForIdentity: async (_c: any, _i: any, next: any) =>
        Object.assign(state, next),
    };
    instance.contextForResource = () => ({ controller, target: {}, resource: {} });
    instance.promoteResource = async () => {
      bound++;
    };
    instance.renderResource = instance.postSnapshot = async () => {};
    instance.preparePromptContext = () => {
      throw new Error('No prompt/context/image preparation');
    };
    const send = (mode: string) => instance.handleRequestSend({}, mode, 'ack');
    for (const command of ['new', 'resume', 'fork', 'clone'])
      for (const mode of ['prompt', 'steer', 'follow_up']) {
        state.draft = `/${command}`;
        await send(mode);
        assert.equal(state.localCommandAck, 'ack');
        assert.equal(state.pendingImages[0]?.itemId, 'image');
        assert.equal(state.draft, 'fork text');
        assert.equal(other.draft, 'other draft');
      }
    const before = calls;
    cancelled = true;
    state.draft = '/new';
    state.localCommandAck = undefined;
    await send('prompt');
    assert.equal(state.draft, '/new');
    assert.equal(state.localCommandAck, undefined);
    cancelled = false;
    gate = () => {
      state.draft = 'newer';
      state.commandRevision = 2;
    };
    await send('prompt');
    assert.equal(state.draft, 'newer');
    assert.equal(state.localCommandAck, undefined);
    state.draft = '/clone';
    state.commandRevision = 3;
    gate = () => {
      state.commandRevision = 4;
    };
    await send('prompt');
    assert.equal(state.draft, '/clone');
    assert.equal(state.localCommandAck, undefined);
    gate = () => {
      generation++;
    };
    state.draft = '/new';
    await send('prompt');
    assert.equal(state.draft, '/new');
    assert.equal(state.localCommandAck, undefined);
    gate = undefined;
    for (const command of ['arminsayshi', 'dementedelves']) {
      state.draft = `/${command}`;
      await send('follow_up');
      assert.equal(state.draft, '');
      const html = panels.at(-1).webview.html;
      assert.match(html, /Content-Security-Policy/);
      assert.match(html, /Close Editor/);
      assert.ok(!html.includes('<a '));
      assert.ok(!html.includes('<script'));
      assert.equal(state.pendingImages[0]?.itemId, 'image');
    }
    assert.ok(calls > before);
    assert.equal(bound, 14);
  });
}
