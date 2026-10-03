import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { createNativeFixture, spawnNativeSdkHost } from '../helpers/nativeFixture';

for (const mode of ['shared', 'dedicated'] as const) {
  test(
    `settings ${mode} actual startup parse error remains blocked after owned repair`,
    { timeout: 30000 },
    async () => {
      const f = await createNativeFixture('scopes');
      let child: Awaited<ReturnType<typeof spawnNativeSdkHost>>['child'] | undefined;
      try {
        const valid = await readFile(f.globalSettings, 'utf8');
        await writeFile(f.globalSettings, '{broken-owned');
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
          return p;
        };
        assert.equal((await rpc(started.open)).success, true);
        for (const repair of [false, true]) {
          if (repair) await writeFile(f.globalSettings, valid);
          const bytes = await readFile(f.globalSettings, 'utf8');
          const snapshot = await rpc({ type: 'get_preferences' });
          assert.equal(snapshot.success, false);
          assert.equal(snapshot.error, 'PREFERENCES_READ_FAILED');
          const save = await rpc({
            type: 'save_preference',
            key: 'retry',
            value: true,
            expectedRevision: 'a'.repeat(64),
            confirmGlobal: true,
          });
          assert.equal(save.success, false);
          assert.equal(save.error, 'PREFERENCES_READ_FAILED');
          assert.equal(await readFile(f.globalSettings, 'utf8'), bytes);
          assert.equal((await rpc({ type: 'get_state' })).success, true);
        }
        assert.equal(f.requests, 0);
        assert.equal(await readFile(f.networkLog, 'utf8'), '');
      } finally {
        child?.stdin?.end();
        child?.kill();
        if (child && child.exitCode === null) await new Promise((r) => child!.once('exit', r));
        await f.dispose();
      }
    }
  );
}
