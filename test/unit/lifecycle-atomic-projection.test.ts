import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { createInitialControllerState } from '../../src/state/types';
import { RpcClient } from '../../src/rpc/client';

const compiled = build({
  entryPoints: ['src/sessions/sessionController.ts'],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
  external: ['vscode'],
});
async function fixture() {
  const module = { exports: {} as any };
  const require = createRequire(`${process.cwd()}/package.json`);
  new Function('require', 'module', 'exports', (await compiled).outputFiles[0]!.text)(
    (id: string) => (id === 'vscode' ? {} : require(id)),
    module,
    module.exports
  );
  const c = Object.create(module.exports.SessionController.prototype);
  const origin = { sessionId: 'old', sessionFile: '/owned/old.jsonl', leafId: 'old-leaf' };
  const identity = { sessionId: 'new', sessionFile: '/owned/new.jsonl', leafId: 'new-leaf' };
  const projection: any = {
    contract: 1,
    origin,
    identity,
    state: { sessionId: identity.sessionId, sessionFile: identity.sessionFile },
    entries: [{ id: 'new-leaf' }],
    messages: Array.from({ length: 121 }, (_, n) => ({ role: 'user', content: String(n) })),
  };
  let switched = false;
  const client = {
    getState: async () => (switched ? projection.state : origin),
    // The old staged path reproduces the proven race. It must never be used.
    getEntries: async () => ({ entries: projection.entries, leafId: identity.leafId }),
    getMessages: async () => {
      identity.leafId = 'unconfirmed';
      return { messages: [{ role: 'user', content: 'unconfirmed branch' }] };
    },
    replaceChat: async () => {
      switched = true;
      return {
        cancelled: false,
        replacementIdentity: { ...identity },
        replacementProjection: projection,
      };
    },
  };
  c.supervisor = { currentClient: client, currentGeneration: 1 };
  c.folder = { uri: { fsPath: '/owned' } };
  c.settings = { maxTranscriptItems: 60 };
  c.state = {
    ...createInitialControllerState('owned', '/owned'),
    connectionState: 'ready',
    state: { sessionId: origin.sessionId, sessionFile: origin.sessionFile },
    leafId: origin.leafId,
    messages: [{ role: 'user', content: 'outgoing history' }],
    draft: 'outgoing draft',
  };
  const published: any[] = [];
  c.fire = () => published.push(structuredClone(c.state));
  c.syncFileReadOffset = async () => {};
  c.armSessionFileWatcher = () => {};
  return { c, client, projection, identity, published };
}
function preserved(c: any, published: any[]) {
  assert.equal(c.snapshot.connectionState, 'faulted');
  assert.equal(c.snapshot.state.sessionId, 'old');
  assert.deepEqual(c.snapshot.messages, [{ role: 'user', content: 'outgoing history' }]);
  assert.equal(c.snapshot.draft, 'outgoing draft');
  assert.ok(published.every((s) => s.state.sessionId === 'old'));
}
test('atomic completion never reads an unconfirmed staged branch and preserves window', async () => {
  const { c, identity } = await fixture();
  const intent = c.captureLifecycleIntent();
  const result = await intent.run('new', undefined, intent.valid);
  assert.equal(result.valid(), true);
  assert.equal(c.snapshot.leafId, 'new-leaf');
  assert.equal(identity.leafId, 'new-leaf');
  assert.equal(c.snapshot.messages.length, 60);
  assert.equal(c.snapshot.messages[0].content, '61');
  assert.equal(c.snapshot.draft, 'outgoing draft');
});
for (const field of ['sessionId', 'sessionFile', 'leafId'])
  test(`atomic completion rejects changed ${field}`, async () => {
    const { c, projection, published } = await fixture();
    projection.identity = { ...projection.identity, [field]: 'changed' };
    const i = c.captureLifecycleIntent();
    await assert.rejects(i.run('new', undefined, i.valid), /replacement/);
    preserved(c, published);
  });
for (const field of ['origin', 'state', 'entries', 'messages', 'contract', 'identity'])
  test(`atomic completion fails closed with missing ${field}`, async () => {
    const { c, projection, published } = await fixture();
    delete projection[field];
    const i = c.captureLifecycleIntent();
    await assert.rejects(i.run('new', undefined, i.valid), /replacement/);
    preserved(c, published);
  });
for (const invalidation of ['client', 'generation', 'origin', 'surface', 'outgoing-leaf'])
  test(`atomic response rejects invalidated ${invalidation}`, async () => {
    const { c, client, published } = await fixture();
    const replace = client.replaceChat;
    let surface = true;
    client.replaceChat = async () => {
      const result = await replace();
      if (invalidation === 'client') c.supervisor.currentClient = {};
      if (invalidation === 'generation') c.supervisor.currentGeneration++;
      if (invalidation === 'origin') c.state.state.sessionId = 'external';
      if (invalidation === 'surface') surface = false;
      if (invalidation === 'outgoing-leaf') c.state.leafId = 'external';
      return result;
    };
    const i = c.captureLifecycleIntent();
    await assert.rejects(
      i.run('new', undefined, () => surface),
      /changed/
    );
    if (invalidation === 'origin') c.state.state.sessionId = 'old';
    preserved(
      c,
      published.filter((s) => s.state.sessionId === 'old')
    );
  });
