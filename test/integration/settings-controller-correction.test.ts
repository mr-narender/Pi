import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { createInitialControllerState } from '../../src/state/types';

async function controller() {
  const result = await build({
    entryPoints: ['src/sessions/sessionController.ts'],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    external: ['vscode'],
  });
  const module = { exports: {} as any };
  const require = createRequire(`${process.cwd()}/package.json`);
  new Function('require', 'module', 'exports', result.outputFiles[0]!.text)(
    (id: string) => (id === 'vscode' ? {} : require(id)),
    module,
    module.exports
  );
  const c = Object.create(module.exports.SessionController.prototype);
  c.state = createInitialControllerState('owned', '/tmp/owned');
  c.state.state.sessionId = 'owned';
  c.state.state.sessionFile = 'owned';
  return c;
}

for (const outcome of [
  'request-failure',
  'flush-failure',
  'stale',
  'refresh-failure',
  'client-change',
  'session-change',
  'refresh-session-change',
  'success',
] as const) {
  test(`settings real controller no false success: ${outcome}`, async () => {
    const c = await controller();
    let calls = 0,
      refreshes = 0;
    const client = {
      savePreference: async (...args: any[]) => {
        calls++;
        assert.deepEqual(args, ['retry', false, 'a'.repeat(64), false]);
        if (['request-failure', 'flush-failure', 'stale'].includes(outcome))
          throw new Error(`OWNED_${outcome}`);
        if (outcome === 'client-change') c.supervisor.currentClient = {};
        if (outcome === 'session-change') c.state.state.sessionId = 'new';
        return { revision: 'b'.repeat(64) };
      },
    };
    c.requireClient = () => client;
    c.supervisor = { currentClient: client };
    c.refreshState = async () => {
      refreshes++;
      if (outcome === 'refresh-failure') throw new Error('OWNED_REFRESH_FAILED');
      if (outcome === 'refresh-session-change') c.state.state.sessionId = 'new';
    };
    const action = c.savePreference('retry', false, 'a'.repeat(64), false);
    if (outcome === 'success') assert.deepEqual(await action, { revision: 'b'.repeat(64) });
    else await assert.rejects(action);
    assert.equal(calls, 1);
    assert.equal(
      refreshes,
      ['refresh-failure', 'refresh-session-change', 'success'].includes(outcome) ? 1 : 0
    );
  });
}

test('settings real controller busy and compact reservations reject before request', async () => {
  for (const busy of [
    'isStreaming',
    'isCompacting',
    'isRetrying',
    'isBashRunning',
    'steering',
    'followUp',
    'manual',
  ]) {
    const c = await controller();
    let calls = 0;
    c.requireClient = () => ({
      savePreference: () => {
        calls++;
      },
    });
    if (busy === 'manual') c.manualCompactPending = true;
    else if (busy === 'steering' || busy === 'followUp') c.state.queue[busy].push({});
    else c.state.state[busy] = true;
    await assert.rejects(c.savePreference('retry', false, 'a'.repeat(64), false));
    assert.equal(calls, 0);
  }
});
