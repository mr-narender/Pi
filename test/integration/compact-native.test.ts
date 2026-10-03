import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createNativeFixture, spawnNativeSdkHost } from '../helpers/nativeFixture';
import { spawnRealPi, shutdown } from '../helpers/rpc';

for (const profile of ['compact', 'compact-veto'] as const)
  for (const mode of ['stock', 'shared', 'dedicated'] as const)
    test(
      `compact native ${mode} ${profile}: real lifecycle/history and provider isolation`,
      { timeout: 45000 },
      async () => {
        const fixture = await createNativeFixture(profile);
        let stock: Awaited<ReturnType<typeof spawnRealPi>> | undefined;
        let host: Awaited<ReturnType<typeof spawnNativeSdkHost>> | undefined;
        try {
          const settings = JSON.parse(await readFile(fixture.globalSettings, 'utf8'));
          settings.compaction = { enabled: false, keepRecentTokens: 512, reserveTokens: 1024 };
          await writeFile(fixture.globalSettings, JSON.stringify(settings));
          const defaults = await readFile(fixture.globalSettings, 'utf8');
          const project = await readFile(fixture.projectSettings, 'utf8');
          const events: any[] = [];
          let rpc: (command: any) => Promise<any>;
          if (mode === 'stock') {
            stock = await spawnRealPi([], fixture);
            stock.transport.on('event', (e) => events.push(e));
            rpc = async (command) => {
              switch (command.type) {
                case 'switch_session':
                  return stock!.client.switchSession(command.sessionPath);
                case 'compact':
                  return stock!.client.compact(command.customInstructions);
                case 'abort':
                  return stock!.client.abort();
                case 'get_state':
                  return stock!.client.getState();
                case 'get_messages':
                  return stock!.client.getMessages();
                case 'get_entries':
                  return stock!.client.getEntries();
              }
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
                } else events.push(d);
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
              if (!r.success) throw new Error(r.error);
              return r.data;
            };
          }
          const timestamp = '2024-01-01T00:00:00.000Z';
          const usage = {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          };
          const load = async (suffix: string) => {
            const entries: any[] = [
              { type: 'session', version: 3, id: `owned-${suffix}`, timestamp, cwd: fixture.cwd },
            ];
            for (let i = 0; i < 16; i++)
              entries.push({
                type: 'message',
                id: `m${i}`,
                parentId: i ? `m${i - 1}` : null,
                timestamp,
                message:
                  i % 2
                    ? {
                        role: 'assistant',
                        content: [{ type: 'text', text: 'OWNED HISTORY '.repeat(300) }],
                        api: 'openai-completions',
                        provider: 'fixture-alpha',
                        model: 'ping',
                        usage,
                        stopReason: 'stop',
                        timestamp: i,
                      }
                    : { role: 'user', content: 'OWNED QUESTION '.repeat(300), timestamp: i },
              });
            const file = join(fixture.cwd, `${suffix}.jsonl`);
            await writeFile(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
            await rpc({ type: 'switch_session', sessionPath: file });
            return { file, entries };
          };
          assert.equal(fixture.requests, 0, 'no provider work before an intended summary');
          if (profile === 'compact-veto') {
            const { file } = await load('veto');
            const history = await readFile(file, 'utf8');
            const before = await rpc({ type: 'get_state' });
            const vetoOutcome = await rpc({
              type: 'compact',
              customInstructions: 'OWNED VETO INSTRUCTIONS',
            }).then(
              (result) => ({ result }),
              (error) => ({ error: String(error) })
            );
            assert.ok('error' in vetoOutcome, JSON.stringify({ vetoOutcome, events }));
            const after = await rpc({ type: 'get_state' });
            for (const key of ['sessionId', 'sessionFile', 'model', 'thinkingLevel'])
              assert.deepEqual(after[key], before[key]);
            assert.equal(after.isCompacting, false);
            assert.equal(await readFile(file, 'utf8'), history);
            assert.deepEqual(
              JSON.parse(
                (await readFile(join(fixture.cwd, 'compact-veto-trace.jsonl'), 'utf8')).trim()
              ),
              {
                type: 'session_before_compact',
                reason: 'manual',
                instructions: 'OWNED VETO INSTRUCTIONS',
                cancel: true,
              }
            );
            assert.ok(events.some((e) => e.type === 'compaction_start' && e.reason === 'manual'));
            assert.ok(events.some((e) => e.type === 'compaction_end' && e.aborted && !e.result));
            assert.equal(fixture.requests, 0);
            assert.deepEqual(fixture.summaryRequests, []);
            assert.equal(await readFile(fixture.globalSettings, 'utf8'), defaults);
            assert.equal(await readFile(fixture.projectSettings, 'utf8'), project);
            assert.equal(await readFile(fixture.networkLog, 'utf8'), '');
            return;
          }
          if (mode !== 'stock') {
            await load('queued');
            await rpc({ type: 'follow_up', message: 'OWNED QUEUED MESSAGE' });
            await assert.rejects(rpc({ type: 'compact' }));
            assert.equal(fixture.requests, 0);
            assert.equal(
              (await rpc({ type: 'get_state' })).pendingMessageCount,
              1,
              'guard must not discard queued work'
            );
          }
          for (const instructions of [undefined, 'KEEP WHOLE  REMAINDER'] as const) {
            const { file, entries } = await load(instructions ? 'args' : 'bare');
            const before = await rpc({ type: 'get_state' });
            const count: number = fixture.requests;
            const result = await rpc({ type: 'compact', customInstructions: instructions });
            assert.equal(
              result.summary,
              'OWNED COMPACTION SUMMARY\n\n---\n\n**Turn Context (split turn):**\n\nOWNED COMPACTION SUMMARY'
            );
            assert.equal(typeof result.tokensBefore, 'number');
            assert.equal(typeof result.firstKeptEntryId, 'string');
            assert.equal(fixture.requests, count + 2);
            const request = JSON.stringify(fixture.summaryRequests.slice(-2));
            assert.match(request, /summari[sz]|summary/i);
            assert.match(request, /OWNED HISTORY/);
            if (instructions) assert.match(request, /KEEP WHOLE  REMAINDER/);
            const stored = (await readFile(file, 'utf8'))
              .trim()
              .split('\n')
              .map((s) => JSON.parse(s));
            for (const e of entries.slice(1))
              assert.deepEqual(
                stored.find((x) => x.id === e.id),
                e
              );
            const compact = stored.find((e) => e.type === 'compaction');
            assert.equal(compact.summary, result.summary);
            assert.equal(compact.firstKeptEntryId, result.firstKeptEntryId);
            const after = await rpc({ type: 'get_state' });
            for (const key of ['sessionId', 'sessionFile', 'model', 'thinkingLevel'])
              assert.deepEqual(after[key], before[key]);
            assert.equal(after.isCompacting, false);
            const messages = await rpc({ type: 'get_messages' });
            assert.match(JSON.stringify(messages), /OWNED COMPACTION SUMMARY/);
            assert.ok(events.some((e) => e.type === 'compaction_start'));
            assert.ok(
              events.some(
                (e) =>
                  e.type === 'compaction_end' && e.result?.summary === result.summary && !e.aborted
              )
            );
          }
          await load('failure');
          fixture.setSummaryOutcome('failure');
          await assert.rejects(rpc({ type: 'compact' }));
          assert.equal((await rpc({ type: 'get_state' })).isCompacting, false);
          await load('abort');
          fixture.setSummaryOutcome('hold');
          const count: number = fixture.requests;
          const compacting = rpc({ type: 'compact' });
          const rejected = assert.rejects(compacting);
          for (let i = 0; fixture.requests < count + 1 && i < 200; i++)
            await new Promise((r) => setTimeout(r, 10));
          assert.equal(fixture.requests, count + 1);
          if (mode !== 'stock')
            await assert.rejects(rpc({ type: 'compact' }), /SDK_OPERATION_FAILED/);
          await rpc({ type: 'abort' });
          await rejected;
          assert.equal((await rpc({ type: 'get_state' })).isCompacting, false);
          assert.ok(events.some((e) => e.type === 'compaction_end' && e.aborted));
          assert.equal(await readFile(fixture.globalSettings, 'utf8'), defaults);
          assert.equal(await readFile(fixture.projectSettings, 'utf8'), project);
          assert.equal(await readFile(fixture.networkLog, 'utf8'), '');
          assert.equal(
            fixture.requests,
            6,
            'two complete split-turn summaries plus one failure and one explicit abort'
          );
          for (const request of fixture.summaryRequests)
            assert.match(JSON.stringify(request), /summari[sz]|summary/i);
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
