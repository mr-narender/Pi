import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createNativeFixture, spawnNativeSdkHost } from '../helpers/nativeFixture';
import { spawnRealPi, shutdown } from '../helpers/rpc';

for (const mode of ['stock', 'shared', 'dedicated'] as const) {
  test(
    `export native ${mode}: full HTML tree and public JSONL branch preserve content`,
    { timeout: 30000 },
    async () => {
      const fixture = await createNativeFixture('scopes');
      let stock: Awaited<ReturnType<typeof spawnRealPi>> | undefined;
      let host: Awaited<ReturnType<typeof spawnNativeSdkHost>> | undefined;
      try {
        let rpc: (command: any) => Promise<any>;
        if (mode === 'stock') {
          stock = await spawnRealPi([], fixture);
          rpc = async (command) =>
            command.type === 'switch_session'
              ? stock!.client.switchSession(command.sessionPath)
              : stock!.client.exportHtml(command.outputPath);
        } else {
          host = await spawnNativeSdkHost(fixture, mode);
          let buffer = '';
          let seq = 0;
          const pending = new Map<string, (r: any) => void>();
          host.child.stdout!.on('data', (chunk) => {
            buffer += chunk;
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
          const request = (command: any): Promise<any> => {
            const id = command.type === 'open' ? undefined : String(++seq);
            const result = new Promise((resolve) => pending.set(id ?? 'open', resolve));
            host!.child.stdin!.write(JSON.stringify({ k: 'one', d: { ...command, id } }) + '\n');
            return result;
          };
          assert.equal((await request(host.open)).success, true);
          rpc = async (command) => {
            const r = await request(command);
            assert.equal(r.success, true, r.error);
            return r.data;
          };
        }
        const timestamp = '2024-01-01T00:00:00.000Z';
        const entry = (type: string, id: string, parentId: string | null, extra: object) => ({
          type,
          id,
          parentId,
          timestamp,
          ...extra,
        });
        const entries = [
          { type: 'session', version: 3, id: 'owned-export', timestamp, cwd: fixture.cwd },
          entry('message', 'root', null, {
            message: { role: 'user', content: 'PRIVATE OWNED QUESTION', timestamp: 1 },
          }),
          entry('message', 'abandoned', 'root', {
            message: { role: 'user', content: 'ABANDONED OWNED CONTENT', timestamp: 2 },
          }),
          entry('message', 'active', 'root', {
            message: {
              role: 'toolResult',
              toolCallId: 'call',
              toolName: 'read',
              content: [{ type: 'text', text: 'PRIVATE OWNED TOOL CONTENT' }],
              details: { opaque: 'preserved' },
              isError: false,
              timestamp: 3,
            },
          }),
          entry('custom', 'custom', 'active', {
            customType: 'owned-state',
            data: { opaque: 'PRIVATE OWNED CUSTOM' },
          }),
          entry('usage', 'usage', 'custom', {
            kind: 'owned-kind',
            provider: 'fixture-alpha',
            model: 'ping',
            usage: {
              input: 1,
              output: 2,
              cacheRead: 3,
              cacheWrite: 4,
              totalTokens: 10,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
          }),
          entry('session_info', 'name', 'usage', { name: 'Owned export name' }),
        ];
        const input = join(fixture.cwd, 'owned-session.jsonl');
        await writeFile(input, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
        await rpc({ type: 'switch_session', sessionPath: input });
        const before = await readFile(input, 'utf8');
        const html = join(fixture.cwd, 'owned.html');
        assert.equal((await rpc({ type: 'export_html', outputPath: html })).path, html);
        const text = await readFile(html, 'utf8');
        const encoded = /id="session-data"[^>]*>([A-Za-z0-9+/=]+)</.exec(text);
        assert.ok(encoded, 'native HTML contains encoded session tree');
        const data = JSON.parse(Buffer.from(encoded[1]!, 'base64').toString());
        for (const e of entries.slice(1))
          assert.deepEqual(
            data.entries.find((x: any) => x.id === e.id),
            e
          );
        if (mode !== 'stock') {
          const output = join(fixture.cwd, 'owned.jsonl');
          assert.equal((await rpc({ type: 'export_jsonl', outputPath: output })).path, output);
          const branch = (await readFile(output, 'utf8'))
            .trim()
            .split('\n')
            .map((s) => JSON.parse(s));
          assert.equal(branch[0].type, 'session');
          assert.equal(branch[0].id, 'owned-export');
          assert.equal(branch[0].cwd, fixture.cwd);
          assert.ok(!branch.some((e) => e.id === 'abandoned'));
          for (const e of entries.slice(1).filter((e) => e.id !== 'abandoned'))
            assert.deepEqual(
              branch.find((x) => x.id === e.id),
              e
            );
        }
        assert.equal(await readFile(input, 'utf8'), before);
        assert.equal(fixture.requests, 0);
        assert.equal(await readFile(fixture.networkLog, 'utf8'), '');
      } finally {
        if (stock) await shutdown(stock);
        if (host && host.child.exitCode === null && host.child.signalCode === null) {
          host.child.kill('SIGKILL');
          await new Promise((r) => host!.child.once('exit', r));
        }
        if (!stock) await fixture.dispose();
      }
    }
  );
}
