import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { createEmptyComposerState } from '../../src/webview/composer';

test('name: actual editor/sidebar bare display, whole trimmed names, busy no-model and origin drafts', async () => {
  const notices: string[] = [];
  const result = await build({
    stdin: {
      contents:
        "export {ChatTabManager} from './src/editorTabs/tabManager'; export {ChatPanelProvider} from './src/webview/provider'; export {mergeLocalCommands} from './src/commands/localCommand';",
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
        showInformationMessage: async (text: string) => notices.push(text),
        showWarningMessage: async (text: string) => notices.push(text),
        showInputBox: () => {
          throw new Error('bare name must not open dialog');
        },
      },
      env: {
        clipboard: {
          writeText: () => {
            throw new Error('must not copy');
          },
        },
      },
    }),
    module,
    module.exports
  );
  const discovered = module.exports.mergeLocalCommands([
    { name: 'name', source: 'extension' },
    { name: 'extension:name', source: 'extension' },
  ]);
  assert.equal(discovered.filter((c: any) => c.name === 'name').length, 1);
  assert.equal(discovered.find((c: any) => c.name === 'name').source, 'builtin');
  assert.ok(discovered.some((c: any) => c.name === 'extension:name'));
  for (const route of ['editor', 'sidebar']) {
    const state = createEmptyComposerState();
    state.pendingImages = [{ itemId: 'chip', name: 'chip', mimeType: 'image/png', sizeBytes: 1 }];
    let fail = false;
    let gate: (() => Promise<void>) | undefined;
    const names: string[] = [];
    const controller = {
      generation: 1,
      snapshot: {
        state: {
          sessionId: 'origin',
          sessionFile: '/owned/origin',
          sessionName: '',
          isStreaming: true,
          model: undefined,
        },
      },
      renameSession: async (name: string) => {
        if (fail) throw new Error('persistence failed');
        names.push(name);
        if (gate) await gate();
        controller.snapshot.state.sessionName = name;
      },
      setDraft: () => {},
      prompt: () => {
        throw new Error('must not prompt');
      },
    };
    const instance = Object.create(
      module.exports[route === 'editor' ? 'ChatTabManager' : 'ChatPanelProvider'].prototype
    );
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
    const send = () =>
      route === 'editor'
        ? instance.handleRequestSend({}, 'prompt', true)
        : instance.handleRequestSend(controller, 'prompt');
    state.draft = '/name  ';
    await send();
    assert.equal(notices.at(-1), 'Usage: /name <name>', 'bare unnamed must display native usage');
    assert.equal(names.length, 0);
    assert.equal(state.draft, '');
    for (const name of ['two  words', '"quoted words"', 'already current']) {
      state.draft = `  /name   ${name}   `;
      await send();
      assert.equal(names.at(-1), name);
      assert.equal(state.draft, '');
      assert.equal(state.pendingImages.length, 1);
    }
    state.draft = '/name';
    await send();
    assert.equal(notices.at(-1), 'Session name: already current');
    fail = true;
    state.draft = '/name fails';
    await send();
    assert.equal(state.draft, '/name fails');
    assert.match(state.recovery!.detail, /persistence failed/);
    fail = false;
    for (const change of ['draft', 'retype', 'generation', 'session']) {
      let finish!: () => void;
      gate = () =>
        new Promise<void>((r) => {
          finish = r;
        });
      state.draft = '/name pending';
      const pending = send();
      for (let i = 0; i < 30 && !finish; i++) await new Promise((r) => setTimeout(r, 0));
      assert.ok(finish);
      if (change === 'draft') state.draft = 'fresh';
      if (change === 'retype') state.commandRevision = (state.commandRevision ?? 0) + 1;
      if (change === 'generation') controller.generation++;
      if (change === 'session') controller.snapshot.state.sessionId = 'replacement';
      finish();
      await pending;
      assert.equal(state.draft, change === 'draft' ? 'fresh' : '/name pending');
      assert.equal(state.pendingImages.length, 1);
    }
  }
});

test('name: actual controller persistence rejects stale readback and write failure', async () => {
  const result = await build({
    stdin: {
      contents: "export {SessionController} from './src/sessions/sessionController';",
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
    (id: string) => (id === 'vscode' ? {} : createRequire(`${process.cwd()}/package.json`)(id)),
    module,
    module.exports
  );
  const controller = Object.create(module.exports.SessionController.prototype);
  controller.supervisor = { currentGeneration: 1 };
  controller.state = {
    generation: 1,
    state: { sessionId: 'origin', sessionFile: '/owned/origin', sessionName: 'old' },
    messages: [{ text: 'preserve' }],
  };
  let release!: (state: any) => void;
  const calls: string[] = [];
  let fail = false;
  const client = {
    setSessionName: async (name: string) => {
      if (fail) throw new Error('disk denied');
      calls.push(name);
    },
    getState: () =>
      new Promise((r) => {
        release = r;
      }),
  };
  controller.requireClient = () => client;
  controller.fire = () => {};
  const pending = controller.renameSession('new');
  for (let i = 0; i < 20 && !release; i++) await new Promise((r) => setTimeout(r, 0));
  assert.ok(release);
  controller.state.state = {
    sessionId: 'replacement',
    sessionFile: '/owned/replacement',
    sessionName: 'other',
  };
  release({ sessionId: 'origin', sessionFile: '/owned/origin', sessionName: 'new' });
  await assert.rejects(pending, /originating chat changed/i);
  assert.equal(controller.state.state.sessionName, 'other');
  assert.deepEqual(controller.state.messages, [{ text: 'preserve' }]);
  fail = true;
  await assert.rejects(controller.renameSession('failed'), /disk denied/);
  assert.deepEqual(calls, ['new']);
  fail = false;
  controller.state.state.model = { provider: 'owned', id: 'unchanged' };
  controller.state.pendingSteering = ['queue'];
  const preserved = structuredClone(controller.state);
  release = undefined as any;
  const success = controller.renameSession('whole multiword');
  for (let i = 0; i < 20 && !release; i++) await new Promise((r) => setTimeout(r, 0));
  release({
    sessionId: 'replacement',
    sessionFile: '/owned/replacement',
    sessionName: 'native normalized',
    model: { id: 'must not overwrite' },
  });
  await success;
  preserved.state.sessionName = 'native normalized';
  assert.deepEqual(
    controller.state,
    preserved,
    'rename refresh only changes originating title metadata'
  );
});
