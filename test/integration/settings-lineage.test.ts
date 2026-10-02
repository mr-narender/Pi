import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { createNativeFixture, spawnNativeSdkHost } from '../helpers/nativeFixture';
import { parsePreferencesSnapshot } from '../../src/rpc/preferences';

for (const mode of ['shared', 'dedicated'] as const) {
  for (const startup of [false, true]) {
    test(`settings lineage native ${mode} startup=${startup}`, { timeout: 30000 }, async () => {
      const f = await createNativeFixture('scopes');
      let child: Awaited<ReturnType<typeof spawnNativeSdkHost>>['child'] | undefined;
      try {
        const models = JSON.parse(await readFile(f.modelsFile, 'utf8'));
        for (const provider of Object.values(models.providers) as any[])
          provider.models[0].reasoning = true;
        await writeFile(f.modelsFile, JSON.stringify(models));
        const seed = JSON.parse(await readFile(f.globalSettings, 'utf8'));
        seed.defaultThinkingLevel = 'low';
        seed.unknown = { keep: true };
        const ref = `${startup ? 'fixture-beta' : 'fixture-alpha'}/ping`;
        const project: any = { defaultThinkingLevel: 'high', unknown: { project: true } };
        await writeFile(f.globalSettings, JSON.stringify(seed));
        await writeFile(f.projectSettings, JSON.stringify(project));
        const started = await spawnNativeSdkHost(f, mode, startup ? 'parity' : 'project');
        child = started.child;
        let buf = '',
          seq = 0;
        const pending = new Map<string, (r: any) => void>();
        child.stdout!.on('data', (chunk) => {
          buf += chunk;
          let i;
          while ((i = buf.indexOf('\n')) >= 0) {
            const { d } = JSON.parse(buf.slice(0, i));
            buf = buf.slice(i + 1);
            if (d.type === 'response') {
              pending.get(d.id ?? d.command)?.(d);
              pending.delete(d.id ?? d.command);
            }
          }
        });
        const rpc = async (d: any) => {
          const id = d.type === 'open' ? undefined : String(++seq);
          const response = new Promise<any>((resolve) => pending.set(id ?? 'open', resolve));
          child!.stdin!.write(JSON.stringify({ k: 'owned', d: { ...d, id } }) + '\n');
          const r = await response;
          assert.equal(r.success, true, r.error);
          return r.data;
        };
        await rpc(started.open);
        const check = async (effective: string, source: string) => {
          const snap = parsePreferencesSnapshot(await rpc({ type: 'get_preferences' }));
          const row = snap.rows.find((r) => r.key === `modelThinking:${ref}`)!;
          assert.equal(row.effective, effective);
          assert.equal(row.source, source);
          return { snap, row };
        };
        let current = await check(startup ? 'low' : 'high', startup ? 'global' : 'project');
        assert.equal(current.row.active, startup ? 'medium' : 'high');
        // The parity scenario is intentionally unapproved: its project settings
        // must not participate. CLI thinking describes active, not saved defaults.
        seed.modelThinkingLevels = { [ref]: 'minimal', 'unknown/sibling': 'low' };
        await writeFile(f.globalSettings, JSON.stringify(seed));
        await check('minimal', 'global');
        project.modelThinkingLevels = { [ref]: 'high' };
        await writeFile(f.projectSettings, JSON.stringify(project));
        await check(startup ? 'minimal' : 'high', startup ? 'global' : 'project');
        delete project.modelThinkingLevels;
        await writeFile(f.projectSettings, JSON.stringify(project));
        current = await check('minimal', 'global');
        await rpc({
          type: 'save_preference',
          key: `modelThinking:${ref}`,
          value: null,
          expectedRevision: current.snap.revision,
          confirmGlobal: true,
        });
        await check(startup ? 'low' : 'high', startup ? 'global' : 'project');
        const saved = JSON.parse(await readFile(f.globalSettings, 'utf8'));
        assert.deepEqual(saved.unknown, seed.unknown);
        assert.equal(saved.modelThinkingLevels['unknown/sibling'], 'low');
        delete project.defaultThinkingLevel;
        await writeFile(f.projectSettings, JSON.stringify(project));
        await check('low', 'global');
        delete saved.defaultThinkingLevel;
        await writeFile(f.globalSettings, JSON.stringify(saved));
        await check('medium', 'native-default');
        assert.equal(f.requests, 0);
        assert.equal(await readFile(f.networkLog, 'utf8'), '');
      } finally {
        child?.stdin?.end();
        child?.kill();
        if (child && child.exitCode === null) await new Promise((r) => child!.once('exit', r));
        await f.dispose();
      }
    });
  }
}
