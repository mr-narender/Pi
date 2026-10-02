import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createNativeFixture, spawnNativeSdkHost } from '../helpers/nativeFixture';
import { spawnRealPi, shutdown } from '../helpers/rpc';

for (const mode of ['stock', 'shared', 'dedicated'] as const) {
  test(
    `name native ${mode}: metadata persistence, identity, validation and zero provider requests`,
    { timeout: 30000 },
    async () => {
      const fixture = await createNativeFixture('scopes');
      let stock: Awaited<ReturnType<typeof spawnRealPi>> | undefined;
      let host: Awaited<ReturnType<typeof spawnNativeSdkHost>> | undefined;
      try {
        let rpc: (command: any) => Promise<any>;
        if (mode === 'stock') {
          stock = await spawnRealPi([], fixture);
          rpc = async (command) => {
            if (command.type === 'switch_session')
              return stock!.client.switchSession(command.sessionPath);
            if (command.type === 'set_session_name')
              return stock!.client.setSessionName(command.name);
            return stock!.client.getState();
          };
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
            const reply = await request(command);
            if (!reply.success) throw new Error(reply.error);
            return reply.data;
          };
        }
        const path = join(fixture.cwd, 'name-owned.jsonl');
        const timestamp = '2024-01-01T00:00:00.000Z';
        const entries = [
          { type: 'session', version: 3, id: 'owned-name', timestamp, cwd: fixture.cwd },
          {
            type: 'message',
            id: 'user-one',
            parentId: null,
            timestamp,
            message: { role: 'user', content: 'Owned transcript', timestamp: 1 },
          },
        ];
        const original = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
        await writeFile(path, original);
        const defaults = await readFile(fixture.globalSettings, 'utf8');
        await rpc({ type: 'switch_session', sessionPath: path });
        const before = await rpc({ type: 'get_state' });
        for (const name of [' two  words ', '"quoted words"', 'two  words', 'line\nbreak']) {
          await rpc({ type: 'set_session_name', name });
          const state = await rpc({ type: 'get_state' });
          assert.equal(state.sessionName, name.replace(/[\r\n]+/g, ' ').trim());
          assert.equal(state.sessionId, before.sessionId);
          assert.equal(state.sessionFile, before.sessionFile);
          assert.deepEqual(state.model, before.model);
          assert.equal(state.thinkingLevel, before.thinkingLevel);
          assert.equal(state.pendingMessageCount, before.pendingMessageCount);
          const persisted = await readFile(path, 'utf8');
          assert.ok(persisted.startsWith(original));
          assert.equal(
            JSON.parse(persisted.trim().split('\n').at(-1)!).name,
            name.replace(/[\r\n]+/g, ' ').trim()
          );
        }
        const persisted = await readFile(path, 'utf8');
        await assert.rejects(rpc({ type: 'set_session_name', name: '   ' }), /empty/i);
        assert.equal(await readFile(path, 'utf8'), persisted);
        assert.equal(await readFile(fixture.globalSettings, 'utf8'), defaults);
        // Owned write error: turn the session-file path into a directory.
        const errorPath = join(fixture.cwd, 'name-error.jsonl');
        await writeFile(errorPath, original);
        await rpc({ type: 'switch_session', sessionPath: errorPath });
        const { unlink } = await import('node:fs/promises');
        await unlink(errorPath);
        await mkdir(errorPath);
        await assert.rejects(rpc({ type: 'set_session_name', name: 'must fail' }));
        assert.equal(fixture.requests, 0);
        assert.equal(await readFile(fixture.networkLog, 'utf8'), '');
      } finally {
        if (stock) await shutdown(stock);
        if (host && host.child.exitCode === null && host.child.signalCode === null) {
          host.child.kill('SIGKILL');
          await new Promise((resolve) => host!.child.once('exit', resolve));
        }
        if (!stock) await fixture.dispose();
      }
    }
  );
}
