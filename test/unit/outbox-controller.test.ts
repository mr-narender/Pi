import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { createInitialControllerState } from '../../src/state/types';
import { RpcClient } from '../../src/rpc/client';
import { parseEnvelope } from '../../src/rpc/protocol';

async function controller() {
  const code = await build({
    entryPoints: ['src/sessions/sessionController.ts'],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    external: ['vscode'],
  });
  const nativeRequire = createRequire(`${process.cwd()}/package.json`),
    module = { exports: {} as any };
  new Function('require', 'module', 'exports', code.outputFiles[0]!.text)(
    (name: string) => (name === 'vscode' ? {} : nativeRequire(name)),
    module,
    module.exports
  );
  const owner = Object.create(module.exports.SessionController.prototype);
  owner.state = createInitialControllerState('project', '/project');
  owner.state.connectionState = 'ready';
  owner.state.state = { sessionId: 'session', sessionFile: '/session.jsonl' };
  owner.supervisor = { currentGeneration: 1, currentClient: {} };
  owner.fire = () => {};
  return owner;
}
test('SDK prompt callers serialize preflight acknowledgement and retain native disposition', async () => {
  const owner = await controller();
  let release!: () => void,
    calls = 0;
  owner.state.state.sdkVersion = '1.3.0';
  owner.supervisor.sdkRoot = '/selected/sdk';
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  owner.supervisor.currentClient.prompt = async () => {
    calls++;
    if (calls === 1) await gate;
    return { disposition: 'handled' };
  };
  const first = owner.prompt('one'),
    second = owner.prompt('two');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1, 'second prompt must wait for native acceptance');
  release();
  assert.deepEqual(await first, { disposition: 'handled' });
  await second;
  assert.equal(calls, 2);
});
test('stock long-running prompt does not delay immediate steering', async () => {
  const owner = await controller();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const modes: unknown[] = [];
  owner.supervisor.currentClient.prompt = async (
    _text: string,
    _images: unknown,
    mode: unknown
  ) => {
    modes.push(mode);
    if (modes.length === 1) await gate;
    return { disposition: 'queued' };
  };
  const first = owner.prompt('ordinary');
  const steer = owner.prompt('urgent', 'steer');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(modes, [undefined, 'steer']);
  await steer;
  release();
  await first;
});
test('managed outbox checks authoritative idle/capability and session origin', async () => {
  const owner = await controller();
  assert.equal(typeof owner.isOutboxReady, 'function', 'outbox needs authoritative idle admission');
  owner.supervisor.currentClient.getCapabilities = async () => ({
    engineCommands: { outbox_prompt: true },
  });
  let native: any = {
    sessionId: 'session',
    sessionFile: '/session.jsonl',
    isIdle: true,
    pendingMessageCount: 0,
  };
  owner.supervisor.currentClient.getState = async () => native;
  assert.equal(await owner.isOutboxReady(true), true);
  native = { ...native, isCompacting: true };
  assert.equal(await owner.isOutboxReady(true), false);
  native = { ...native, isCompacting: false, isIdle: false };
  assert.equal(await owner.isOutboxReady(true), false);
  native = { ...native, isIdle: true, sessionId: 'other' };
  await assert.rejects(owner.isOutboxReady(true), /changed/);
});

test('outbox origin tolerates normal turn leaf/run churn but rejects navigation and replacement', async () => {
  const owner = await controller();
  const valid = owner.captureOutboxOrigin();
  owner.runRevision = 90;
  owner.state.state.leafId = 'next';
  assert.equal(valid(), true);
  owner.navigationEpoch = 1;
  assert.equal(valid(), false);
  const next = owner.captureOutboxOrigin();
  owner.supervisor.currentClient = {};
  assert.equal(next(), false);
});
test('outbox capability wait cannot admit work into a newly selected chat', async () => {
  const owner = await controller();
  let release!: (value: unknown) => void,
    reads = 0;
  owner.supervisor.currentClient.getCapabilities = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  owner.supervisor.currentClient.getState = async () => {
    reads++;
    return {};
  };
  const ready = owner.isOutboxReady(true);
  owner.navigationEpoch = 1;
  release({ engineCommands: { outbox_prompt: true } });
  await assert.rejects(ready, /changed/);
  assert.equal(reads, 0);
});

