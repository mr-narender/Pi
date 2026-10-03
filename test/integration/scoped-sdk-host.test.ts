import assert from 'node:assert/strict';
import test from 'node:test';
import type { spawn } from 'node:child_process';
import { readFile, writeFile, lstat, chmod, mkdir, rm } from 'node:fs/promises';
import {
  createNativeFixture,
  spawnNativeSdkHost,
  resolveNativeCli,
} from '../helpers/nativeFixture';
import { spawnRealPi, shutdown } from '../helpers/rpc';

test(
  'scopes stock fallback: explicit unsupported capability leaves real model/state RPC usable',
  { timeout: 30000 },
  async () => {
    const fixture = await createNativeFixture('scopes');
    const spawned = await spawnRealPi([], fixture);
    try {
      await assert.rejects(spawned.client.getScopedModels(), /unsupported by this backend/);
      assert.ok((await spawned.client.getAvailableModels())?.models);
      assert.ok((await spawned.client.getState())?.sessionId);
      assert.equal(fixture.requests, 0);
    } finally {
      await shutdown(spawned);
    }
  }
);

for (const mode of ['shared', 'dedicated'] as const)
  for (const scenario of ['default', 'patterns', 'project', 'parity'] as const) {
    test(
      `scopes SDK ${mode}/${scenario}: native session/read/set/save, safe DTO, symlink merge, stale and failed save`,
      { timeout: 60000 },
      async () => {
        const fixture = await createNativeFixture('scopes');
        let child: ReturnType<typeof spawn> | undefined;
        try {
          const target = await fixture.linkSettings('global');
          const original = JSON.parse(await readFile(target, 'utf8'));
          original.unknown = { nested: ['retained'] };
          original.enabledModels = ['fixture-beta/ping', 'unavailable/*'];
          await writeFile(target, JSON.stringify(original));
          const project =
            scenario === 'project'
              ? { enabledModels: ['fixture-beta/ping'], unknownProject: { keep: true } }
              : {};
          await writeFile(fixture.projectSettings, JSON.stringify(project));
          const started = await spawnNativeSdkHost(fixture, mode, scenario);
          const plan = { open: started.open };
          child = started.child;
          let buffer = '';
          let stderr = '';
          child.stderr!.on('data', (c) => {
            stderr += c;
          });
          const pending = new Map<
            string,
            { resolve: (r: any) => void; reject: (e: Error) => void }
          >();
          child.stdout!.on('data', (c) => {
            buffer += c;
            let i;
            while ((i = buffer.indexOf('\n')) >= 0) {
              const line = buffer.slice(0, i);
              buffer = buffer.slice(i + 1);
              const { k, d } = JSON.parse(line);
              const key = `${k}:${d.id ?? d.command}`;
              if (d.type === 'response') {
                pending.get(key)?.resolve(d);
                pending.delete(key);
              }
            }
          });
          child.on('exit', () => {
            for (const p of pending.values()) p.reject(new Error(`host exited: ${stderr}`));
          });
          let seq = 0;
          const rpc = async (k: string, d: any) => {
            const id = d.type === 'open' ? undefined : String(++seq);
            const key = `${k}:${id ?? 'open'}`;
            const result = new Promise<any>((resolve, reject) =>
              pending.set(key, { resolve, reject })
            );
            child!.stdin!.write(JSON.stringify({ k, d: { ...d, id } }) + '\n');
            const response = await result;
            if (!response.success) throw new Error(response.error);
            return response.data;
          };
          await rpc('one', plan.open);
          const caps = await rpc('one', { type: 'get_capabilities' });
          assert.equal(caps.scopedModels.saveGlobal, true);
          assert.equal(caps.sdkVersion, (await resolveNativeCli()).version);
          const state = await rpc('one', { type: 'get_state' });
          let snapshot = await rpc('one', { type: 'get_scoped_models' });
          assert.equal(snapshot.models.length, 3);
          const initialScopes =
            scenario === 'patterns'
              ? [
                  { provider: 'fixture-beta', id: 'ping', thinkingLevel: 'high' },
                  { provider: 'fixture-alpha', id: 'colon:id' },
                  { provider: 'fixture-alpha', id: 'ping' },
                ]
              : [{ provider: 'fixture-beta', id: 'ping' }];
          assert.deepEqual(
            snapshot.scoped,
            initialScopes,
            'native pattern order/dedupe/exact colon ID/invalid suffix fallback'
          );
          assert.equal(snapshot.projectOverride, scenario === 'project');
          if (scenario === 'parity') {
            assert.equal(state.model.provider, 'fixture-beta');
            assert.equal(
              state.thinkingLevel,
              'off',
              'native nonreasoning model clamps CLI thinking'
            );
            assert.equal(state.sessionName, 'Owned parity');
          }
          assert.deepEqual(snapshot.globalDiagnostics, [
            { code: 'no-match', pattern: 'unavailable/*' },
          ]);
          assert.ok(!/apiKey|baseUrl|headers|fixture-dummy/.test(JSON.stringify(snapshot)));
          if (mode === 'shared') {
            await rpc('two', plan.open);
            assert.deepEqual(
              (await rpc('two', { type: 'get_scoped_models' })).scoped,
              snapshot.scoped
            );
          }
          const refs = [{ provider: 'fixture-alpha', id: 'ping', thinkingLevel: 'high' }];
          snapshot = await rpc('one', {
            type: 'set_scoped_models',
            expectedRevision: snapshot.revision,
            refs,
          });
          assert.deepEqual(snapshot.scoped, refs);
          assert.deepEqual((await rpc('one', { type: 'get_state' })).model, state.model);
          assert.equal(await readFile(target, 'utf8'), JSON.stringify(original));
          const stale = snapshot.revision;
          original.enabledModels.push('another-missing');
          await writeFile(target, JSON.stringify(original));
          await assert.rejects(
            rpc('one', { type: 'save_scoped_models_default', expectedRevision: stale, refs }),
            /SCOPES_STALE_REVISION/
          );
          snapshot = await rpc('one', { type: 'get_scoped_models' });
          await assert.rejects(
            rpc('one', {
              type: 'save_scoped_models_default',
              expectedRevision: snapshot.revision,
              refs,
            }),
            /REQUIRE_CONFIRMATION/
          );
          snapshot = await rpc('one', {
            type: 'save_scoped_models_default',
            expectedRevision: snapshot.revision,
            refs,
            replaceUnavailable: true,
          });
          assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), {
            ...original,
            enabledModels: ['fixture-alpha/ping:high'],
          });
          assert.equal((await lstat(fixture.globalSettings)).isSymbolicLink(), true);
          assert.deepEqual(JSON.parse(await readFile(fixture.projectSettings, 'utf8')), project);
          if (scenario === 'project')
            assert.deepEqual(
              snapshot.effectivePatterns,
              ['fixture-beta/ping'],
              'project remains effective after global save'
            );
          const savedBytes = await readFile(target, 'utf8');
          const lockPath = fixture.globalSettings + '.lock';
          await mkdir(lockPath);
          await assert.rejects(
            rpc('one', {
              type: 'save_scoped_models_default',
              expectedRevision: snapshot.revision,
              refs: [],
              replaceUnavailable: true,
            }),
            /SETTINGS_READ_FAILED/
          );
          await rm(lockPath, { recursive: true });
          assert.equal(await readFile(target, 'utf8'), savedBytes, 'lock failure retains settings');
          assert.deepEqual(
            (await rpc('one', { type: 'get_scoped_models' })).scoped,
            refs,
            'lock failure retains session'
          );
          await chmod(target, 0o400);
          await assert.rejects(
            rpc('one', {
              type: 'save_scoped_models_default',
              expectedRevision: snapshot.revision,
              refs: [{ provider: 'fixture-beta', id: 'ping' }],
              replaceUnavailable: true,
            }),
            /SETTINGS_WRITE_FAILED/
          );
          assert.equal(
            await readFile(target, 'utf8'),
            savedBytes,
            'permission failure keeps old complete settings'
          );
          assert.deepEqual(
            (await rpc('one', { type: 'get_scoped_models' })).scoped,
            refs,
            'permission failure retains staged session'
          );
          await chmod(target, 0o600);
          await writeFile(target, '{bad json');
          await assert.rejects(
            rpc('one', {
              type: 'save_scoped_models_default',
              expectedRevision: snapshot.revision,
              refs: [],
            }),
            /SETTINGS_READ_FAILED/
          );
          await writeFile(target, JSON.stringify({ ...original, enabledModels: [] }));
          snapshot = await rpc('one', { type: 'get_scoped_models' });
          assert.deepEqual(snapshot.scoped, refs, 'failed save retains session');
          snapshot = await rpc('one', {
            type: 'save_scoped_models_default',
            expectedRevision: snapshot.revision,
            refs: [],
          });
          assert.deepEqual(snapshot.scoped, []);
          assert.deepEqual(JSON.parse(await readFile(target, 'utf8')).enabledModels, []);
          if (mode === 'shared')
            assert.deepEqual(
              (await rpc('two', { type: 'get_scoped_models' })).scoped,
              initialScopes
            );
          assert.equal(fixture.requests, 0, 'scope operations do not call providers');
          child.stdin!.end();
          await new Promise<void>((resolve) => child!.once('exit', () => resolve()));
          child = undefined;
          assert.equal(await readFile(fixture.networkLog, 'utf8'), '', 'no denied egress');
        } finally {
          if (child && child.exitCode === null) {
            child.kill('SIGKILL');
            await new Promise<void>((r) => child!.once('exit', () => r()));
          }
          await fixture.dispose();
        }
      }
    );
  }
