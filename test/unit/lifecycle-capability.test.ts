import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { RpcClient } from '../../src/rpc/client';
import { createInitialControllerState } from '../../src/state/types';

for (const caps of [undefined, { protocol: 1 }, { protocol: 1, lifecycleProjection: 0 }])
  test(`older/stock lifecycle capability ${JSON.stringify(caps)} never dispatches replacement`, async () => {
    const client = Object.create(RpcClient.prototype) as any;
    const calls: string[] = [];
    client.command = async (name: string) => {
      calls.push(name);
      return caps;
    };
    await assert.rejects(
      client.replaceChat('new', undefined, { sessionId: 'owned' }),
      /no coherent/
    );
    assert.deepEqual(calls, ['get_capabilities']);
  });

test('uncertain native identity rejects prompt/steer/followUp before sending or altering history', async () => {
  const output = await build({
    entryPoints: ['src/sessions/sessionController.ts'],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    external: ['vscode'],
  });
  const module = { exports: {} as any };
  const require = createRequire(`${process.cwd()}/package.json`);
  new Function('require', 'module', 'exports', output.outputFiles[0]!.text)(
    (id: string) => (id === 'vscode' ? {} : require(id)),
    module,
    module.exports
  );
  const c = Object.create(module.exports.SessionController.prototype);
  let sends = 0;
  c.supervisor = {
    currentClient: {
      prompt: async () => sends++,
      steer: async () => sends++,
      followUp: async () => sends++,
    },
  };
  c.state = {
    ...createInitialControllerState('owned', '/owned'),
    connectionState: 'faulted',
    messages: [{ role: 'user', content: 'outgoing' }],
    draft: 'owned draft',
  };
  const before = structuredClone(c.state);
  for (const mode of ['prompt', 'steer', 'followUp'])
    await assert.rejects(c.prompt('never send', mode), /unconfirmed/);
  assert.equal(sends, 0);
  assert.deepEqual(c.state, before);
});
