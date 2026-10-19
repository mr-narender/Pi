import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { RpcClient } from '../../src/rpc/client';

const load = () => import(pathToFileURL(resolve('host/model-discovery.mjs')).href);

test('OpenRouter discovery is lazy, provider-specific, coalesced and preserves cached reads', async () => {
  const { discoverOpenRouterModels } = await load();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const runtime = {
    getProvider: (id: string) => (id === 'openrouter' ? {} : undefined),
    hasConfiguredAuth: () => true,
    refresh: async (options: any) => {
      calls++;
      assert.deepEqual(options.providers, ['openrouter']);
      assert.equal(options.allowNetwork, true);
      assert.equal(options.force, undefined);
      assert.ok(options.signal instanceof AbortSignal);
      await pending;
      return { aborted: false, errors: new Map() };
    },
  };
  assert.equal(calls, 0);
  const first = discoverOpenRouterModels(runtime, false);
  const second = discoverOpenRouterModels(runtime, false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  release();
  assert.deepEqual(await Promise.all([first, second]), [undefined, undefined]);
  await discoverOpenRouterModels(runtime, false);
  assert.equal(calls, 2, 'later opening permits native credential/cache refresh');
});

test('RPC discovery is capability gated and ordinary model reads never request network discovery', async () => {
  const client = Object.create(RpcClient.prototype) as RpcClient;
  const calls: Array<[string, unknown]> = [];
  let caps: any = { protocol: 1, sdkVersion: '1.2.0', modelDiscovery: true };
  (client as any).command = async (type: string, payload: unknown) => {
    calls.push([type, payload]);
    return type === 'get_capabilities' ? caps : { models: [] };
  };
  await client.getAvailableModels();
  assert.deepEqual(calls.splice(0), [['get_available_models', {}]]);
  for (const version of ['1.2.0', '1.3.0']) {
    caps = { protocol: 1, sdkVersion: version, modelDiscovery: true };
    await client.getAvailableModels(true);
    assert.deepEqual(calls.splice(0), [
      ['get_capabilities', {}],
      ['get_available_models', { refreshOpenRouter: true }],
    ]);
  }
  for (const version of ['1.1.0', '1.2.1', '1.3.1', '1.4.0', undefined]) {
    caps = { protocol: 1, sdkVersion: version, modelDiscovery: true };
    await client.getAvailableModels(true);
    assert.deepEqual(calls.splice(0), [
      ['get_capabilities', {}],
      ['get_available_models', {}],
    ]);
  }
});

test('offline and unauthenticated discovery make no refresh or credential calls', async () => {
  const { discoverOpenRouterModels } = await load();
  const runtime = {
    getProvider: () => ({}),
    hasConfiguredAuth: () => false,
    refresh: () => {
      throw new Error('must remain offline');
    },
  };
  assert.equal(await discoverOpenRouterModels(runtime, true), undefined);
  assert.equal(await discoverOpenRouterModels(runtime, false), undefined);
});

test('discovery bounds slow requests and redacts provider failures without disabling cached reads', async () => {
  const { discoverOpenRouterModels } = await load();
  const runtime = {
    getProvider: () => ({}),
    hasConfiguredAuth: () => true,
    refresh: async ({ signal }: { signal: AbortSignal }) => {
      await new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(new Error('SECRET')), { once: true })
      );
    },
  };
  // Keep the process alive: AbortSignal.timeout deliberately does not do so.
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    assert.equal(await discoverOpenRouterModels(runtime, false, 10), 'MODEL_DISCOVERY_UNAVAILABLE');
  } finally {
    clearTimeout(keepAlive);
  }
  runtime.refresh = async () => {
    throw new Error('SECRET');
  };
  assert.equal(await discoverOpenRouterModels(runtime, false), 'MODEL_DISCOVERY_UNAVAILABLE');
  runtime.refresh = async () =>
    ({ aborted: false, errors: new Map([['openrouter', new Error('SECRET')]]) }) as any;
  assert.equal(await discoverOpenRouterModels(runtime, false), 'MODEL_DISCOVERY_UNAVAILABLE');
});
