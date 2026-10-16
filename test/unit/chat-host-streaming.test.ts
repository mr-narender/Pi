import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { build } from 'esbuild';

async function managerFixture() {
  const compiled = await build({
    stdin: {
      contents:
        "export {ChatTabManager} from './src/editorTabs/tabManager'; export {ChatTabStateCache} from './src/editorTabs/sessionCache';",
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    external: ['vscode'],
  });
  const require = createRequire(`${process.cwd()}/package.json`);
  const module = { exports: {} as Record<string, any> };
  new Function('require', 'module', 'exports', compiled.outputFiles[0]!.text)(
    (id: string) =>
      id === 'vscode'
        ? {
            workspace: {
              getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }),
            },
          }
        : require(id),
    module,
    module.exports
  );
  const manager = Object.create(module.exports.ChatTabManager.prototype);
  const resource = { toString: () => 'pi-chat:/remote.chat' };
  const controller = { text: '' };
  const deliveries: Array<{ text: string; active: boolean }> = [];
  manager.pendingRender = new Map();
  manager.lastRenderAt = new Map();
  manager.lastActivityAt = new Map();
  manager.detectTurnCompletion = () => {};
  manager.identityForController = () => undefined;
  manager.uiState = { restoreControllerDraft: async () => {} };
  manager.sessions = { ownerOf: () => resource };
  manager.renderResourceNow = async (_resource: unknown, options?: { active?: boolean }) => {
    deliveries.push({ text: controller.text, active: options?.active ?? false });
  };
  manager.logger = { warn() {} };
  manager.follow = { dispose() {} };
  manager.controllerSubscriptions = [];
  manager.hosts = new Map();
  manager.unseenCompletions = new Set();
  manager.cache = { dispose() {} };
  manager.openChatsEmitter = { dispose() {} };
  return { manager, resource, controller, deliveries, Cache: module.exports.ChatTabStateCache };
}

test('manager disposal returns one promise that waits for the deferred cache flush', async () => {
  const { manager, Cache } = await managerFixture();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const persisted: unknown[] = [];
  manager.cache = new Cache({
    workspaceState: {
      get: (_key: string, fallback: unknown) => fallback,
      update: async (_key: string, value: unknown) => {
        await held;
        persisted.push(value);
      },
    },
  });
  await manager.cache.set({ resource: 'chat', lastKnownTitle: 'Latest frame' }, { defer: true });
  let followDisposals = 0;
  manager.follow.dispose = () => {
    followDisposals++;
  };
  const first = manager.dispose();
  const second = manager.dispose();
  let settled = false;
  void Promise.resolve(first).then(() => {
    settled = true;
  });
  try {
    for (let i = 0; i < 5; i++) await Promise.resolve();
    assert.equal(settled, false, 'normal shutdown must await the pending storage update');
    assert.equal(first, second, 'subscription disposal and deactivate share one operation');
    assert.equal(followDisposals, 1);
  } finally {
    release();
    await Promise.all([first, second]);
  }
  assert.equal(persisted.length, 2);
  assert.equal((persisted[0] as any).chat.lastKnownTitle, 'Latest frame');
  assert.equal(manager.cache.get('chat'), undefined);
});

