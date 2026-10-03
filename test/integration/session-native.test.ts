import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createNativeFixture, spawnNativeSdkHost } from '../helpers/nativeFixture';
import { spawnRealPi, shutdown } from '../helpers/rpc';
import { projectSessionInfo } from '../../src/sessions/sessionInfo';

for (const mode of ['stock', 'shared', 'dedicated'] as const) {
  test(
    `session native ${mode}: abandoned branches, compaction/tool/usage billing and unknown context`,
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
            if (command.type === 'get_session_stats') return stock!.client.getSessionStats();
            if (command.type === 'get_entries') return stock!.client.getEntries();
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
            assert.equal(reply.success, true, reply.error);
            return reply.data;
          };
        }
        const path = join(fixture.cwd, 'session-owned.jsonl');
        const timestamp = '2024-01-01T00:00:00.000Z';
        const usage = {
          input: 10,
          output: 2,
          cacheRead: 3,
          cacheWrite: 4,
          totalTokens: 19,
          cost: { input: 0.01, output: 0.02, cacheRead: 0.03, cacheWrite: 0.04, total: 0.1 },
        };
        const entry = (type: string, id: string, parentId: string | null, extra: object) => ({
          type,
          id,
          parentId,
          timestamp,
          ...extra,
        });
        const assistant = {
          role: 'assistant',
          content: [
            { type: 'text', text: 'owned answer' },
            { type: 'toolCall', id: 'call', name: 'read', arguments: {} },
          ],
          api: 'openai-completions',
          provider: 'fixture-alpha',
          model: 'ping',
          usage,
          stopReason: 'stop',
          timestamp: 1,
        };
        const entries = [
          { type: 'session', version: 3, id: 'owned-session', timestamp, cwd: fixture.cwd },
          entry('model_change', 'model', null, { provider: 'fixture-alpha', modelId: 'ping' }),
          entry('message', 'user', 'model', {
            message: { role: 'user', content: 'owned question', timestamp: 1 },
          }),
          entry('message', 'abandoned', 'user', { message: assistant }),
          entry('message', 'tool', 'abandoned', {
            message: {
              role: 'toolResult',
              toolCallId: 'call',
              toolName: 'read',
              content: [{ type: 'text', text: 'owned result' }],
              isError: false,
              timestamp: 1,
              usage,
            },
          }),
          entry('branch_summary', 'branch', 'user', {
            fromId: 'tool',
            summary: 'owned branch',
            usage,
          }),
          entry('message', 'active', 'branch', { message: assistant }),
          entry('usage', 'usage', 'active', {
            kind: 'cache_warm',
            provider: 'fixture-alpha',
            model: 'ping',
            usage,
          }),
          entry('compaction', 'compact', 'usage', {
            summary: 'owned summary',
            firstKeptEntryId: 'compact',
            tokensBefore: 500,
            usage,
          }),
          entry('session_info', 'name', 'compact', { name: 'Owned stats name' }),
        ];
        const original = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
        await writeFile(path, original);
        await rpc({ type: 'switch_session', sessionPath: path });
        const afterSwitch = await readFile(path, 'utf8');
        const stats = await rpc({ type: 'get_session_stats' });
        const state = await rpc({ type: 'get_state' });
        const all = await rpc({ type: 'get_entries' });
        assert.equal(stats.totalMessages, 4);
        assert.equal(stats.userMessages, 1);
        assert.equal(stats.assistantMessages, 2, 'abandoned assistant is billed too');
        assert.equal(stats.toolCalls, 2);
        assert.equal(stats.toolResults, 1);
        assert.deepEqual(stats.tokens, {
          input: 60,
          output: 12,
          cacheRead: 18,
          cacheWrite: 24,
          total: 114,
        });
        assert.ok(Math.abs(stats.cost - 0.6) < 0.00001);
        assert.deepEqual(stats.contextUsage, { tokens: null, contextWindow: 8192, percent: null });
        assert.equal(all.entries.length, afterSwitch.trim().split('\n').length - 1);
        assert.ok(all.entries.some((e: any) => e.id === 'abandoned'));
        const info = projectSessionInfo({ ...stats, totalEntries: all.entries.length }, state);
        assert.equal(info.sessionName, 'Owned stats name');
        assert.equal(info.sessionFile, path);
        assert.equal(info.sessionId, 'owned-session');
        assert.equal((info.contextUsage as any).tokens, null);
        assert.equal(
          await readFile(path, 'utf8'),
          afterSwitch,
          'read-only operations cannot rewrite session'
        );
        // Without a compaction, public API usage is known; all-branch totals stay native.
        const knownPath = join(fixture.cwd, 'known-session.jsonl');
        await writeFile(
          knownPath,
          entries
            .slice(0, 8)
            .map((e) => JSON.stringify(e))
            .join('\n') + '\n'
        );
        await rpc({ type: 'switch_session', sessionPath: knownPath });
        const known = await rpc({ type: 'get_session_stats' });
        assert.equal(typeof known.contextUsage.tokens, 'number');
        assert.ok(known.contextUsage.tokens > 0);
        assert.equal(known.assistantMessages, 2);
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
