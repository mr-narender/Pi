import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { createInitialControllerState } from '../../src/state/types';
import { modelToolsSnapshot } from '../../src/modelTools/snapshot';
import { RpcClient } from '../../src/rpc/client';
import { createEmptyComposerState } from '../../src/webview/composer';

async function helper() {
  assert.ok(existsSync('host/model-tools.mjs'), 'lazy public SDK model-tools bridge is missing');
  return import(pathToFileURL(resolve('host/model-tools.mjs')).href);
}
function native() {
  let active = ['read'];
  const all = [
    { name: 'read', description: 'Read files', exposure: 'direct', parameters: { type: 'object' } },
    { name: 'write', description: 'Write files', exposure: 'direct' },
    { name: 'deferred_tool', description: 'Lazy tool', exposure: 'deferred' },
    { name: 'private_tool', description: 'Hidden', exposure: 'hidden' },
  ];
  const calls: string[][] = [];
  return {
    all,
    calls,
    session: {
      getAllTools: () => all,
      getActiveToolNames: () => active,
      setActiveToolsByName(names: string[]) {
        calls.push(names);
        active = names.filter((name) => name !== 'deferred_tool');
      },
    },
    setActive(names: string[]) {
      active = names;
    },
  };
}
test('model tools read uses public filtered registry and hides schemas, sources and hidden tools', async () => {
  const { readModelTools } = await helper(),
    f = native(),
    result = readModelTools(f.session);
  assert.deepEqual(result.active, ['read']);
  assert.deepEqual(
    result.tools.map((tool: any) => tool.name),
    ['deferred_tool', 'read', 'write']
  );
  assert.equal(result.tools[1].parameters, undefined);
  assert.equal(result.tools[1].sourceInfo, undefined);
  assert.equal(f.calls.length, 0);
  assert.match(result.revision, /^[a-f0-9]{64}$/);
});
test('stale catalog or external active change refuses Apply before native mutation', async () => {
  const { readModelTools, setModelTools } = await helper(),
    f = native(),
    view = readModelTools(f.session);
  f.setActive(['write']);
  assert.throws(() => setModelTools(f.session, view.revision, ['read']), /STALE/);
  assert.equal(f.calls.length, 0);
  const current = readModelTools(f.session);
  f.all[0]!.description = 'Changed semantics';
  assert.throws(() => setModelTools(f.session, current.revision, ['read']), /STALE/);
  assert.equal(f.calls.length, 0);
});
test('Apply validates exact offered names and reports actual native effects without rollback', async () => {
  const { readModelTools, setModelTools } = await helper(),
    f = native(),
    view = readModelTools(f.session);
  for (const names of [['private_tool'], ['unknown'], ['read', 'read']])
    assert.throws(() => setModelTools(f.session, view.revision, names), /INVALID/);
  assert.equal(f.calls.length, 0);
  const result = setModelTools(f.session, view.revision, ['write', 'deferred_tool']);
  assert.deepEqual(result.active, ['write']);
  assert.equal(result.matched, false);
  assert.deepEqual(f.calls, [['write', 'deferred_tool']]);
  const cleared = setModelTools(f.session, result.revision, []);
  assert.deepEqual(cleared.active, []);
  assert.equal(cleared.matched, true);
});

test('setter failure after active mutation reads back actual state without a hidden retry', async () => {
  const { readModelTools, setModelTools } = await helper(),
    f = native(),
    view = readModelTools(f.session);
  f.session.setActiveToolsByName = (names: string[]) => {
    f.calls.push(names);
    f.setActive(names);
    throw Error('resource loader failed');
  };
  const result = setModelTools(f.session, view.revision, ['write']);
  assert.deepEqual(result.active, ['write']);
  assert.equal(result.applyFailed, true);
  assert.equal(f.calls.length, 1);
});

