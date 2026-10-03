import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createNativeFixture, spawnNativeSdkHost } from '../helpers/nativeFixture';

for (const mode of ['shared', 'dedicated'] as const) {
  test(
    `actual native ${mode}: lifecycle veto/stale/busy retain session file, leaf and queues`,
    { timeout: 15000 },
    async () => {
      const fixture = await createNativeFixture('lifecycle-veto');
      let host: Awaited<ReturnType<typeof spawnNativeSdkHost>> | undefined;
      try {
        const path = join(fixture.cwd, 'owned-veto.jsonl');
        const timestamp = '2024-01-01T00:00:00.000Z';
        await writeFile(
          path,
          [
            { type: 'session', version: 3, id: 'owned-veto', timestamp, cwd: fixture.cwd },
            {
              type: 'message',
              id: 'user',
              parentId: null,
              timestamp,
              message: { role: 'user', content: 'owned history', timestamp: 1 },
            },
          ]
            .map((e) => JSON.stringify(e))
            .join('\n') + '\n'
        );
        host = await spawnNativeSdkHost(fixture, mode);
        let buffer = '';
        let sequence = 0;
        const pending = new Map<string, (reply: any) => void>();
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
        const rpc = async (command: any, key = 'one') => {
          const id = command.type === 'open' ? undefined : String(++sequence);
          const response = new Promise<any>((resolve) => pending.set(id ?? 'open', resolve));
          host!.child.stdin!.write(JSON.stringify({ k: key, d: { ...command, id } }) + '\n');
          return response;
        };
        assert.equal((await rpc({ ...host.open, sessionFile: path })).success, true);
        const state = (await rpc({ type: 'get_state' })).data;
        const entries = (await rpc({ type: 'get_entries' })).data;
        const original = await readFile(path, 'utf8');
        const origin = {
          sessionId: state.sessionId,
          sessionFile: state.sessionFile,
          leafId: entries.leafId,
        };
        for (const type of ['new_session', 'switch_session', 'fork', 'clone']) {
          const response = await rpc({
            type,
            guiLifecycle: true,
            origin,
            sessionPath: path,
            entryId: 'user',
          });
          assert.equal(response.success, true, response.error);
          assert.equal(response.data.cancelled, true);
          assert.deepEqual((await rpc({ type: 'get_state' })).data, state);
          assert.deepEqual((await rpc({ type: 'get_entries' })).data, entries);
          assert.equal(await readFile(path, 'utf8'), original);
        }
        assert.equal(
          (
            await rpc({
              type: 'new_session',
              guiLifecycle: true,
              origin: { ...origin, leafId: 'stale' },
            })
          ).success,
          false
        );
        await rpc({ type: 'follow_up', message: 'owned queued message' });
        assert.equal((await rpc({ type: 'get_state' })).data.pendingMessageCount, 1);
        for (const type of ['new_session', 'fork', 'clone', 'switch_session', 'close_chat']) {
          assert.equal(
            (await rpc({ type, guiLifecycle: true, origin, sessionPath: path, entryId: 'user' }))
              .success,
            false
          );
          assert.equal((await rpc({ type: 'get_state' })).data.pendingMessageCount, 1);
        }
        assert.equal(await readFile(path, 'utf8'), original);
        assert.equal((await rpc(host.open, 'two')).success, true);
        assert.equal(
          (await rpc({ type: 'close_chat' }, 'two')).success,
          false,
          'native shutdown handler failure must never acknowledge close'
        );
        assert.equal(
          (await rpc({ type: 'get_state' })).data.pendingMessageCount,
          1,
          'other chat queue survives failed close'
        );
        assert.equal(fixture.requests, 0);
        assert.equal(await readFile(fixture.networkLog, 'utf8'), '');
      } finally {
        if (host && host.child.exitCode === null && host.child.signalCode === null) {
          const exit = new Promise((resolve) => host!.child.once('exit', resolve));
          host.child.kill('SIGKILL');
          await exit;
        }
        await fixture.dispose();
      }
    }
  );
}
