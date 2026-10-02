import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { createNativeFixture, spawnNativeSdkHost } from '../helpers/nativeFixture';

for (const mode of ['shared', 'dedicated'] as const)
  test(
    `thinking SDK ${mode}: native capabilities strict setters events cycling persistence and stale selection`,
    { timeout: 30000 },
    async () => {
      const fixture = await createNativeFixture('scopes');
      let child: Awaited<ReturnType<typeof spawnNativeSdkHost>>['child'] | undefined;
      try {
        const models = JSON.parse(await readFile(fixture.modelsFile, 'utf8'));
        const base = models.providers['fixture-beta'].models[0];
        models.providers['fixture-beta'].models.push({
          ...base,
          id: 'reasoning',
          reasoning: true,
          thinkingLevelMap: { minimal: null, xhigh: 'xhigh', max: 'max' },
        });
        await writeFile(fixture.modelsFile, JSON.stringify(models));
        const settings = JSON.parse(await readFile(fixture.globalSettings, 'utf8'));
        settings.defaultThinkingLevel = 'high';
        settings.unknown = { keep: ['all'] };
        settings.packages = [];
        settings.compaction = { enabled: false, reserveTokens: 2222 };
        const original = JSON.stringify(settings);
        await writeFile(fixture.globalSettings, original);
        const project = '{"unknownProject":{"keep":true}}';
        await writeFile(fixture.projectSettings, project);
        const started = await spawnNativeSdkHost(fixture, mode);
        child = started.child;
        let buffer = '';
        let seq = 0;
        const events: any[] = [];
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
            } else events.push(d);
          }
        });
        const rpc = async (d: any, k = 'one'): Promise<any> => {
          const id = d.type === 'open' ? undefined : String(++seq);
          const result = new Promise((resolve) => pending.set(id ?? 'open', resolve));
          child!.stdin!.write(JSON.stringify({ k, d: { ...d, id } }) + '\n');
          return result;
        };
        assert.equal((await rpc(started.open)).success, true);
        assert.deepEqual((await rpc({ type: 'get_capabilities' })).data.thinking, {
          contract: 1,
          read: true,
          strictSet: true,
        });
        const off = (await rpc({ type: 'get_available_thinking_levels' })).data;
        assert.deepEqual(off.levels, ['off']);
        const invalid = await rpc({ type: 'set_thinking_level', level: 'high' });
        assert.equal(invalid.success, false);
        assert.equal(invalid.error, 'THINKING_UNSUPPORTED_LEVEL');
        assert.equal((await rpc({ type: 'get_state' })).data.thinkingLevel, 'off');
        await rpc({ type: 'set_model', provider: 'fixture-beta', modelId: 'reasoning' });
        const caps = (await rpc({ type: 'get_available_thinking_levels' })).data;
        assert.deepEqual(caps.levels, ['off', 'low', 'medium', 'high', 'xhigh', 'max']);
        assert.equal(
          (await rpc({ type: 'set_thinking_level', level: 'low', expectedRevision: off.revision }))
            .error,
          'THINKING_STALE_REVISION'
        );
        const set = await rpc({
          type: 'set_thinking_level',
          level: 'max',
          expectedRevision: caps.revision,
        });
        assert.equal(set.success, true);
        assert.equal(set.data.level, 'max');
        const currentState = (await rpc({ type: 'get_state' })).data;
        assert.equal(currentState.thinkingLevel, 'max');
        assert.deepEqual(currentState.availableThinkingLevels, caps.levels);
        const sameCaps = (await rpc({ type: 'get_available_thinking_levels' })).data;
        const eventCount = events.filter((e) => e.type === 'thinking_level_changed').length;
        assert.equal(
          (
            await rpc({
              type: 'set_thinking_level',
              level: 'max',
              expectedRevision: sameCaps.revision,
            })
          ).data.level,
          'max'
        );
        assert.equal(
          events.filter((e) => e.type === 'thinking_level_changed').length,
          eventCount,
          'native same value emits no change'
        );
        assert.ok(events.some((e) => e.type === 'thinking_level_changed' && e.level === 'max'));
        const entries = (await rpc({ type: 'get_entries' })).data.entries;
        assert.ok(
          entries.some((e: any) => e.type === 'thinking_level_change' && e.thinkingLevel === 'max')
        );
        assert.equal((await rpc({ type: 'cycle_thinking_level' })).data.level, 'off');
        const fresh = (await rpc({ type: 'get_available_thinking_levels' })).data;
        if (mode === 'shared') {
          await rpc(started.open, 'two');
          await rpc({ type: 'cycle_model' }, 'two');
          assert.equal(
            (await rpc({ type: 'get_available_thinking_levels' })).data.revision,
            fresh.revision
          );
        }
        await rpc({ type: 'set_model', provider: 'fixture-alpha', modelId: 'ping' });
        assert.equal((await rpc({ type: 'cycle_thinking_level' })).data, null);
        assert.equal((await rpc({ type: 'get_state' })).data.thinkingLevel, 'off');
        await rpc({ type: 'set_model', provider: 'fixture-beta', modelId: 'reasoning' });
        assert.equal(
          (
            await rpc({
              type: 'set_thinking_level',
              level: 'low',
              expectedRevision: fresh.revision,
            })
          ).error,
          'THINKING_STALE_REVISION'
        );
        assert.equal(await readFile(fixture.globalSettings, 'utf8'), original);
        assert.equal(await readFile(fixture.projectSettings, 'utf8'), project);
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