test('ready draft renders defer persistence while a genuine working-to-settled transition flushes', async (t) => {
  const { manager, resource, controller, Cache } = await managerFixture();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  delete manager.renderResourceNow;
  const writes: unknown[] = [];
  manager.cache = new Cache({
    workspaceState: {
      get: (_key: string, fallback: unknown) => fallback,
      update: async (_key: string, value: unknown) => {
        writes.push(value);
      },
    },
  });
  let snapshot = {
    sequence: 0,
    title: 'Owned chat',
    connectionState: 'ready',
    bindingState: 'current',
    isStreaming: false,
    messages: [],
    pendingImages: [],
    draft: '',
  };
  manager.contextForResource = () => ({ controller, resource, target: {} });
  manager.remoteSharing = { sharingInfoFor: () => undefined };
  manager.buildSnapshot = async () => snapshot;
  try {
    for (let i = 0; i < 30; i++) {
      snapshot = { ...snapshot, sequence: i, draft: `typing ${i}` };
      await manager.renderResourceNow(resource);
    }
    assert.equal(
      writes.length,
      0,
      'ready composer snapshots must not serialize every cached transcript'
    );
    assert.equal(manager.cache.get(resource).lastSnapshot.sequence, 29);
    snapshot = { ...snapshot, connectionState: 'busy', isStreaming: true };
    await manager.renderResourceNow(resource);
    assert.equal(writes.length, 0);
    snapshot = { ...snapshot, connectionState: 'ready', isStreaming: false };
    await manager.renderResourceNow(resource);
    assert.equal(writes.length, 2, 'working-to-settled transition flushes immediately');
    snapshot = { ...snapshot, sequence: 31, draft: 'new draft' };
    await manager.renderResourceNow(resource);
    assert.equal(writes.length, 2, 'later ready frames return to bounded persistence');
    t.mock.timers.tick(500);
    for (let i = 0; i < 12; i++) await Promise.resolve();
    assert.equal(writes.length, 4);
  } finally {
    await manager.dispose();
  }
});

test('continuous remote controller deltas deliver intermediate snapshots before the turn ends', async (t) => {
  const { manager, controller, deliveries } = await managerFixture();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const pending: Promise<void>[] = [];
  for (let i = 0; i < 30; i++) {
    controller.text += 'delta ';
    pending.push(manager.onControllerChanged(controller));
    await Promise.resolve();
    t.mock.timers.tick(10);
    await Promise.resolve();
    if (i === 15) {
      assert.ok(deliveries.length >= 3, 'continuous input must not postpone every trailing frame');
      assert.ok(deliveries.at(-1)!.text.length > 'delta '.length);
      assert.ok(deliveries.at(-1)!.text.length < 30 * 'delta '.length);
    }
  }
  t.mock.timers.tick(50);
  await Promise.all(pending);
  assert.equal(deliveries.at(-1)!.text, controller.text);
  assert.equal(manager.pendingRender.size, 0);
});

test('coalesced snapshots retain active requests and settle every caller', async (t) => {
  const { manager, resource, controller, deliveries } = await managerFixture();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  await manager.renderResource(resource);
  const first = manager.renderResource(resource, { active: true });
  const second = manager.renderResource(resource);
  controller.text = 'newest';
  t.mock.timers.tick(50);
  await Promise.all([first, second]);
  assert.deepEqual(deliveries.at(-1), { text: 'newest', active: true });
});

test('disposing the manager cancels queued frames and settles their callers', async (t) => {
  const { manager, resource, deliveries } = await managerFixture();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  await manager.renderResource(resource);
  let settled = false;
  const pending = manager.renderResource(resource).then(() => {
    settled = true;
  });
  manager.dispose();
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.equal(settled, true);
  t.mock.timers.tick(100);
  await pending;
  assert.equal(deliveries.length, 1);
  assert.equal(manager.pendingRender.size, 0);
});

test('a failed trailing render settles callers and allows the next frame', async (t) => {
  const { manager, resource, deliveries } = await managerFixture();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  await manager.renderResource(resource);
  const render = manager.renderResourceNow;
  let warnings = 0;
  manager.logger.warn = () => warnings++;
  manager.renderResourceNow = async () => {
    throw new Error('failed');
  };
  const pending = manager.renderResource(resource);
  t.mock.timers.tick(50);
  await pending;
  assert.equal(warnings, 1);
  assert.equal(manager.pendingRender.size, 0);
  manager.renderResourceNow = render;
  const retry = manager.renderResource(resource);
  t.mock.timers.tick(50);
  await retry;
  assert.equal(deliveries.length, 2);
});
