import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { createNativeFixture, spawnNativeSdkHost } from '../helpers/nativeFixture';

for (const mode of ['shared', 'dedicated'] as const)
  test(
    `thinking SDK ${mode}: native no-model fallback is not a fabricated model capability`,
    { timeout: 30000 },
    async () => {
      const fixture = await createNativeFixture('scopes');
      let child: Awaited<ReturnType<typeof spawnNativeSdkHost>>['child'] | undefined;
      try {
        await writeFile(fixture.modelsFile, '{"providers":{}}');
        const settings = JSON.parse(await readFile(fixture.globalSettings, 'utf8'));
        delete settings.defaultProvider;
        delete settings.defaultModel;
        const original = JSON.stringify(settings);
        await writeFile(fixture.globalSettings, original);
        const started = await spawnNativeSdkHost(fixture, mode);
        child = started.child;
        let buffer = '';
        let seq = 0;
        const pending = new Map<string, (r: any) => void>();
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
        const rpc = async (d: any): Promise<any> => {
          const id = d.type === 'open' ? undefined : String(++seq);
          const result = new Promise((resolve) => pending.set(id ?? 'open', resolve));
          child!.stdin!.write(JSON.stringify({ k: 'one', d: { ...d, id } }) + '\n');
          return result;
        };
        assert.equal((await rpc(started.open)).success, true);
        const state = (await rpc({ type: 'get_state' })).data;
        assert.equal(state.model.provider, 'unknown');
        assert.equal(state.model.id, 'unknown');
        const caps = (await rpc({ type: 'get_available_thinking_levels' })).data;
        assert.deepEqual(
          caps.levels,
          ['off'],
          'native SDK rootProvider uses a nonreasoning unknown-model sentinel when no models are available'
        );
        const applied = await rpc({
          type: 'set_thinking_level',
          level: 'xhigh',
          expectedRevision: caps.revision,
        });
        assert.equal(applied.success, false);
        assert.equal(applied.error, 'THINKING_UNSUPPORTED_LEVEL');
        assert.equal((await rpc({ type: 'get_state' })).data.thinkingLevel, 'off');
        assert.equal(await readFile(fixture.globalSettings, 'utf8'), original);
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