async function controllerFixture() {
  const output = await build({
    stdin: {
      contents:
        "export {SessionController} from './src/sessions/sessionController'; export {ChatTabManager} from './src/editorTabs/tabManager';",
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    external: ['vscode'],
  });
  const require = createRequire(`${process.cwd()}/package.json`),
    module = { exports: {} as any };
  const folder = { name: 'owned', uri: { toString: () => 'file:///owned', fsPath: '/owned' } };
  const workspace = {
    isTrusted: true,
    workspaceFolders: [folder],
    getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }),
  };
  new Function('require', 'module', 'exports', output.outputFiles[0]!.text)(
    (name: string) => (name === 'vscode' ? { workspace } : require(name)),
    module,
    module.exports
  );
  const controller = Object.create(module.exports.SessionController.prototype),
    f = native(),
    { readModelTools, setModelTools } = await helper();
  const calls: string[] = [];
  const client = {
    hasCompactionConflict: false,
    getState: async () => ({ ...controller.state.state }),
    engineCommand: async (name: string, _origin: unknown, payload: any) => {
      calls.push(name);
      return name === 'read_model_tools'
        ? readModelTools(f.session)
        : setModelTools(f.session, payload.revision, payload.names);
    },
  };
  Object.assign(controller, {
    folder,
    state: {
      ...createInitialControllerState('owned', '/owned'),
      connectionState: 'ready',
      draft: 'keep my draft',
      state: { sessionId: 'owned', sessionFile: '/owned/session.jsonl', isIdle: true },
    },
    supervisor: { currentClient: client, currentGeneration: 1 },
    navigationEpoch: 1,
    authDisposed: false,
    fire() {},
  });
  return { controller, client, calls, f, workspace, ChatTabManager: module.exports.ChatTabManager };
}
test('controller tools fetch is explicit; Apply preserves draft and publishes authoritative thin readback', async () => {
  const f = await controllerFixture();
  assert.deepEqual(f.calls, []);
  await f.controller.requestModelTools('view:1', () => true);
  assert.deepEqual(f.calls, ['read_model_tools']);
  assert.equal(f.controller.snapshot.modelTools.requestId, 'view:1');
  const revision = f.controller.snapshot.modelTools.revision;
  await f.controller.applyModelTools('view:2', revision, ['write'], () => true);
  assert.deepEqual(f.calls, ['read_model_tools', 'set_model_tools']);
  assert.deepEqual(f.controller.snapshot.modelTools.active, ['write']);
  assert.deepEqual(f.controller.snapshot.modelTools.tools, []);
  assert.equal(f.controller.snapshot.draft, 'keep my draft');
  assert.equal(f.controller.snapshot.modelTools.requestId, 'view:2');
});
test('stale client/navigation or busy Apply never changes native tools', async () => {
  const f = await controllerFixture();
  await f.controller.requestModelTools('view:1', () => true);
  const revision = f.controller.snapshot.modelTools.revision;
  f.controller.navigationEpoch++;
  await f.controller.applyModelTools('view:2', revision, ['write'], () => true);
  assert.equal(f.calls.length, 1);
  assert.equal(f.f.calls.length, 0);
  await f.controller.requestModelTools('view:3', () => true);
  f.controller.state.connectionState = 'busy';
  f.controller.state.state.isIdle = false;
  await f.controller.applyModelTools(
    'view:4',
    f.controller.snapshot.modelTools.revision,
    ['write'],
    () => true
  );
  assert.equal(f.f.calls.length, 0);
  assert.match(f.controller.snapshot.modelTools.message, /finish|idle/i);
});
test('late catalog result after navigation is ignored and stock unsupported is honest', async () => {
  const f = await controllerFixture();
  let release!: (value: unknown) => void;
  f.client.engineCommand = async () =>
    new Promise<any>((resolve) => {
      release = resolve;
    });
  const pending = f.controller.requestModelTools('view:late', () => true);
  for (let i = 0; i < 10 && !release; i++) await Promise.resolve();
  f.controller.navigationEpoch++;
  release({});
  await pending;
  assert.notEqual(f.controller.snapshot.modelTools?.status, 'ready');
  f.client.engineCommand = async () => {
    throw Error('This backend does not support read_model_tools; nothing was applied.');
  };
  await f.controller.requestModelTools('view:stock', () => true);
  assert.equal(f.controller.snapshot.modelTools.status, 'unsupported');
  assert.deepEqual(f.controller.snapshot.modelTools.active, []);
});

test('model-tools DTO accepts only bounded native fields and reports failure readback honestly', async () => {
  const { readModelTools } = await helper(),
    wire = readModelTools(native().session);
  const scoped = modelToolsSnapshot({ ...wire, persistence: 'runtime-only' }, 'origin', 'view:1');
  assert.equal(scoped.persistence, 'runtime-only');
  const failed = modelToolsSnapshot(
    { ...wire, matched: false, applyFailed: true, persistence: 'after-turn' },
    'origin',
    'view:2',
    false
  );
  assert.equal(failed.status, 'unknown');
  assert.deepEqual(failed.active, ['read']);
  assert.deepEqual(failed.tools, []);
  for (const bad of [
    { ...wire, persistence: ['after-turn'] },
    { ...wire, tools: [{ name: 'read', description: 'Read', exposure: ['direct'] }] },
    {
      ...wire,
      tools: [{ name: 'read', description: 'Read', exposure: 'direct', apiKey: 'invented' }],
    },
  ])
    assert.throws(() => modelToolsSnapshot(bad, 'origin', 'view:bad'), /INVALID_REPLY/);
});

