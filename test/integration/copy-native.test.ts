import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createNativeFixture, spawnNativeSdkHost } from '../helpers/nativeFixture';
import { spawnRealPi, shutdown } from '../helpers/rpc';

for (const mode of ['stock', 'shared', 'dedicated'] as const) {
  test(
    `copy native ${mode}: newest text only, no fallback, no assistant and zero provider requests`,
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
            return stock!.client.getLastAssistantText();
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
        const usage = {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        };
        const assistant = (content: any[]) => ({
          role: 'assistant',
          content,
          provider: 'fixture-alpha',
          model: 'ping',
          api: 'openai-completions',
          usage,
          stopReason: 'stop',
          timestamp: 1,
        });
        const old = assistant([{ type: 'text', text: 'older must not be copied' }]);
        const toolOnly = assistant([
          { type: 'thinking', thinking: 'PRIVATE_REASONING' },
          { type: 'toolCall', id: 'call', name: 'read', arguments: { path: 'PRIVATE_TOOL' } },
        ]);
        const latest = assistant([
          { type: 'thinking', thinking: 'PRIVATE_REASONING' },
          { type: 'text', text: '  new' },
          { type: 'text', text: ' text  ' },
          { type: 'toolCall', id: 'call', name: 'read', arguments: {} },
        ]);
        const cases = [
          [[], null],
          [[old, latest], 'new text'],
          [[old, toolOnly], null],
        ] as const;
        for (let c = 0; c < cases.length; c++) {
          const [messages, expected] = cases[c]!;
          const path = join(fixture.cwd, `copy-${c}.jsonl`);
          const timestamp = '2024-01-01T00:00:00.000Z';
          const entries: any[] = [
            { type: 'session', version: 3, id: `owned-copy-${c}`, timestamp, cwd: fixture.cwd },
          ];
          messages.forEach((message, i) =>
            entries.push({
              type: 'message',
              id: `entry-${i}`,
              parentId: i ? `entry-${i - 1}` : null,
              timestamp,
              message,
            })
          );
          await writeFile(path, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
          await rpc({ type: 'switch_session', sessionPath: path });
          const reply = await rpc({ type: 'get_last_assistant_text' });
          // Native 0.99.1 serializes undefined no-text as an omitted property.
          // The existing controller intentionally normalizes that to null.
          const text = typeof reply?.text === 'string' ? reply.text : null;
          assert.equal(text, expected);
        }
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
