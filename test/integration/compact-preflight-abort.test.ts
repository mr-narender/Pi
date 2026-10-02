import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { createRequire } from 'node:module';

async function controller() {
  const result = await build({
    stdin: {
      contents: "export {SessionController} from './src/sessions/sessionController';",
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
    (id: string) => (id === 'vscode' ? {} : createRequire(`${process.cwd()}/package.json`)(id)),
    module,
    module.exports
  );
  return module.exports.SessionController;
}

for (const phase of ['preflight', 'preflight-abort-failure', 'native'] as const)
  test(`compact explicit Abort cancels ${phase} without false success or replacing reserved work`, async () => {
    const C = await controller();
    const c = Object.create(C.prototype);
    c.state = {
      state: { sessionId: 'owned', sessionFile: '/owned/file' },
      draft: '/compact owned',
      queue: { steering: [], followUp: [] },
    };
    c.fire = () => {};
    const captured = { ...c.state.state };
    let releaseState!: (value: any) => void;
    let releaseCompact!: (value: any) => void;
    let entered!: () => void;
    const nativeEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let calls = 0;
    let sends = 0;
    let aborts = 0;
    let otherAborts = 0;
    const other = Object.create(C.prototype);
    other.supervisor = {
      currentClient: {
        abort: async () => {
          otherAborts++;
        },
      },
    };
    const nativeResult = { summary: 'owned', firstKeptEntryId: 'leaf', tokensBefore: 1 };
    c.supervisor = {
      currentClient: {
        getState: () =>
          new Promise((resolve) => {
            releaseState = resolve;
          }),
        compact: () => {
          calls++;
          if (phase !== 'native') return Promise.resolve(nativeResult);
          entered();
          return new Promise((resolve) => {
            releaseCompact = resolve;
          });
        },
        abort: async () => {
          aborts++;
          if (phase === 'preflight-abort-failure') throw new Error('Authorization secret-canary');
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
      },
    };
    let accepted = false;
    const pending = c.compact().then(
      () => {
        accepted = true;
        return undefined;
      },
      (error: Error) => error
    );
    if (phase === 'native') {
      releaseState(captured);
      await nativeEntered;
    }
    if (phase === 'preflight-abort-failure') await assert.rejects(c.abort());
    else await c.abort();
    for (const mode of ['prompt', 'steer', 'followUp'])
      await assert.rejects(c.prompt('replacement', mode), /compaction/i);
    await assert.rejects(c.compact(), /compaction|idle/i);
    assert.equal(c.manualCompactPending, true);
    if (phase === 'native') releaseCompact(nativeResult);
    else releaseState(captured);
    const error = await pending;
    assert.equal(
      calls,
      phase === 'native' ? 1 : 0,
      'cancelled preflight must send ZERO compact RPCs'
    );
    assert.equal(accepted, false, 'cancelled operation must not produce accepted ACK');
    assert.match(error?.message ?? '', /cancelled/i);
    assert.doesNotMatch(error?.message ?? '', /Authorization|secret-canary/);
    assert.equal(c.state.draft, '/compact owned');
    assert.deepEqual(c.state.queue, { steering: [], followUp: [] });
    assert.equal(aborts, 1);
    assert.equal(otherAborts, 0);
    assert.equal(c.manualCompactPending, false);
    assert.equal(sends, 0);
    await c.prompt('ordinary send after settlement');
    assert.equal(sends, 1);
  });