test('unsupported managed capability has an actionable predispatch reason without affecting direct stock chat', async () => {
  const owner = await controller();
  owner.supervisor.currentClient.getCapabilities = async () => ({});
  await assert.rejects(
    owner.isOutboxReady(true),
    (error: any) =>
      error.outboxNotDispatched === true && /cannot safely release Outbox/.test(error.message)
  );
  owner.supervisor.currentClient.getCapabilities = async () => {
    throw new Error('Unknown command');
  };
  await assert.rejects(
    owner.isOutboxReady(true),
    (error: any) =>
      error.outboxNotDispatched === true && /could not confirm safe delivery/.test(error.message)
  );
  owner.supervisor.currentClient.prompt = async () => ({ disposition: 'started' });
  assert.deepEqual(await owner.prompt('Normal stock chat'), { disposition: 'started' });
});
test('managed prompt marks only known predispatch refusal, preserving uncertain transport failures', async () => {
  const owner = await controller();
  owner.supervisor.currentClient.getCapabilities = async () => ({
    engineCommands: { outbox_prompt: true },
  });
  owner.supervisor.currentClient.getState = async () => ({
    sessionId: 'session',
    sessionFile: '/session.jsonl',
    isIdle: true,
  });
  const options = {
    outbox: { sessionId: 'session', sessionFile: '/session.jsonl', requireIdle: true },
  };
  owner.supervisor.currentClient.prompt = async (
    _text: unknown,
    _images: unknown,
    _mode: unknown,
    _options: unknown,
    dispatch: { attempted: boolean }
  ) => {
    dispatch.attempted = true;
    throw new Error('connection interrupted');
  };
  await assert.rejects(
    owner.prompt('message', 'prompt', [], options),
    (error: any) => error.message === 'connection interrupted' && !error.outboxNotDispatched
  );
  await assert.rejects(
    owner.prompt('message', 'prompt', [], { outbox: { ...options.outbox, sessionId: 'other' } }),
    (error: any) => error.outboxNotDispatched === true
  );
});
test('queued SDK prompt is not dispatched after session origin changes during prior preflight', async () => {
  const owner = await controller();
  owner.state.state.sdkVersion = '1.3.0';
  owner.supervisor.sdkRoot = '/selected/sdk';
  let release!: () => void,
    calls = 0;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  owner.supervisor.currentClient.prompt = async () => {
    calls++;
    await gate;
    return { disposition: 'started' };
  };
  const first = owner.prompt('first');
  const second = owner.prompt('second');
  const rejected = assert.rejects(second, /changed/);
  await new Promise((resolve) => setImmediate(resolve));
  owner.state.state.sessionId = 'other';
  release();
  await first;
  await rejected;
  assert.equal(calls, 1);
});
test('RPC managed admission distinguishes host refusal from transport uncertainty', async () => {
  let response: any = {
    type: 'response',
    command: 'prompt',
    success: false,
    error: 'OUTBOX_BUSY',
    outboxNotDispatched: true,
  };
  const client = new RpcClient(1, { request: async () => response } as any, {
    shortTimeoutMs: 100,
    longTimeoutMs: 100,
  });
  const options = { outbox: { sessionId: 'session', requireIdle: true } };
  await assert.rejects(
    client.prompt('text', [], undefined, options),
    (error: any) => error.outboxNotDispatched === true
  );
  response = { ...response, outboxNotDispatched: undefined };
  await assert.rejects(
    client.prompt('text', [], undefined, options),
    (error: any) => !error.outboxNotDispatched
  );
});

test('RPC parser preserves only literal true native predispatch evidence', () => {
  const failure = {
    type: 'response',
    id: '1',
    command: 'prompt',
    success: false,
    error: 'OUTBOX_BUSY',
  };
  for (const marker of [true, false, 'true', 1, undefined]) {
    const parsed = parseEnvelope({ ...failure, outboxNotDispatched: marker });
    assert.equal(
      'outboxNotDispatched' in parsed ? parsed.outboxNotDispatched : undefined,
      marker === true ? true : undefined
    );
  }
  const success = parseEnvelope({ ...failure, success: true, outboxNotDispatched: true });
  assert.equal('outboxNotDispatched' in success, false);
});