test('RPC tools bridge verifies SDK capability and stale origin before sending a mutation', async () => {
  const requests: any[] = [];
  let valid = true,
    release!: (value: any) => void;
  const caps = {
    protocol: 1,
    sdkVersion: '1.3.0',
    engineCommands: { contract: 1, read_model_tools: true, set_model_tools: true },
  };
  const transport = {
    request: async (command: any) => {
      requests.push(command);
      const data = await new Promise<any>((resolve) => {
        release = resolve;
      });
      return { type: 'response', command: command.type, id: command.id, success: true, data };
    },
    cancelPending() {
      return false;
    },
    on() {
      return this;
    },
  };
  const client = new RpcClient(1, transport as never, {
    shortTimeoutMs: 1000,
    longTimeoutMs: 1000,
  });
  const pending = client.engineCommand(
    'set_model_tools',
    { sessionId: 'owned' },
    { revision: 'r', names: ['read'] },
    () => valid
  );
  valid = false;
  release(caps);
  await assert.rejects(pending, /originating chat changed/i);
  assert.deepEqual(
    requests.map((request) => request.type),
    ['get_capabilities']
  );
  const unsupported = client.engineCommand('read_model_tools', { sessionId: 'owned' });
  release({ protocol: 1, sdkVersion: '1.3.0', engineCommands: { contract: 1 } });
  await assert.rejects(unsupported, /does not support read_model_tools/);
  assert.deepEqual(
    requests.map((request) => request.type),
    ['get_capabilities', 'get_capabilities']
  );
});

test('real tab snapshot is lazy and switched chat cannot receive a pending tools Apply', async () => {
  const first = await controllerFixture(),
    second = await controllerFixture();
  second.controller.state.state = {
    sessionId: 'other',
    sessionFile: '/other/session.jsonl',
    isIdle: true,
  };
  const manager = Object.create(first.ChatTabManager.prototype),
    resource = { toString: () => 'pi-chat:/owned.chat' },
    host = { resource };
  const target = {
    kind: 'sessionFile',
    workspaceFolderUri: 'file:///owned',
    sessionFile: '/owned/session.jsonl',
  };
  let context = { controller: first.controller, resource, target };
  Object.assign(manager, {
    hosts: new Map([[resource.toString(), host]]),
    resourceSequence: new Map(),
    revealedMessageCounts: new Map(),
    extensionUiDraftAcks: new Map(),
    keyFor: () => resource.toString(),
    contextForResource: () => context,
    sessions: { ownerOf: () => resource },
    uiState: { getComposerStateForIdentity: async () => createEmptyComposerState() },
  });
  const initial = await manager.buildSnapshot(context, false);
  assert.equal(initial.modelTools, undefined);
  assert.deepEqual(first.calls, []);
  const originKey = JSON.stringify(['/owned/session.jsonl', 'owned']);
  await manager.onMessage(host, { type: 'modelToolsRequest', originKey, requestId: 'tab:read' });
  assert.equal(first.controller.snapshot.modelTools.requestId, 'tab:read');
  let entered!: () => void, release!: (value: any) => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  first.client.getState = async () => {
    entered();
    return new Promise<any>((resolve) => {
      release = resolve;
    });
  };
  const applying = manager.onMessage(host, {
    type: 'modelToolsApply',
    originKey,
    requestId: 'tab:apply',
    revision: first.controller.snapshot.modelTools.revision,
    names: ['write'],
  });
  await waiting;
  context = {
    controller: second.controller,
    resource,
    target: { ...target, sessionFile: '/other/session.jsonl' },
  };
  release({ ...first.controller.state.state });
  await applying;
  assert.deepEqual(first.calls, ['read_model_tools']);
  assert.deepEqual(second.calls, []);
  assert.equal(first.f.calls.length, 0);
  assert.equal(second.f.calls.length, 0);
  await manager.onMessage(host, { type: 'modelToolsRequest', originKey, requestId: 'stale:view' });
  assert.deepEqual(second.calls, []);
});

test('Submit waits for an earlier explicit tool Apply through existing model-operation sequencing', async () => {
  const f = await controllerFixture();
  await f.controller.requestModelTools('tools:read', () => true);
  const revision = f.controller.snapshot.modelTools.revision,
    engine = f.client.engineCommand;
  let entered!: () => void, release!: () => void;
  const applying = new Promise<void>((resolve) => {
      entered = resolve;
    }),
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
  const observations: string[][] = [];
  f.client.engineCommand = async (...args) => {
    if (args[0] === 'set_model_tools') {
      entered();
      await gate;
    }
    return engine(...args);
  };
  Object.assign(f.client, {
    prompt: async () => {
      observations.push([...f.f.session.getActiveToolNames()]);
      return { disposition: 'handled' };
    },
  });
  const change = f.controller.applyModelTools('tools:apply', revision, ['write'], () => true);
  await applying;
  const submit = f.controller.prompt('Use the selected tools');
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(observations, [], 'prompt cannot overtake pending Apply');
  release();
  await change;
  await submit;
  assert.deepEqual(observations, [['write']]);
  assert.deepEqual(f.f.calls, [['write']]);
});
