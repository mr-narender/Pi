import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createNativeFixture, spawnNativeSdkHost } from '../helpers/nativeFixture';

for (const mode of ['shared', 'dedicated'] as const)
  test(
    `scopes actual SDK ${mode}: current model invalidates picker revision`,
    { timeout: 30000 },
    async () => {
      const fixture = await createNativeFixture('scopes');
      let child: Awaited<ReturnType<typeof spawnNativeSdkHost>>['child'] | undefined;
      try {
        const started = await spawnNativeSdkHost(fixture, mode);
        child = started.child;
        let buffer = '';
        let seq = 0;
        const pending = new Map<string, (value: any) => void>();
        child.stdout!.on('data', (c) => {
          buffer += c;
          let i;
          while ((i = buffer.indexOf('\n')) >= 0) {
            const { d } = JSON.parse(buffer.slice(0, i));
            buffer = buffer.slice(i + 1);
            if (d.type === 'response') {
              pending.get(d.id ?? 'open')?.(d);
              pending.delete(d.id ?? 'open');
            }
          }
        });
        const rpc = async (d: any, k = 'one'): Promise<any> => {
          const id = d.type === 'open' ? undefined : String(++seq);
          const result = new Promise((resolve) => pending.set(id ?? 'open', resolve));
          child!.stdin!.write(JSON.stringify({ k, d: { ...d, id } }) + '\n');
          return result;
        };
        assert.equal((await rpc(started.open)).success, true);
        const before = (await rpc({ type: 'get_scoped_models' })).data;
        if (mode === 'shared') {
          assert.equal((await rpc(started.open, 'two')).success, true);
          assert.equal((await rpc({ type: 'cycle_model' }, 'two')).success, true);
          assert.equal(
            (await rpc({ type: 'get_scoped_models' })).data.revision,
            before.revision,
            'another chat current model is not this picker context'
          );
        }
        const state1 = (await rpc({ type: 'get_state' })).data;
        assert.equal((await rpc({ type: 'cycle_model' })).success, true);
        const state2 = (await rpc({ type: 'get_state' })).data;
        assert.notDeepEqual(state1.model, state2.model);
        const after = (await rpc({ type: 'get_scoped_models' })).data;
        const stale = await rpc({
          type: 'set_scoped_models',
          expectedRevision: before.revision,
          refs: [{ provider: 'fixture-alpha', id: 'ping' }],
        });
        assert.equal(stale.success, false, 'pre-cycle selection must be rejected');
        assert.equal(stale.error, 'SCOPES_STALE_REVISION');
        assert.notEqual(after.revision, before.revision);
        assert.deepEqual((await rpc({ type: 'get_scoped_models' })).data.scoped, after.scoped);
        const valid = await rpc({
          type: 'set_scoped_models',
          expectedRevision: after.revision,
          refs: [{ provider: 'fixture-alpha', id: 'ping' }],
        });
        assert.equal(valid.success, true, 'unchanged current model permits valid selection');
        const saved = await rpc({
          type: 'save_scoped_models_default',
          expectedRevision: valid.data.revision,
          refs: [{ provider: 'fixture-alpha', id: 'ping' }],
        });
        assert.equal(saved.success, true);
        assert.deepEqual(JSON.parse(await readFile(fixture.globalSettings, 'utf8')).enabledModels, [
          'fixture-alpha/ping',
        ]);
        assert.deepEqual((await rpc({ type: 'get_state' })).data.model, state2.model);
        const oldSessionId = (await rpc({ type: 'get_state' })).data.sessionId;
        assert.equal((await rpc({ type: 'new_session' })).success, true);
        assert.notEqual((await rpc({ type: 'get_state' })).data.sessionId, oldSessionId);
        const staleSession = await rpc({
          type: 'set_scoped_models',
          expectedRevision: saved.data.revision,
          refs: [],
        });
        assert.equal(staleSession.success, false);
        assert.equal(staleSession.error, 'SCOPES_STALE_REVISION');
        assert.equal(fixture.requests, 0);
        assert.equal(await readFile(fixture.networkLog, 'utf8'), '');
        child.stdin!.end();
        await new Promise((resolve) => child!.once('exit', resolve));
        child = undefined;
      } finally {
        if (child && child.exitCode === null) {
          child.kill('SIGKILL');
          await new Promise((resolve) => child!.once('exit', resolve));
        }
        await fixture.dispose();
      }
    }
  );
