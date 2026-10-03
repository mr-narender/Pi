import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { createNativeFixture, spawnNativeSdkHost } from '../helpers/nativeFixture';

for (const mode of ['shared', 'dedicated'] as const) {
  test(
    `export native ${mode}: capability, stale branch and owned write failure never mutate history`,
    { timeout: 30000 },
    async () => {
      const fixture = await createNativeFixture('scopes');
      let host: Awaited<ReturnType<typeof spawnNativeSdkHost>> | undefined;
      try {
        host = await spawnNativeSdkHost(fixture, mode);
        let buffer = '';
        let sequence = 0;
        const pending = new Map<string, (r: any) => void>();
        host.child.stdout!.on('data', (chunk) => {
          buffer += chunk;
          let index;
          while ((index = buffer.indexOf('\n')) >= 0) {
            const { d } = JSON.parse(buffer.slice(0, index));
            buffer = buffer.slice(index + 1);
            if (d.type === 'response') {
              pending.get(d.id ?? 'open')?.(d);
              pending.delete(d.id ?? 'open');
            }
          }
        });
        const request = (command: any): Promise<any> => {
          const id = command.type === 'open' ? undefined : String(++sequence);
          const response = new Promise((resolve) => pending.set(id ?? 'open', resolve));
          host!.child.stdin!.write(JSON.stringify({ k: 'one', d: { ...command, id } }) + '\n');
          return response;
        };
        assert.equal((await request(host.open)).success, true);
        const caps = (await request({ type: 'get_capabilities' })).data;
        assert.deepEqual(caps.exports, { html: true, jsonl: true });
        const input = join(fixture.cwd, 'history.jsonl');
        const timestamp = '2024-01-01T00:00:00.000Z';
        const history =
          [
            { type: 'session', version: 3, id: 'export-safety', timestamp, cwd: fixture.cwd },
            {
              type: 'message',
              id: 'leaf',
              parentId: null,
              timestamp,
              message: { role: 'user', content: 'OWNED PRIVATE HISTORY', timestamp: 1 },
            },
          ]
            .map((e) => JSON.stringify(e))
            .join('\n') + '\n';
        await writeFile(input, history);
        assert.equal((await request({ type: 'switch_session', sessionPath: input })).success, true);
        const state = (await request({ type: 'get_state' })).data;
        const entries = (await request({ type: 'get_entries' })).data;
        const origin = {
          sessionId: state.sessionId,
          sessionFile: state.sessionFile,
          leafId: entries.leafId,
        };
        const before = await readFile(input, 'utf8');
        for (const type of ['export_html', 'export_jsonl']) {
          const accepted = await request({
            type,
            outputPath: join(fixture.cwd, `${type}-valid`),
            origin,
          });
          assert.equal(accepted.success, true, accepted.error);
          const output = join(fixture.cwd, `${type}-stale`);
          const rejected = await request({
            type,
            outputPath: output,
            origin: { ...origin, leafId: 'replaced' },
          });
          assert.equal(rejected.success, false);
          assert.equal(rejected.error, 'SDK_OPERATION_FAILED');
          await assert.rejects(access(output));
          const failed = await request({ type, outputPath: fixture.cwd, origin });
          assert.equal(
            failed.success,
            false,
            'owned directory destination must fail in native API'
          );
          assert.equal(failed.error, 'SDK_OPERATION_FAILED');
        }
        assert.equal(await readFile(input, 'utf8'), before);
        assert.equal(fixture.requests, 0);
        assert.equal(await readFile(fixture.networkLog, 'utf8'), '');
      } finally {
        if (host && host.child.exitCode === null && host.child.signalCode === null) {
          host.child.kill('SIGKILL');
          await new Promise((resolve) => host!.child.once('exit', resolve));
        }
        await fixture.dispose();
      }
    }
  );
}
