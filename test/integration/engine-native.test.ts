import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createNativeFixture, spawnNativeSdkHost } from '../helpers/nativeFixture';
import { spawnRealPi, shutdown } from '../helpers/rpc';

test(
  'actual stock exposes tree but rejects GUI mutation capability without any native effects',
  { timeout: 15000 },
  async () => {
    const fixture = await createNativeFixture('scopes');
    const stock = await spawnRealPi([], fixture);
    try {
      const before = await stock.client.getState();
      const tree = await stock.client.getTree();
      assert.ok(Array.isArray(tree?.tree));
      for (const command of ['navigate_tree', 'set_project_trust', 'reload_session'] as const)
        await assert.rejects(
          stock.client.engineCommand(command, { sessionId: before?.sessionId }),
          /Unknown command|unsupported|support/i
        );
      assert.deepEqual(await stock.client.getState(), before);
      assert.equal(fixture.requests, 0);
    } finally {
      await shutdown(stock);
    }
  }
);

for (const mode of ['shared', 'dedicated'] as const) {
  test(
    `engine actual ${mode}: tree before/after, trust future-only, reload attestation`,
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
          let index;
          while ((index = buffer.indexOf('\n')) >= 0) {
            const { k, d } = JSON.parse(buffer.slice(0, index));
            buffer = buffer.slice(index + 1);
            if (d.type === 'response') {
              pending.get(`${k}:${d.id ?? 'open'}`)?.(d);
              pending.delete(`${k}:${d.id ?? 'open'}`);
            }
          }
        });
        const request = async (command: any, key = 'one') => {
          const id = command.type === 'open' ? undefined : String(++sequence);
          const reply = new Promise<any>((resolve) =>
            pending.set(`${key}:${id ?? 'open'}`, resolve)
          );
          host!.child.stdin!.write(JSON.stringify({ k: key, d: { ...command, id } }) + '\n');
          const result = await reply;
          if (!result.success) throw new Error(result.error);
          return result.data;
        };
        await request(host.open);
        const caps = await request({ type: 'get_capabilities' });
        assert.equal(caps.engineCommands.reload_session, mode === 'dedicated');
        if (mode === 'shared') await request(host.open, 'other');
        else await assert.rejects(request(host.open, 'other'), /DEDICATED_SINGLE_SESSION/);
        const other = mode === 'shared' ? await request({ type: 'get_state' }, 'other') : undefined;
        const timestamp = '2024-01-01T00:00:00.000Z';
        const path = join(fixture.cwd, 'owned-engine.jsonl');
        const entry = (id: string, parentId: string | null, type: string, extra: any) => ({
          type,
          id,
          parentId,
          timestamp,
          ...extra,
        });
        const bytes =
          [
            { type: 'session', version: 3, id: 'owned-engine', timestamp, cwd: fixture.cwd },
            entry('model', null, 'model_change', { provider: 'fixture-alpha', modelId: 'ping' }),
            entry('first', 'model', 'message', {
              message: { role: 'user', content: 'first question', timestamp: 1 },
            }),
            entry('abandoned', 'first', 'message', {
              message: { role: 'user', content: 'abandoned', timestamp: 2 },
            }),
            entry('second', 'first', 'message', {
              message: { role: 'user', content: 'second question', timestamp: 3 },
            }),
          ]
            .map((e) => JSON.stringify(e))
            .join('\n') + '\n';
        await writeFile(path, bytes);
        await request({ type: 'switch_session', sessionPath: path });
        const state = await request({ type: 'get_state' });
        const loadedBytes = await readFile(path, 'utf8');
        const origin = async () => ({
          sessionId: state.sessionId,
          sessionFile: state.sessionFile,
          leafId: (await request({ type: 'get_entries' })).leafId,
        });
        const command = async (type: string, payload = {}) =>
          request({ type, guiLifecycle: true, origin: await origin(), ...payload });
        const tree = await request({ type: 'get_tree' });
        assert.equal(tree.leafId, (await request({ type: 'get_entries' })).leafId);
        assert.equal(tree.tree[0].entry.id, 'model');
        const stale = await origin();
        const moved = await command('navigate_tree', { targetId: 'first', summarize: false });
        assert.equal(moved.editorText, 'first question');
        assert.equal(moved.cancelled, false);
        assert.equal((await request({ type: 'get_entries' })).leafId, 'model');
        assert.deepEqual((await request({ type: 'get_messages' })).messages, []);
        await assert.rejects(
          request({ type: 'navigate_tree', origin: stale, guiLifecycle: true, targetId: 'second' }),
          /STALE_ORIGIN/
        );
        await assert.rejects(
          command('navigate_tree', { targetId: 'second', summarize: true }),
          /SUMMARY_NOT_AUTHORIZED/
        );
        await command('navigate_tree', { targetId: 'model', summarize: false });
        const trust = await command('get_project_trust');
        assert.equal(
          (await command('set_project_trust', { decision: true })).futureProcessesOnly,
          true
        );
        assert.equal((await command('get_project_trust')).decision, true);
        assert.equal((await command('get_project_trust')).loaded, trust.loaded);
        const stored = JSON.parse(await readFile(join(fixture.agentDir, 'trust.json'), 'utf8'));
        assert.equal(stored[fixture.cwd], true);
        await command('set_project_trust', { decision: null });
        assert.equal((await command('get_project_trust')).decision, null);
        const entries = await request({ type: 'get_entries' });
        if (mode === 'shared')
          await assert.rejects(command('reload_session'), /DEDICATED_OS_PROCESS/);
        else {
          assert.equal((await command('reload_session')).reloaded, true);
          assert.deepEqual(await request({ type: 'get_entries' }), entries);
          const after = await request({ type: 'get_state' });
          assert.equal(after.sessionId, state.sessionId);
          assert.equal(after.sessionFile, path);
        }
        assert.equal(await readFile(path, 'utf8'), loadedBytes);
        if (mode === 'shared')
          assert.deepEqual(await request({ type: 'get_state' }, 'other'), other);
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