test('empty entries and explicit null leaf are valid, not optional identity', async () => {
  const { c, identity, projection } = await fixture();
  identity.leafId = null as any;
  projection.entries = [];
  projection.messages = [];
  const i = c.captureLifecycleIntent();
  await i.run('new', undefined, i.valid);
  assert.equal(c.snapshot.leafId, null);
  assert.deepEqual(c.snapshot.messages, []);
});

for (const defect of ['null-sessionFile', 'empty-sessionFile', 'empty-leaf'])
  test(`atomic admission rejects malformed ${defect}`, async () => {
    const { c, identity, projection, published } = await fixture();
    if (defect === 'empty-leaf') identity.leafId = '';
    else {
      identity.sessionFile = (defect === 'null-sessionFile' ? null : '') as any;
      projection.state.sessionFile = identity.sessionFile;
    }
    const i = c.captureLifecycleIntent();
    await assert.rejects(i.run('new', undefined, i.valid), /replacement/);
    preserved(c, published);
  });

test('undefined sessionFile and null leaf remain valid public identities', async () => {
  const { c, identity, projection } = await fixture();
  delete (identity as any).sessionFile;
  delete projection.state.sessionFile;
  identity.leafId = null as any;
  projection.entries = [];
  projection.messages = [];
  const i = c.captureLifecycleIntent();
  await i.run('new', undefined, i.valid);
  assert.equal(c.snapshot.state.sessionFile, undefined);
  assert.equal(c.snapshot.leafId, null);
  assert.equal(c.snapshot.connectionState, 'ready');
});

async function rpcFixture(capabilities: any, mutate?: () => void) {
  const f = await fixture();
  const calls: string[] = [];
  const rpc = new RpcClient(
    1,
    {
      request: async (request: any) => {
        calls.push(request.type);
        if (request.type === 'get_capabilities') {
          mutate?.();
          return { success: true, data: capabilities };
        }
        if (request.type === 'prompt') return { success: true };
        // A remote property must never override local dispatch truth.
        throw Object.assign(new Error('uncertain native failure'), { attempted: false });
      },
      cancelPending: () => {},
    } as any,
    { shortTimeoutMs: 1000, longTimeoutMs: 1000 }
  );
  f.client.replaceChat = rpc.replaceChat.bind(rpc) as any;
  return { ...f, rpc, calls };
}

test('real RpcClient unsupported refusal retains usable unchanged chat', async () => {
  const { c, rpc, calls, published } = await rpcFixture({ protocol: 1 });
  const i = c.captureLifecycleIntent();
  await assert.rejects(i.run('new', undefined, i.valid), (error: any) => {
    assert.doesNotMatch(error.message, /may already have switched/);
    return /no coherent/.test(error.message);
  });
  assert.deepEqual(calls, ['get_capabilities']);
  assert.equal(c.snapshot.connectionState, 'ready');
  assert.equal(c.snapshot.state.sessionId, 'old');
  assert.equal(c.snapshot.draft, 'outgoing draft');
  assert.equal(published.length, 0);
  c.supervisor.currentClient.prompt = rpc.prompt.bind(rpc);
  c.schedulePersist = () => {};
  await c.prompt('later normal chat');
  assert.deepEqual(calls, ['get_capabilities', 'prompt']);
});

for (const invalidation of ['client', 'generation', 'origin', 'surface', 'leaf'])
  test(`capability await rechecks ${invalidation} before dispatch`, async () => {
    let c: any;
    let surface = true;
    const f = await rpcFixture({ protocol: 1, lifecycleProjection: 1 }, () => {
      if (invalidation === 'client') c.supervisor.currentClient = {};
      if (invalidation === 'generation') c.supervisor.currentGeneration++;
      if (invalidation === 'origin') c.state.state.sessionId = 'external';
      if (invalidation === 'surface') surface = false;
      if (invalidation === 'leaf') c.state.leafId = 'external';
    });
    c = f.c;
    const i = c.captureLifecycleIntent();
    await assert.rejects(
      i.run('new', undefined, () => surface),
      /changed/
    );
    assert.deepEqual(f.calls, ['get_capabilities']);
    assert.equal(c.snapshot.connectionState, 'ready');
  });

test('real post-dispatch uncertain failure faults and never publishes replacement or sends', async () => {
  const { c, rpc, calls, published } = await rpcFixture({ protocol: 1, lifecycleProjection: 1 });
  const i = c.captureLifecycleIntent();
  await assert.rejects(i.run('new', undefined, i.valid), /may already have switched/);
  assert.deepEqual(calls, ['get_capabilities', 'new_session']);
  preserved(c, published);
  c.supervisor.currentClient.prompt = rpc.prompt.bind(rpc);
  await assert.rejects(c.prompt('must not send'), /unconfirmed/);
  assert.deepEqual(calls, ['get_capabilities', 'new_session']);
});
