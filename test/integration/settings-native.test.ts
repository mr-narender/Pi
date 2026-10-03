import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, writeFile, lstat, mkdir, rm, chmod } from 'node:fs/promises';
import { createNativeFixture, spawnNativeSdkHost } from '../helpers/nativeFixture';
import { parsePreferencesSnapshot } from '../../src/rpc/preferences';
import { spawnRealPi, shutdown } from '../helpers/rpc';

test(
  'settings stock capability is honestly unsupported; normal RPC remains usable',
  { timeout: 30000 },
  async () => {
    const fixture = await createNativeFixture('scopes');
    const spawned = await spawnRealPi([], fixture);
    try {
      await assert.rejects(spawned.client.getPreferences(), /unsupported by this backend/);
      assert.ok((await spawned.client.getState())?.sessionId);
      assert.equal(fixture.requests, 0);
    } finally {
      await shutdown(spawned);
    }
  }
);

for (const mode of ['shared', 'dedicated'] as const) {
  test(
    `settings SDK ${mode}: typed native preferences, persistence and preservation`,
    { timeout: 60000 },
    async () => {
      const fixture = await createNativeFixture('scopes');
      let child: Awaited<ReturnType<typeof spawnNativeSdkHost>>['child'] | undefined;
      try {
        const target = await fixture.linkSettings('global');
        const seed = JSON.parse(await readFile(target, 'utf8'));
        seed.unknown = { private: 'keep' };
        seed.images = { unknown: true };
        seed.warnings = { unknown: true };
        seed.modelThinkingLevels = { 'unavailable/other': 'high' };
        seed.cacheWarming = 'off';
        await writeFile(target, JSON.stringify(seed));
        const project = {
          steeringMode: 'one-at-a-time',
          images: { blockImages: false },
          cacheWarming: 'idle',
          defaultProjectTrust: 'always',
        };
        await writeFile(fixture.projectSettings, JSON.stringify(project));
        const started = await spawnNativeSdkHost(fixture, mode, 'project');
        child = started.child;
        let buffer = '';
        const pending = new Map<string, (r: any) => void>();
        child.stdout!.on('data', (c) => {
          buffer += c;
          let i;
          while ((i = buffer.indexOf('\n')) >= 0) {
            const { k, d } = JSON.parse(buffer.slice(0, i));
            buffer = buffer.slice(i + 1);
            if (d.type === 'response') {
              pending.get(`${k}:${d.id ?? d.command}`)?.(d);
              pending.delete(`${k}:${d.id ?? d.command}`);
            }
          }
        });
        let seq = 0;
        const rpc = async (k: string, d: any) => {
          const id = d.type === 'open' ? undefined : String(++seq);
          const p = new Promise<any>((resolve) => pending.set(`${k}:${id ?? 'open'}`, resolve));
          child!.stdin!.write(JSON.stringify({ k, d: { ...d, id } }) + '\n');
          const r = await p;
          if (!r.success) throw new Error(r.error);
          return r.data;
        };
        await rpc('one', started.open);
        assert.equal((await rpc('one', { type: 'get_capabilities' })).preferences?.contract, 1);
        if (mode === 'shared') await rpc('two', started.open);
        let snapshot = await rpc('one', { type: 'get_preferences' });
        assert.equal(parsePreferencesSnapshot(snapshot).rows.length, snapshot.rows.length);
        assert.ok(
          !/apiKey|baseUrl|headers|private|unknown|fixture-dummy/.test(JSON.stringify(snapshot))
        );
        const save = async (key: string, value: any, extra = {}) => {
          snapshot = await rpc('one', {
            type: 'save_preference',
            key,
            value,
            expectedRevision: snapshot.revision,
            confirmGlobal: true,
            ...extra,
          });
          return snapshot.rows.find((r: any) => r.key === key);
        };
        const matrix = [
          ['compaction', false, 'compaction', 'enabled'],
          ['retry', false, 'retry', 'enabled'],
          ['steeringMode', 'all', 'steeringMode'],
          ['followUpMode', 'all', 'followUpMode'],
          ['transport', 'sse', 'transport'],
          ['httpIdleTimeoutMs', 1234, 'httpIdleTimeoutMs'],
          ['cacheWarming', 'off', 'cacheWarming'],
          ['imageAutoResize', false, 'images', 'autoResize'],
          ['blockImages', true, 'images', 'blockImages'],
          ['enableSkillCommands', false, 'enableSkillCommands'],
          ['defaultProjectTrust', 'never', 'defaultProjectTrust'],
          ['enableInstallTelemetry', false, 'enableInstallTelemetry'],
          ['anthropicExtraUsage', false, 'warnings', 'anthropicExtraUsage'],
        ];
        let expected = structuredClone(seed);
        for (const [key, value, field, nested] of matrix) {
          const row = await save(String(key), value);
          if (nested) {
            expected[String(field)] ??= {};
            expected[String(field)][String(nested)] = value;
          } else expected[String(field)] = value;
          assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), expected);
          assert.equal(row.global, value);
          if (key === 'steeringMode') {
            assert.equal(row.active, 'all');
            assert.equal(row.effective, 'one-at-a-time');
          }
          if (key === 'blockImages') {
            assert.equal(row.active, false);
            assert.equal(row.effective, false);
          }
          if (key === 'transport') assert.equal(row.active, 'sse');
          if (key === 'cacheWarming') assert.equal(row.effective, 'off');
          if (key === 'httpIdleTimeoutMs') assert.equal(row.effect, 'next-start');
          assert.deepEqual(JSON.parse(await readFile(fixture.projectSettings, 'utf8')), project);
          assert.equal((await lstat(fixture.globalSettings)).isSymbolicLink(), true);
        }
        const currentModel = (await rpc('one', { type: 'get_state' })).model;
        const modelKey = `modelThinking:${currentModel.provider}/${currentModel.id}`;
        await save(modelKey, 'off');
        assert.equal(
          snapshot.rows.find((r: any) => r.key === modelKey).active,
          (await rpc('one', { type: 'get_state' })).thinkingLevel
        );
        assert.equal(
          JSON.parse(await readFile(target, 'utf8')).modelThinkingLevels['unavailable/other'],
          'high'
        );
        await save(modelKey, null);
        const stateBefore = await rpc('one', { type: 'get_state' });
        const thinking = await rpc('one', { type: 'get_available_thinking_levels' });
        const otherThinking = thinking.levels.find((l: string) => l !== stateBefore.thinkingLevel);
        if (otherThinking) {
          const staleThinking = snapshot.revision;
          await rpc('one', {
            type: 'set_thinking_level',
            level: otherThinking,
            expectedRevision: thinking.revision,
          });
          await assert.rejects(
            rpc('one', {
              type: 'save_preference',
              key: 'retry',
              value: true,
              expectedRevision: staleThinking,
              confirmGlobal: true,
            }),
            /STALE/
          );
          snapshot = await rpc('one', { type: 'get_preferences' });
        }
        if (mode === 'shared') {
          const two = await rpc('two', { type: 'get_preferences' });
          await rpc('two', {
            type: 'save_preference',
            key: 'retry',
            value: true,
            expectedRevision: two.revision,
            confirmGlobal: true,
          });
          await assert.rejects(
            rpc('one', {
              type: 'save_preference',
              key: 'retry',
              value: false,
              expectedRevision: snapshot.revision,
              confirmGlobal: true,
            }),
            /STALE/
          );
          snapshot = await rpc('one', { type: 'get_preferences' });
        }
        const bytes = await readFile(target, 'utf8');
        for (const bad of [
          { key: 'packages', value: [] },
          { key: 'retry', value: 'true' },
          { key: 'transport', value: 'invalid' },
          { key: 'httpIdleTimeoutMs', value: -1 },
          { key: 'retry', value: false, extra: 'private' },
          { key: 'retry', value: false, confirmGlobal: false },
          { key: 'cacheWarming', value: 'idle' },
        ]) {
          await assert.rejects(
            rpc('one', {
              type: 'save_preference',
              expectedRevision: snapshot.revision,
              confirmGlobal: true,
              ...bad,
            }),
            /PREFERENCES_INVALID/
          );
          assert.equal(await readFile(target, 'utf8'), bytes);
        }
        const revision = snapshot.revision;
        const modified = JSON.parse(bytes);
        modified.unknown.concurrent = true;
        await writeFile(target, JSON.stringify(modified));
        await assert.rejects(
          rpc('one', {
            type: 'save_preference',
            key: 'retry',
            value: true,
            expectedRevision: revision,
            confirmGlobal: true,
          }),
          /STALE/
        );
        snapshot = await rpc('one', { type: 'get_preferences' });
        await mkdir(fixture.globalSettings + '.lock');
        await assert.rejects(save('retry', true), /READ_FAILED/);
        await rm(fixture.globalSettings + '.lock', { recursive: true });
        snapshot = await rpc('one', { type: 'get_preferences' });
        const savedRetry = snapshot.rows.find((r: any) => r.key === 'retry').global;
        await chmod(target, 0o400);
        await assert.rejects(save('retry', !savedRetry), /WRITE_FAILED/);
        await chmod(target, 0o600);
        snapshot = await rpc('one', { type: 'get_preferences' });
        const partialRetry = snapshot.rows.find((r: any) => r.key === 'retry');
        assert.equal(
          partialRetry.global,
          savedRetry,
          'failed flush does not acknowledge new default'
        );
        assert.equal(
          partialRetry.active,
          !savedRetry,
          'native runtime change before failed flush is truthful partial failure, not rollback'
        );
        await rpc('one', { type: 'steer', message: 'Owned queued text; never sent to a provider' });
        assert.ok((await rpc('one', { type: 'get_preferences' })).revision);
        await assert.rejects(save('retry', true), /BUSY/);
        assert.equal((await rpc('one', { type: 'get_state' })).pendingMessageCount, 1);
        await writeFile(target, '{broken');
        await assert.rejects(rpc('one', { type: 'get_preferences' }), /READ_FAILED/);
        assert.equal(await readFile(target, 'utf8'), '{broken');
        assert.equal(fixture.requests, 0);
        assert.equal(await readFile(fixture.networkLog, 'utf8'), '');
      } finally {
        child?.stdin?.end();
        child?.kill();
        if (child && child.exitCode === null) await new Promise((r) => child!.once('exit', r));
        await fixture.dispose();
      }
    }
  );
}
