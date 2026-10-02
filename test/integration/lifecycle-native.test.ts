import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createNativeFixture, spawnNativeSdkHost } from '../helpers/nativeFixture';
import { spawnRealPi, shutdown } from '../helpers/rpc';

for (const mode of ['stock', 'shared', 'dedicated'] as const) {
  test(
    `lifecycle actual ${mode}: native new/resume/fork/clone, original file and other chat retained`,
    { timeout: 20000 },
    async () => {
      const fixture = await createNativeFixture('scopes');
      let host: Awaited<ReturnType<typeof spawnNativeSdkHost>> | undefined;
      let stock: Awaited<ReturnType<typeof spawnRealPi>> | undefined;
      try {
        let rpc: (command: any, key?: string) => Promise<any>;
        if (mode === 'stock') {
          stock = await spawnRealPi([], fixture);
          rpc = (command) =>
            (stock!.client as any)[
              {
                switch_session: 'switchSession',
                new_session: 'newSession',
                get_state: 'getState',
                get_entries: 'getEntries',
                get_messages: 'getMessages',
                fork: 'fork',
                clone: 'clone',
              }[command.type as string]!
            ](command.sessionPath ?? command.entryId);
        } else {
          host = await spawnNativeSdkHost(fixture, mode);
          let buffer = '';
          let sequence = 0;
          const pending = new Map<string, (reply: any) => void>();
          host.child.stdout!.on('data', (chunk) => {
            buffer += chunk;
            let i;
            while ((i = buffer.indexOf('\n')) >= 0) {
              const { k, d } = JSON.parse(buffer.slice(0, i));
              buffer = buffer.slice(i + 1);
              if (d.type === 'response') {
                pending.get(`${k}:${d.id ?? 'open'}`)?.(d);
                pending.delete(`${k}:${d.id ?? 'open'}`);
              }
            }
          });
          const request = async (command: any, key = 'one'): Promise<any> => {
            const id = command.type === 'open' ? undefined : String(++sequence);
            const reply = new Promise<any>((resolve) =>
              pending.set(`${key}:${id ?? 'open'}`, resolve)
            );
            host!.child.stdin!.write(JSON.stringify({ k: key, d: { ...command, id } }) + '\n');
            const result = await reply;
            if (!result.success) throw new Error(result.error);
            return result.data;
          };
          rpc = async (command, key = 'one') => {
            if (
              ['switch_session', 'fork', 'clone', 'new_session', 'close_chat'].includes(
                command.type
              )
            ) {
              const state = await request({ type: 'get_state' }, key);
              const entries = await request({ type: 'get_entries' }, key);
              command = {
                ...command,
                guiLifecycle: true,
                origin: {
                  sessionId: state.sessionId,
                  sessionFile: state.sessionFile,
                  leafId: entries.leafId,
                },
              };
            }
            return request(command, key);
          };
          await rpc(host.open);
          await rpc(host.open, 'other');
        }
        const timestamp = '2024-01-01T00:00:00.000Z';
        const path = join(fixture.cwd, 'owned-lifecycle.jsonl');
        const entry = (id: string, parentId: string | null, role: string, content: any) => ({
          type: 'message',
          id,
          parentId,
          timestamp,
          message: { role, content, timestamp: 1 },
        });
        await writeFile(
          path,
          [
            { type: 'session', version: 3, id: 'owned-lifecycle', timestamp, cwd: fixture.cwd },
            {
              type: 'model_change',
              id: 'model',
              parentId: null,
              timestamp,
              provider: 'fixture-alpha',
              modelId: 'ping',
            },
            entry('first', 'model', 'user', 'first question'),
            entry('abandoned', 'first', 'user', 'abandoned branch'),
            entry('second', 'first', 'user', 'second question'),
          ]
            .map((e) => JSON.stringify(e))
            .join('\n') + '\n'
        );
        await rpc({ type: 'switch_session', sessionPath: path });
        const original = await readFile(path, 'utf8');
        const other = mode === 'stock' ? undefined : await rpc({ type: 'get_state' }, 'other');
        const loaded = await rpc({ type: 'get_state' });
        assert.equal(loaded.sessionId, 'owned-lifecycle');
        assert.equal((await rpc({ type: 'clone' })).cancelled, false);
        const cloned = await rpc({ type: 'get_state' });
        assert.notEqual(cloned.sessionId, loaded.sessionId);
        assert.notEqual(cloned.sessionFile, path);
        const cloneEntries = await rpc({ type: 'get_entries' });
        assert.ok(cloneEntries.entries.some((e: any) => e.id === 'second'));
        assert.ok(!cloneEntries.entries.some((e: any) => e.id === 'abandoned'));
        assert.equal(await readFile(path, 'utf8'), original);
        const fork = await rpc({ type: 'fork', entryId: 'second' });
        assert.equal(fork.cancelled, false);
        assert.equal(fork.text, 'second question');
        const forked = await rpc({ type: 'get_state' });
        assert.notEqual(forked.sessionId, cloned.sessionId);
        assert.ok(
          !(await rpc({ type: 'get_entries' })).entries.some((e: any) => e.id === 'second')
        );
        assert.equal((await rpc({ type: 'new_session' })).cancelled, false);
        assert.notEqual((await rpc({ type: 'get_state' })).sessionId, forked.sessionId);
        assert.equal((await rpc({ type: 'get_messages' })).messages.length, 0);
        await rpc({ type: 'switch_session', sessionPath: path });
        assert.equal((await rpc({ type: 'get_state' })).sessionId, loaded.sessionId);
        if (mode !== 'stock') {
          assert.deepEqual(await rpc({ type: 'get_state' }, 'other'), other);
          assert.equal((await rpc({ type: 'close_chat' })).closed, true);
          assert.deepEqual(
            await rpc({ type: 'get_state' }, 'other'),
            other,
            'quit never ends shared host/other session'
          );
        }
        assert.equal(await readFile(path, 'utf8'), original);
        assert.equal(fixture.requests, 0);
        assert.equal(await readFile(fixture.networkLog, 'utf8'), '');
      } finally {
        if (stock) await shutdown(stock);
        if (host && host.child.exitCode === null && host.child.signalCode === null) {
          const exit = new Promise((resolve) => host!.child.once('exit', resolve));
          host.child.kill('SIGKILL');
          await exit;
        }
        if (!stock) await fixture.dispose();
      }
    }
  );
}
