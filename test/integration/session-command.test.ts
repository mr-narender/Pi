import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { createEmptyComposerState } from '../../src/webview/composer';

async function load(vscode: any) {
  const result = await build({
    stdin: {
      contents:
        "export {ChatTabManager} from './src/editorTabs/tabManager'; export {SessionController} from './src/sessions/sessionController'; export {mergeLocalCommands} from './src/commands/localCommand'; export {showChatSession} from './src/commands/sessionCommand';",
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
    (id: string) => (id === 'vscode' ? vscode : createRequire(`${process.cwd()}/package.json`)(id)),
    module,
    module.exports
  );
  return module.exports;
}

const stats = {
  sessionId: 'origin',
  sessionFile: '/owned/origin',
  userMessages: 2,
  assistantMessages: 3,
  totalMessages: 6,
  toolCalls: 4,
  toolResults: 1,
  tokens: { input: 100, output: 20, cacheRead: 30, cacheWrite: 40, total: 190 },
  cost: 0.125,
  contextUsage: { tokens: null, contextWindow: 8192, percent: null },
  totalEntries: 10,
  sessionName: 'Owned name',
};

test('session: actual Agentic editor bare busy no-model info, privacy, errors, origin and draft ACKs', async () => {
  const notices: any[] = [];
  const copies: string[] = [];
  let choice: string | undefined;
  let dialogGate: (() => Promise<void>) | undefined;
  const api = await load({
    workspace: { isTrusted: true },
    window: {
      showInformationMessage: async (...args: any[]) => {
        notices.push(args);
        if (dialogGate) await dialogGate();
        return choice;
      },
    },
    env: { clipboard: { writeText: async (text: string) => copies.push(text) } },
  });
  {
    const state = createEmptyComposerState();
    state.pendingImages = [{ itemId: 'chip', name: 'chip', mimeType: 'image/png', sizeBytes: 1 }];
    let calls = 0;
    let gate: (() => Promise<void>) | undefined;
    let fail = false;
    const controller = {
      generation: 1,
      snapshot: { state: { sessionId: 'origin', sessionFile: '/owned/origin', isStreaming: true } },
      showSessionStats: async () => {
        calls++;
        if (gate) await gate();
        if (fail) throw new Error('owned failure');
        return {
          ...stats,
          auth: 'SECRET',
          headers: { authorization: 'SECRET' },
          messages: ['SECRET'],
          tokens: { ...stats.tokens, raw: 'SECRET' },
        };
      },
      setDraft: () => {},
      prompt: () => {
        throw new Error('must not prompt');
      },
    };
    const instance = Object.create(api['ChatTabManager'].prototype);
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
    const send = () => instance.handleRequestSend({}, 'prompt');
    state.draft = ' /session  ';
    choice = 'Copy JSON';
    await send();
    assert.equal(calls, 1, 'bare session must read native stats');
    assert.equal(state.draft, '');
    assert.equal(state.pendingImages.length, 1);
    const detail = notices.at(-1)[1].detail as string;
    assert.match(detail, /Owned name/);
    assert.match(detail, /All branches/);
    assert.match(detail, /Entries: 10/);
    assert.match(detail, /unknown/i);
    assert.match(detail, /40/);
    assert.ok(!copies.at(-1)!.includes('SECRET'));
    assert.equal(JSON.parse(copies.at(-1)!).contextUsage.tokens, null);
    choice = undefined;
    state.draft = '/session args';
    await send();
    assert.equal(calls, 1);
    assert.equal(state.draft, '/session args');
    assert.match(state.recovery!.detail, /does not accept arguments/);
    fail = true;
    state.draft = '/session';
    await send();
    assert.equal(state.draft, '', 'failure does not restore consumed menu text');
    fail = false;
    for (const change of ['draft', 'retype', 'generation', 'session', 'newer']) {
      let release!: () => void;
      gate = () =>
        new Promise<void>((r) => {
          release = r;
        });
      state.draft = '/session';
      const before = notices.length;
      const pending = send();
      for (let i = 0; i < 30 && !release; i++) await new Promise((r) => setTimeout(r, 0));
      assert.ok(release);
      if (change === 'draft') state.draft = 'fresh';
      if (change === 'retype') state.commandRevision = (state.commandRevision ?? 0) + 1;
      if (change === 'generation') controller.generation++;
      if (change === 'session') controller.snapshot.state.sessionId = 'replacement';
      if (change === 'newer') {
        gate = undefined;
        await send();
        state.draft = '/session';
      }
      release();
      await pending;
      assert.equal(
        state.draft,
        change === 'draft' ? 'fresh' : change === 'newer' ? '/session' : ''
      );
      assert.equal(state.pendingImages.length, 1);
      if (['generation', 'session'].includes(change)) assert.equal(notices.length, before);
    }
    gate = undefined;
    let release!: () => void;
    dialogGate = () =>
      new Promise<void>((r) => {
        release = r;
      });
    choice = 'Copy JSON';
    state.draft = '/session';
    const before = copies.length;
    const pending = send();
    for (let i = 0; i < 30 && !release; i++) await new Promise((r) => setTimeout(r, 0));
    controller.generation++;
    release();
    await pending;
    assert.equal(copies.length, before, 'stale modal selection must not copy');
    assert.equal(state.draft, '');
    dialogGate = undefined;
  }
  const discovered = api.mergeLocalCommands([
    { name: 'session', source: 'extension' },
    { name: 'extension:session', source: 'extension' },
  ]);
  assert.equal(discovered.filter((c: any) => c.name === 'session').length, 1);
  assert.equal(discovered.find((c: any) => c.name === 'session').source, 'builtin');
  assert.ok(discovered.some((c: any) => c.name === 'extension:session'));
});

{
  test(`session correction: compiled editor Cancel, Done, Copy and guarded ACKs`, async () => {
    let choice: string | undefined;
    let clipboardError = false;
    let onDialog: (() => void) | undefined;
    let onCopy: (() => void) | undefined;
    const copies: string[] = [];
    const notices: any[] = [];
    const api = await load({
      workspace: { isTrusted: true },
      window: {
        showInformationMessage: async (...args: any[]) => {
          notices.push(args);
          onDialog?.();
          return choice;
        },
      },
      env: {
        clipboard: {
          writeText: async (text: string) => {
            if (clipboardError) throw new Error('clipboard denied');
            copies.push(text);
            onCopy?.();
          },
        },
      },
    });
    const state = createEmptyComposerState();
    const chips = [{ itemId: 'chip', name: 'chip', mimeType: 'image/png', sizeBytes: 1 }];
    const controller = {
      generation: 1,
      snapshot: { state: { sessionId: 'origin', sessionFile: '/owned/origin' } },
      showSessionStats: async () => stats,
      setDraft: () => {},
      prompt: () => {
        throw new Error('must not prompt');
      },
    };
    const instance = Object.create(api['ChatTabManager'].prototype);
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
    const send = () => instance.handleRequestSend({}, 'prompt', 'owned-ack');
    const reset = () => {
      delete state.localCommandAck;
      delete state.recovery;
      delete state.commandRevision;
      state.composerResetSeq = 0;
      Object.assign(state, createEmptyComposerState());
      state.draft = ' /session  ';
      state.pendingImages = structuredClone(chips);
    };
    reset();
    const before = structuredClone(state);
    await send();
    assert.equal(state.draft, '', 'undefined Cancel must not restore consumed /session draft');
    assert.equal(state.composerResetSeq, before.composerResetSeq, 'Cancel must not reset');
    assert.equal(state.localCommandAck, before.localCommandAck, 'Cancel must not ACK acceptance');
    assert.deepEqual(state.pendingImages, chips);
    assert.equal(copies.length, 0, 'Cancel must not copy');
    assert.equal(state.recovery, before.recovery);
    assert.deepEqual(notices.at(-1).slice(2), ['Done', 'Copy JSON']);
    assert.equal(await api.showChatSession(controller), false, 'menu cancellation must propagate');
    choice = 'Done';
    assert.equal(await api.showChatSession(controller), true, 'menu Done accepts viewing');
    state.draft = ' /session  ';
    await send();
    assert.equal(state.draft, '');
    assert.equal(state.localCommandAck, 'owned-ack');
    assert.equal(state.composerResetSeq, (before.composerResetSeq ?? 0) + 1);
    assert.equal(copies.length, 0);
    assert.deepEqual(state.pendingImages, chips);
    reset();
    choice = 'Copy JSON';
    await send();
    assert.equal(state.draft, '');
    assert.equal(state.localCommandAck, 'owned-ack');
    assert.deepEqual(JSON.parse(copies[0]!), stats);
    assert.deepEqual(state.pendingImages, chips);
    reset();
    clipboardError = true;
    await send();
    assert.equal(state.draft, '');
    assert.equal(state.localCommandAck, undefined);
    assert.equal(state.composerResetSeq, 0);
    assert.match(state.recovery!.detail, /clipboard denied/);
    clipboardError = false;
    for (const change of [
      'draft',
      'images',
      'revision',
      'generation',
      'session',
      'file',
      'copy-generation',
    ]) {
      reset();
      const copyCount: number = copies.length;
      const mutate = () => {
        if (change === 'draft') state.draft = 'newer draft';
        if (change === 'images') state.pendingImages.push({ ...chips[0]!, itemId: 'new' });
        if (change === 'revision') state.commandRevision = (state.commandRevision ?? 0) + 1;
        if (change === 'generation' || change === 'copy-generation') controller.generation++;
        if (change === 'session') controller.snapshot.state.sessionId += '-new';
        if (change === 'file') controller.snapshot.state.sessionFile += '-new';
      };
      onDialog = change === 'copy-generation' ? undefined : mutate;
      onCopy = change === 'copy-generation' ? mutate : undefined;
      await send();
      assert.deepEqual(
        state.pendingImages,
        change === 'images' ? [...chips, { ...chips[0]!, itemId: 'new' }] : chips
      );
      if (change === 'images') {
        assert.equal(state.draft, '');
        assert.equal(state.localCommandAck, 'owned-ack');
      } else {
        assert.equal(state.draft, change === 'draft' ? 'newer draft' : '');
        assert.equal(state.localCommandAck, undefined);
        assert.equal(state.composerResetSeq, 0);
      }
      if (['generation', 'session', 'file'].includes(change))
        assert.equal(copies.length, copyCount);
    }
  });
}

test('session: actual controller captures client identity, all-entry count and safe finite projection', async () => {
  const api = await load({});
  const controller = Object.create(api.SessionController.prototype);
  controller.supervisor = { currentGeneration: 1 };
  controller.state = {
    state: { sessionId: 'origin', sessionFile: '/owned/origin' },
    messages: ['preserved'],
  };
  controller.fire = () => {};
  let release!: (s: any) => void;
  const client = {
    getSessionStats: async () => ({
      ...stats,
      cost: Infinity,
      auth: 'SECRET',
      tokens: { ...stats.tokens, output: NaN },
    }),
    getState: () =>
      new Promise((r) => {
        release = r;
      }),
    getEntries: async () => ({
      entries: Array.from({ length: 10 }, () => ({ raw: 'SECRET' })),
      leafId: 'owned',
    }),
  };
  controller.requireClient = () => client;
  const pending = controller.showSessionStats();
  for (let i = 0; i < 30 && !release; i++) await new Promise((r) => setTimeout(r, 0));
  assert.ok(release, 'session stats must read native state for identity/name');
  release({
    sessionId: 'origin',
    sessionFile: '/owned/origin',
    sessionName: 'Native name',
    auth: 'SECRET',
  });
  const info = await pending;
  assert.equal(info.sessionName, 'Native name');
  assert.equal(info.totalEntries, 10);
  assert.equal(info.cost, undefined);
  assert.equal(info.tokens.output, undefined);
  assert.ok(!JSON.stringify(info).includes('SECRET'));
  assert.deepEqual(controller.state.messages, ['preserved']);
  for (const change of ['generation', 'session', 'client', 'returned']) {
    release = undefined as any;
    const operation = controller.showSessionStats();
    for (let i = 0; i < 30 && !release; i++) await new Promise((r) => setTimeout(r, 0));
    const last = controller.state.lastSessionStats;
    if (change === 'generation') controller.supervisor.currentGeneration++;
    if (change === 'session') controller.state.state.sessionId = 'replacement';
    if (change === 'client') controller.requireClient = () => ({ ...client });
    release({
      sessionId: change === 'returned' ? 'other' : controller.state.state.sessionId,
      sessionFile: '/owned/origin',
    });
    await assert.rejects(operation, /originating chat changed/i);
    assert.equal(controller.state.lastSessionStats, last);
    controller.requireClient = () => client;
  }
});
