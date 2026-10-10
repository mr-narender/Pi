import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { createEmptyComposerState } from '../../src/webview/composer';

async function load(contents: string, vscode: any = {}) {
  const result = await build({
    stdin: { contents, resolveDir: process.cwd() },
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

test('compact actual controller rejects busy and queued work without aborting or sending', async () => {
  const { SessionController } = await load(
    "export {SessionController} from './src/sessions/sessionController';"
  );
  const c = Object.create(SessionController.prototype);
  c.state = { state: { sessionId: 'owned', sessionFile: '/owned/file' }, leafId: 'leaf' };
  let calls = 0;
  const client = {
    getState: async () => ({ ...c.state.state }),
    compact: async () => {
      calls++;
      return { summary: 'owned', firstKeptEntryId: 'leaf', tokensBefore: 1 };
    },
  };
  c.supervisor = { currentClient: client };
  c.fire = () => {};
  for (const [key, value] of [
    ['isStreaming', true],
    ['isCompacting', true],
    ['pendingMessageCount', 1],
  ] as const) {
    c.state.state[key] = value;
    await assert.rejects(c.compact(), /idle|busy/i);
    delete c.state.state[key];
  }
  c.state.retry = {};
  await assert.rejects(c.compact(), /idle|busy/i);
  delete c.state.retry;
  c.state.switchingSession = true;
  await assert.rejects(c.compact(), /idle|busy/i);
  assert.equal(calls, 0);
  delete c.state.switchingSession;
  for (const queue of [
    { steering: ['owned'], followUp: [] },
    { steering: [], followUp: ['owned'] },
  ]) {
    c.state.queue = queue;
    await assert.rejects(c.compact(), /idle/i);
  }
  c.state.queue = { steering: [], followUp: [] };
  const old = client.compact;
  for (const outcome of ['undefined', 'failure', 'veto', 'abort']) {
    client.compact = async () => {
      c.state.state.isCompacting = true;
      if (outcome === 'undefined') return undefined as any;
      throw new Error(outcome + ' Authorization secret-canary');
    };
    await assert.rejects(c.compact(), (error: Error) => {
      assert.doesNotMatch(error.message, /secret-canary|Authorization/);
      return true;
    });
    assert.equal(c.state.state.isCompacting, false);
    assert.equal(c.manualCompactPending, false);
  }
  client.compact = old;
  assert.equal((await c.compact()).summary, 'owned');
  assert.equal(c.state.state.isCompacting, false);
});

test('compact held native state reserves against steering and rechecks current busy state', async () => {
  const { SessionController } = await load(
    "export {SessionController} from './src/sessions/sessionController';"
  );
  for (const action of ['prompt', 'steer', 'followUp', 'busy'] as const) {
    const c = Object.create(SessionController.prototype);
    c.state = {
      state: { sessionId: 'owned', sessionFile: '/owned/file' },
      queue: { steering: [], followUp: [] },
    };
    const captured = { ...c.state.state };
    let release!: (value: any) => void;
    let compactCalls = 0;
    let sends = 0;
    const client = {
      getState: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
      compact: async () => {
        compactCalls++;
        return { summary: 'owned', firstKeptEntryId: 'leaf', tokensBefore: 1 };
      },
      prompt: async () => {
        sends++;
      },
      steer: async () => {
        sends++;
      },
      followUp: async () => {
        sends++;
      },
    };
    c.supervisor = { currentClient: client };
    c.fire = () => {};
    const pending = c.compact();
    const settled = pending.then(
      () => 'success',
      () => 'rejected'
    );
    if (action === 'busy') c.state.state.isStreaming = true;
    else await assert.rejects(c.prompt('owned steering', action), /compaction/i);
    release(captured);
    assert.equal(await settled, action === 'busy' ? 'rejected' : 'success');
    assert.equal(compactCalls, action === 'busy' ? 0 : 1);
    assert.equal(sends, 0);
    c.state.state.isStreaming = false;
    await c.prompt('ordinary accepted send', 'prompt');
    assert.equal(sends, 1);
  }
});

test('compact reservation rejects sibling mutations during preflight and native in-flight', async () => {
  const { SessionController, beginModelOperation } = await load(
    "export {SessionController} from './src/sessions/sessionController'; export {beginModelOperation} from './src/commands/modelOperations';"
  );
  const c = Object.create(SessionController.prototype);
  c.state = { state: { sessionId: 'owned', sessionFile: '/owned/file' } };
  let stateRelease!: (value: any) => void;
  let compactRelease!: (value: any) => void;
  let entered!: () => void;
  const nativeEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  c.supervisor = {
    currentClient: {
      getState: () =>
        new Promise((resolve) => {
          stateRelease = resolve;
        }),
      compact: () => {
        entered();
        return new Promise((resolve) => {
          compactRelease = resolve;
        });
      },
    },
  };
  c.fire = () => {};
  const pending = c.compact();
  const mutations = [
    () => c.prompt('owned', 'steer'),
    () => c.selectModel('owned', 'owned'),
    () => c.cycleModel(),
    () => c.applyScopedModels([], 'owned', true, false),
    () => c.setThinkingLevel('high'),
    () => c.cycleThinkingLevel(),
    () => c.setSteeringMode('all'),
    () => c.setFollowUpMode('all'),
    () => c.toggleAutoCompaction(),
    () => c.toggleAutoRetry(true),
    () => c.newSession(),
    () => c.switchSession('/owned/file'),
    () => c.fork('owned'),
    () => c.forkInPlace('owned'),
    () => c.clone(),
    () => c.restart(),
    () => c.start(),
    () => c.renameSession('owned'),
    () => c.runBash('owned'),
  ];
  for (const phase of ['preflight', 'native']) {
    for (const mutate of mutations) await assert.rejects(mutate(), /compaction/i);
    assert.throws(() => beginModelOperation(c), /compaction/i);
    if (phase === 'preflight') {
      stateRelease({ ...c.state.state });
      await nativeEntered;
    }
  }
  compactRelease({ summary: 'owned', firstKeptEntryId: 'leaf', tokensBefore: 1 });
  await pending;
  assert.equal(c.manualCompactPending, false);
});

test(`compact editor: bare/whole arguments, no expansion, origin ACK, failure sanitation`, async () => {
  const state = createEmptyComposerState();
  const chips = [{ itemId: 'owned', name: 'owned', mimeType: 'image/png', sizeBytes: 1 }];
  const calls: any[] = [];
  let fail = false;
  let mutate = () => {};
  const controller = {
    generation: 1,
    snapshot: { state: { sessionId: 'owned', sessionFile: '/owned/file' } },
    setDraft() {},
    captureCompactIntent() {
      const generation = this.generation;
      return {
        valid: () => this.generation === generation,
        run: async (instructions?: string) => {
          calls.push(instructions);
          mutate();
          if (fail) throw new Error('Authorization: Bearer secret-canary provider/config');
          return { summary: 'owned', firstKeptEntryId: 'leaf', tokensBefore: 1 };
        },
      };
    },
    prompt() {
      throw new Error('prompt forbidden');
    },
  };
  const api = await load("export {ChatTabManager} from './src/editorTabs/tabManager'; ", {
    workspace: { isTrusted: true },
    window: {
      showInputBox() {
        throw new Error('typed command dialog forbidden');
      },
    },
  });
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
    throw new Error('expansion forbidden');
  };
  const send = () => instance.handleRequestSend({}, 'prompt', 'ack');
  const reset = (draft = '/compact') => {
    state.draft = draft;
    state.commandRevision = 0;
    state.composerResetSeq = 0;
    state.pendingImages = structuredClone(chips);
    delete state.localCommandAck;
    delete state.recovery;
    mutate = () => {};
    fail = false;
  };
  for (const [draft, instructions] of [
    ['/compact', undefined],
    ['/compact   keep  whole\n remainder  ', 'keep  whole\n remainder'],
  ] as const) {
    reset(draft);
    await send();
    assert.equal(calls.at(-1), instructions);
    assert.equal(calls.length > 0, true, 'native compact must be requested');
    assert.equal(state.draft, '');
    assert.equal(state.localCommandAck, 'ack');
    assert.deepEqual(state.pendingImages, chips);
  }
  reset();
  fail = true;
  await send();
  assert.equal(state.draft, '');
  assert.equal(state.localCommandAck, undefined);
  assert.ok(state.recovery);
  assert.doesNotMatch(
    JSON.stringify(state.recovery),
    /secret-canary|Authorization|provider\/config/
  );
  for (const change of ['newer', 'retyped', 'generation', 'images']) {
    reset();
    mutate = () => {
      if (change === 'newer') state.draft = 'fresh';
      if (change === 'retyped') state.commandRevision = 1;
      if (change === 'generation') controller.generation++;
      if (change === 'images') state.pendingImages.push({ ...chips[0]!, itemId: 'new' });
    };
    await send();
    if (change === 'newer') assert.equal(state.draft, 'fresh');
    else if (change !== 'images') assert.equal(state.draft, '');
    assert.equal(state.pendingImages.length, change === 'images' ? 2 : 1);
  }
});

test('compact close/delete sibling gates run before any implicit abort or tab close', async () => {
  const { ChatTabManager } = await load(
    "export {ChatTabManager} from './src/editorTabs/tabManager';",
    {
      window: {
        tabGroups: {
          get all() {
            throw new Error('tab close forbidden');
          },
        },
      },
    }
  );
  const manager = Object.create(ChatTabManager.prototype);
  const controller = {
    snapshot: { state: { sessionFile: '/owned/file' } },
    assertNoManualCompaction() {
      throw new Error('Compaction is in progress.');
    },
    abort() {
      throw new Error('implicit abort forbidden');
    },
  };
  manager.trackedControllers = new Set([controller]);
  manager.contextForResource = () => ({ controller });
  assert.throws(() => manager.stopControllersForSessionFile('/owned/file'), /Compaction/);
  await assert.rejects(manager.closeForSessionFile('/owned/file'), /Compaction/);
  await assert.rejects(manager.closeResource({ toString: () => 'owned' }), /Compaction/);
});

test('compact actual menu Cancel differs from accepted empty', async () => {
  let value: string | undefined;
  const calls: any[] = [];
  const controller = {
    snapshot: { state: {} },
    captureCompactIntent: () => ({
      valid: () => true,
      run: async (args?: string) => {
        calls.push(args);
        return { summary: 'owned' };
      },
    }),
  };
  const source = await readFile('src/extension.ts', 'utf8');
  const start = source.indexOf("  registrations.set('piRpc.compact',");
  const end = source.indexOf("  registrations.set('piRpc.toggleAutoCompaction'", start);
  const api = await load(
    `import * as vscode from 'vscode'; import {compactCommand, compactMenu} from './src/commands/compactCommand'; export function register(registrations, withController) { ${source.slice(start, end)} }`,
    { workspace: { isTrusted: true }, window: { showInputBox: async () => value } }
  );
  const registrations = new Map();
  api.register(registrations, (run: any) => run(controller));
  await registrations.get('piRpc.compact')();
  assert.deepEqual(calls, []);
  value = '';
  await registrations.get('piRpc.compact')();
  assert.deepEqual(calls, [undefined]);
});
