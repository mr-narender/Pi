import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { build } from 'esbuild';

async function fixture(update?: (key: string, value: unknown) => Promise<void>) {
  const built = await build({
    entryPoints: ['src/editorTabs/sessionCache.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    external: ['vscode'],
  });
  const require = createRequire(`${process.cwd()}/package.json`);
  const module = { exports: {} as any };
  new Function('require', 'module', 'exports', built.outputFiles[0]!.text)(
    (id: string) => (id === 'vscode' ? {} : require(id)),
    module,
    module.exports
  );
  const writes: Array<{ key: string; value: any }> = [];
  const cache = new module.exports.ChatTabStateCache({
    workspaceState: {
      get: (_key: string, fallback: unknown) => fallback,
      update: async (key: string, value: unknown) => {
        writes.push({ key, value: structuredClone(value) });
        await update?.(key, value);
      },
    },
  });
  const state = (index: number) => ({
    target: { kind: 'workspaceDraft', workspaceFolderUri: 'file:///owned' },
    resource: 'chat',
    lastKnownTitle: `Frame ${index}`,
    lastViewedAt: index,
    isLiveBound: true,
  });
  return { cache, writes, state };
}
const drain = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

test('continuous streaming updates stay immediate in memory and persist at a fixed bounded rate', async (t) => {
  const { cache, writes, state } = await fixture();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (let i = 0; i < 40; i++) {
    await cache.set(state(i), { defer: true });
    assert.equal(cache.get('chat').lastKnownTitle, `Frame ${i}`);
    t.mock.timers.tick(10);
  }
  assert.equal(writes.length, 0, 'stream frames must not each serialize every cached tab');
  t.mock.timers.tick(100);
  await drain();
  assert.equal(writes.length, 2);
  assert.equal(writes[0]!.value.chat.lastKnownTitle, 'Frame 39');
  for (let i = 40; i < 100; i++) {
    await cache.set(state(i), { defer: true });
    t.mock.timers.tick(10);
    await drain();
  }
  assert.equal(writes.length, 4, 'continuous events cannot starve the fixed persistence deadline');
  await cache.set(state(100));
  assert.equal(
    writes.at(-2)!.value.chat.lastKnownTitle,
    'Frame 100',
    'settled frames flush immediately'
  );
  await cache.dispose();
});

test('open, close, delete and disposal flush pending cache changes without delayed resurrection', async (t) => {
  const { cache, writes, state } = await fixture();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await cache.set(state(1), { defer: true });
  await cache.markOpen('chat');
  assert.equal(writes[0]!.value.chat.lastKnownTitle, 'Frame 1');
  assert.deepEqual(writes[1]!.value, ['chat']);
  await cache.set(state(2), { defer: true });
  await cache.markClosed('chat');
  assert.equal(writes.at(-2)!.value.chat.lastKnownTitle, 'Frame 2');
  assert.deepEqual(writes.at(-1)!.value, []);
  await cache.set(state(3), { defer: true });
  await cache.delete('chat');
  assert.deepEqual(writes.at(-2)!.value, {});
  await cache.set(state(4), { defer: true });
  await cache.dispose();
  assert.equal(writes.at(-2)!.value.chat.lastKnownTitle, 'Frame 4');
  const count = writes.length;
  t.mock.timers.tick(2000);
  await drain();
  assert.equal(writes.length, count);
});

test('slow storage coalesces newer frames and lifecycle flush waits for the latest write', async (t) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { cache, writes, state } = await fixture(async () => held);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await cache.set(state(0), { defer: true });
  t.mock.timers.tick(500);
  for (let i = 1; i <= 20; i++) {
    await cache.set(state(i), { defer: true });
    t.mock.timers.tick(100);
  }
  assert.equal(writes.length, 2, 'only one storage batch can be in flight');
  const closing = cache.markClosed('chat');
  release();
  await closing;
  assert.equal(writes.length, 4, 'all pending frames collapse into the latest storage batch');
  assert.equal(writes.at(-2)!.value.chat.lastKnownTitle, 'Frame 20');
  await cache.dispose();
});

test('failed scheduled storage remains dirty for an explicit retry without unhandled rejection', async (t) => {
  let fail = true;
  const { cache, writes, state } = await fixture(async () => {
    if (fail) throw new Error('store offline');
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await cache.set(state(1), { defer: true });
  t.mock.timers.tick(500);
  await drain();
  const failedWrites = writes.length;
  t.mock.timers.tick(5000);
  await drain();
  assert.equal(writes.length, failedWrites, 'an idle storage outage must not cause a retry loop');
  fail = false;
  await cache.markOpen('chat');
  assert.equal(writes.at(-2)!.value.chat.lastKnownTitle, 'Frame 1');
  assert.deepEqual(writes.at(-1)!.value, ['chat']);
  await cache.dispose();
});

test('a partial storage failure waits for both keys before retrying and disposed caches ignore late frames', async (t) => {
  let release!: () => void;
  let fail = true;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { cache, writes, state } = await fixture(async (key) => {
    if (fail && key.includes('tabState')) throw new Error('partial failure');
    if (fail) await held;
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await cache.set(state(0), { defer: true });
  t.mock.timers.tick(500);
  await drain();
  await cache.set(state(1), { defer: true });
  t.mock.timers.tick(1000);
  await drain();
  assert.equal(writes.length, 2, 'an earlier key failure cannot overlap the still-pending key');
  fail = false;
  release();
  await drain();
  await cache.markClosed('chat');
  assert.equal(writes.at(-2)!.value.chat.lastKnownTitle, 'Frame 1');
  await cache.dispose();
  const count = writes.length;
  await cache.set(state(2), { defer: true });
  await cache.markOpen('chat');
  t.mock.timers.tick(2000);
  assert.equal(writes.length, count);
  assert.equal(cache.get('chat'), undefined);
});
