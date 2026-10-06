import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { createEmptyComposerState } from '../../src/webview/composer';

{
  test(`hotkeys: compiled editor native editor/help, busy no-model, cancellation and origin ACKs`, async () => {
    let choice: string | undefined = 'Keyboard Shortcuts';
    let mutate: (() => void) | undefined;
    let fail = false;
    const notices: any[] = [];
    const invocations: any[] = [];
    const result = await build({
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
      window: {
        showInformationMessage: async (...args: any[]) => {
          notices.push(args);
          mutate?.();
          return choice;
        },
      },
      commands: {
        executeCommand: async (...args: any[]) => {
          invocations.push(args);
          if (fail) throw new Error('editor unavailable');
        },
      },
    };
    new Function('require', 'module', 'exports', result.outputFiles[0]!.text)(
      (id: string) =>
        id === 'vscode' ? vscode : createRequire(`${process.cwd()}/package.json`)(id),
      module,
      module.exports
    );
    const state = createEmptyComposerState();
    const chips = [{ itemId: 'chip', name: 'chip', mimeType: 'image/png', sizeBytes: 1 }];
    const controller = {
      generation: 1,
      snapshot: { state: { sessionId: 'origin', sessionFile: '/owned/origin', isStreaming: true } },
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
      throw new Error('must not expand');
    };
    const send = () => instance.handleRequestSend({}, 'prompt', 'ack');
    const reset = () => {
      delete state.localCommandAck;
      delete state.recovery;
      state.commandRevision = 0;
      state.composerResetSeq = 0;
      state.draft = ' /hotkeys  ';
      state.pendingImages = structuredClone(chips);
    };
    reset();
    await send();
    assert.deepEqual(
      invocations,
      [['workbench.action.openGlobalKeybindings', '@ext:mr-narender.pi']],
      'must invoke native filtered Keyboard Shortcuts editor'
    );
    const detail = notices.at(-1)[1].detail;
    for (const pattern of [
      /Shift\+Tab/,
      /piRpc.cycleThinkingLevel/,
      /busy/,
      /Enter/,
      /Shift\+Enter/,
      /queue/i,
      /completion/i,
      /Tab/,
      /IME/,
      /terminal-only/i,
      /overrides/i,
    ])
      assert.match(detail, pattern);
    assert.equal(state.draft, '');
    assert.equal(state.localCommandAck, 'ack');
    assert.deepEqual(state.pendingImages, chips);
    reset();
    choice = undefined;
    await send();
    assert.equal(state.draft, '', 'Cancel preserves consumption, not action success');
    assert.equal(state.localCommandAck, undefined);
    assert.equal(state.composerResetSeq, 0);
    reset();
    choice = 'Done';
    await send();
    assert.equal(state.draft, '');
    assert.equal(invocations.length, 1);
    reset();
    state.draft = '/hotkeys args';
    await send();
    assert.match(state.recovery!.detail, /does not accept arguments/);
    assert.equal(invocations.length, 1);
    reset();
    choice = 'Keyboard Shortcuts';
    fail = true;
    await send();
    assert.equal(state.draft, '', 'failed action does not restore menu text');
    assert.match(state.recovery!.detail, /editor unavailable/);
    fail = false;
    for (const change of ['draft', 'revision', 'generation', 'session', 'file', 'images']) {
      reset();
      const before: number = invocations.length;
      mutate = () => {
        if (change === 'draft') state.draft = 'newer';
        if (change === 'revision') state.commandRevision = (state.commandRevision ?? 0) + 1;
        if (change === 'generation') controller.generation++;
        if (change === 'session') controller.snapshot.state.sessionId += '-new';
        if (change === 'file') controller.snapshot.state.sessionFile += '-new';
        if (change === 'images') state.pendingImages.push({ ...chips[0]!, itemId: 'new' });
      };
      await send();
      assert.equal(state.draft, change === 'draft' ? 'newer' : '');
      assert.equal(state.pendingImages.length, change === 'images' ? 2 : 1);
      if (['generation', 'session', 'file'].includes(change))
        assert.equal(invocations.length, before);
    }
  });
}
