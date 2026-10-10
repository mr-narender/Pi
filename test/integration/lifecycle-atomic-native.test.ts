import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createNativeFixture, spawnNativeSdkHost } from '../helpers/nativeFixture';

for (const mode of ['shared', 'dedicated'] as const)
  test(
    `native ${mode} atomic lifecycle response binds state, leaf, entries, active messages and origin`,
    { timeout: 20000 },
    async () => {
      const fixture = await createNativeFixture('scopes');
      let host: Awaited<ReturnType<typeof spawnNativeSdkHost>> | undefined;
      try {
        host = await spawnNativeSdkHost(fixture, mode, 'engine');
        let buffer = '';
        let sequence = 0;
        const pending = new Map<string, (reply: any) => void>();
        host.child.stdout!.on('data', (chunk) => {
          buffer += chunk;
          let end;
          while ((end = buffer.indexOf('\n')) >= 0) {
            const { d } = JSON.parse(buffer.slice(0, end));
            buffer = buffer.slice(end + 1);
            if (d.type === 'response') {
              const key = d.id ?? 'open';
              pending.get(key)?.(d);
              pending.delete(key);
            }
          }
        });
        const rpc = async (command: any) => {
          const id = command.type === 'open' ? undefined : String(++sequence);
          const result = new Promise<any>((resolve) => pending.set(id ?? 'open', resolve));
          host!.child.stdin!.write(JSON.stringify({ k: 'one', d: { ...command, id } }) + '\n');
          const reply = await result;
          assert.equal(reply.success, true, reply.error);
          return reply.data;
        };
        await rpc(host.open);
        assert.equal((await rpc({ type: 'get_capabilities' })).lifecycleProjection, 1);
        const timestamp = '2024-01-01T00:00:00.000Z';
        const file = join(fixture.cwd, 'atomic.jsonl');
        const entry = (id: string, parentId: string | null, content: string) => ({
          type: 'message',
          id,
          parentId,
          timestamp,
          message: { role: 'user', content, timestamp: 1 },
        });
        await writeFile(
          file,
          [
            { type: 'session', version: 3, id: 'atomic-owned', timestamp, cwd: fixture.cwd },
            {
              type: 'model_change',
              id: 'model',
              parentId: null,
              timestamp,
              provider: 'fixture-alpha',
              modelId: 'ping',
            },
            entry('first', 'model', 'first'),
            entry('abandoned', 'first', 'unconfirmed abandoned branch'),
            entry('active', 'first', 'active'),
          ]
            .map((e) => JSON.stringify(e))
            .join('\n') + '\n'
        );
        const origin = async () => {
          const state = await rpc({ type: 'get_state' });
          assert.equal(typeof state.leafId, 'string', 'small state contract includes active leaf');
          return {
            sessionId: state.sessionId,
            sessionFile: state.sessionFile,
            leafId: state.leafId,
          };
        };
        const outgoing = await origin();
        const result = await rpc({
          type: 'switch_session',
          sessionPath: file,
          guiLifecycle: true,
          origin: outgoing,
        });
        const p = result.replacementProjection;
        assert.equal(p.contract, 1);
        assert.deepEqual(p.origin, JSON.parse(JSON.stringify(outgoing)));
        assert.deepEqual(p.identity, result.replacementIdentity);
        assert.equal(p.state.sessionId, 'atomic-owned');
        assert.equal(p.state.sessionFile, file);
        const actualEntries = await rpc({ type: 'get_entries' });
        assert.equal(p.identity.leafId, actualEntries.leafId);
        assert.ok(p.entries.some((e: any) => e.id === 'active'));
        assert.deepEqual(p.entries, actualEntries.entries);
        assert.deepEqual(p.messages, (await rpc({ type: 'get_messages' })).messages);
        assert.ok(p.entries.some((e: any) => e.id === 'abandoned'));
        assert.ok(!JSON.stringify(p.messages).includes('unconfirmed abandoned branch'));
        const bytes = JSON.stringify(p);
        // Branch ABA after completion cannot contaminate the already captured history.
        for (const targetId of ['abandoned', 'active'])
          await rpc({
            type: 'navigate_tree',
            targetId,
            summarize: false,
            guiLifecycle: true,
            origin: await origin(),
          });
        assert.equal(JSON.stringify(p), bytes);
        const fresh = await rpc({
          type: 'new_session',
          guiLifecycle: true,
          origin: await origin(),
        });
        assert.notEqual(fresh.replacementProjection.identity.sessionId, p.identity.sessionId);
        assert.equal(JSON.stringify(p), bytes);
        assert.equal(
          fresh.replacementProjection.identity.leafId,
          (await rpc({ type: 'get_entries' })).leafId
        );
        assert.deepEqual(fresh.replacementProjection.messages, []);
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
