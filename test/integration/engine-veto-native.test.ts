import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createNativeFixture, spawnNativeSdkHost } from '../helpers/nativeFixture';

test(
  'actual owned native tree veto and reload shutdown failure: no false ACK or recovery replay',
  { timeout: 20000 },
  async () => {
    const fixture = await createNativeFixture('lifecycle-veto');
    let host: Awaited<ReturnType<typeof spawnNativeSdkHost>> | undefined;
    try {
      host = await spawnNativeSdkHost(fixture, 'dedicated', 'engine');
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
      const request = async (command: any) => {
        const id = command.type === 'open' ? undefined : String(++sequence);
        const reply = new Promise<any>((resolve) => pending.set(id ?? 'open', resolve));
        host!.child.stdin!.write(JSON.stringify({ k: 'one', d: { ...command, id } }) + '\n');
        const result = await reply;
        if (!result.success) throw new Error(result.error);
        return result.data;
      };
      await request(host.open);
      await request({ type: 'set_session_name', name: 'first' });
      await request({ type: 'set_session_name', name: 'second' });
      const state = await request({ type: 'get_state' });
      const entries = await request({ type: 'get_entries' });
      const target = entries.entries.find((entry: any) => entry.id !== entries.leafId);
      assert.ok(target);
      const origin = {
        sessionId: state.sessionId,
        sessionFile: state.sessionFile,
        leafId: entries.leafId,
      };
      assert.equal(
        (
          await request({
            type: 'navigate_tree',
            guiLifecycle: true,
            origin,
            targetId: target.id,
            summarize: false,
          })
        ).cancelled,
        true
      );
      assert.deepEqual(await request({ type: 'get_entries' }), entries);
      await assert.rejects(
        request({ type: 'reload_session', guiLifecycle: true, origin }),
        /RECOVERY_REQUIRED_AFTER_RELOAD/
      );
      const fault = await request({ type: 'get_state' });
      assert.equal(fault.recoveryRequired, true);
      assert.equal(fault.isIdle, false);
      assert.equal(fault.sessionId, state.sessionId);
      await assert.rejects(
        request({ type: 'prompt', message: 'never replay' }),
        /RECOVERY_REQUIRED/
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
