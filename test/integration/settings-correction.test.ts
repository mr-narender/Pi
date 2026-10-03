import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import {
  createNativeFixture,
  spawnNativeSdkHost,
  resolveNativeCli,
} from '../helpers/nativeFixture';

async function ownedHost(
  mode: 'shared' | 'dedicated',
  run: (
    f: Awaited<ReturnType<typeof createNativeFixture>>,
    rpc: (d: any) => Promise<any>
  ) => Promise<void>
) {
  const f = await createNativeFixture('scopes');
  let child: Awaited<ReturnType<typeof spawnNativeSdkHost>>['child'] | undefined;
  try {
    const config = JSON.parse(await readFile(f.modelsFile, 'utf8'));
    const base = config.providers['fixture-alpha'].models[0];
    config.providers['fixture-alpha'].models.push(
      { ...base, id: 'reason', reasoning: true },
      {
        ...base,
        id: 'mapped',
        reasoning: true,
        thinkingLevelMap: { minimal: null, low: null, xhigh: 'high', max: 'max' },
      },
      { ...base, id: 'null-map', reasoning: true, thinkingLevelMap: { xhigh: null, max: null } }
    );
    await writeFile(f.modelsFile, JSON.stringify(config));
    const started = await spawnNativeSdkHost(f, mode);
    child = started.child;
    let buf = '',
      seq = 0;
    const pending = new Map<string, (r: any) => void>();
    child.stdout!.on('data', (c) => {
      buf += c;
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
      const p = new Promise<any>((r) => pending.set(id ?? 'open', r));
      child!.stdin!.write(JSON.stringify({ k: 'owned', d: { ...d, id } }) + '\n');
      const r = await p;
      if (!r.success) throw new Error(r.error);
      return r.data;
    };
    await rpc(started.open);
    await run(f, rpc);
    assert.equal(f.requests, 0);
    assert.equal(await readFile(f.networkLog, 'utf8'), '');
  } finally {
    child?.stdin?.end();
    child?.kill();
    if (child && child.exitCode === null) await new Promise((r) => child!.once('exit', r));
    await f.dispose();
  }
}

for (const mode of ['shared', 'dedicated'] as const) {
  for (const scope of ['per-model', 'global'] as const) {
    test(
      `settings correction ${mode} malformed ${scope} never crosses wire`,
      { timeout: 30000 },
      async () => {
        await ownedHost(mode, async (f, rpc) => {
          const seed = JSON.parse(await readFile(f.globalSettings, 'utf8'));
          const key = 'fixture-alpha/ping';
          const secret = {
            privateCanary: 'OWNED_SETTINGS_SECRET',
            auth: { apiKey: 'OWNED_SETTINGS_SECRET' },
          };
          if (scope === 'per-model') seed.modelThinkingLevels = { [key]: secret };
          else seed.defaultThinkingLevel = secret;
          await writeFile(f.globalSettings, JSON.stringify(seed));
          const snap = await rpc({ type: 'get_preferences' });
          assert.equal(JSON.stringify(snap).includes('OWNED_SETTINGS_SECRET'), false);
          assert.equal(
            snap.rows.find((r: any) => r.key === `modelThinking:${key}`).effective,
            null
          );
          assert.deepEqual(JSON.parse(await readFile(f.globalSettings, 'utf8')), seed);
        });
      }
    );
  }
  test(
    `settings correction ${mode} SDK supported model matrix and no-write rejection`,
    { timeout: 30000 },
    async () => {
      const sdk = await resolveNativeCli();
      const native = await import(
        pathToFileURL(join(sdk.root, 'node_modules/@earendil-works/pi-ai/dist/models.js')).href
      );
      await ownedHost(mode, async (f, rpc) => {
        const config = JSON.parse(await readFile(f.modelsFile, 'utf8'));
        let snap = await rpc({ type: 'get_preferences' });
        for (const model of config.providers['fixture-alpha'].models) {
          await rpc({ type: 'set_model', provider: 'fixture-alpha', modelId: model.id });
          snap = await rpc({ type: 'get_preferences' });
          const row = snap.rows.find(
            (r: any) => r.key === `modelThinking:fixture-alpha/${model.id}`
          );
          const supported = model.reasoning ? native.getSupportedThinkingLevels(model) : ['off'];
          assert.deepEqual(row.choices, [null, ...supported]);
          const bytes = await readFile(f.globalSettings, 'utf8');
          const before = await rpc({ type: 'get_state' });
          for (const value of ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].filter(
            (v) => !supported.includes(v)
          )) {
            await assert.rejects(
              rpc({
                type: 'save_preference',
                key: row.key,
                value,
                expectedRevision: snap.revision,
                confirmGlobal: true,
              }),
              /PREFERENCES_INVALID/
            );
            assert.equal(await readFile(f.globalSettings, 'utf8'), bytes);
            assert.equal((await rpc({ type: 'get_state' })).thinkingLevel, before.thinkingLevel);
          }
          snap = await rpc({
            type: 'save_preference',
            key: row.key,
            value: supported.at(-1),
            expectedRevision: snap.revision,
            confirmGlobal: true,
          });
          snap = await rpc({
            type: 'save_preference',
            key: row.key,
            value: null,
            expectedRevision: snap.revision,
            confirmGlobal: true,
          });
          assert.equal(
            (await rpc({ type: 'get_state' })).thinkingLevel,
            native.clampThinkingLevel(model, 'medium'),
            'clear override uses native global default, not previous per-model runtime'
          );
          assert.equal(
            snap.rows.find((r: any) => r.key === row.key).effective,
            native.clampThinkingLevel(model, 'medium')
          );
          snap = await rpc({
            type: 'save_preference',
            key: 'retry',
            value: false,
            expectedRevision: snap.revision,
            confirmGlobal: true,
          });
          await rpc({ type: 'set_model', provider: 'fixture-alpha', modelId: model.id });
          assert.equal(
            (await rpc({ type: 'get_state' })).thinkingLevel,
            native.clampThinkingLevel(model, 'medium'),
            'unrelated native save must not resurrect cleared model default'
          );
        }
      });
    }
  );
}
