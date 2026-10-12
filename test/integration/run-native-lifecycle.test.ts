import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createNativeFixture, spawnNativeSdkHost } from '../helpers/nativeFixture';
import { RpcClient } from '../../src/rpc/client';
import { RpcTransport } from '../../src/rpc/transport';
import type { RpcEvent } from '../../src/rpc/protocol';

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 10000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'native lifecycle event timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

for (const mode of ['shared', 'dedicated'] as const) {
  test(
    `Pi 1.1.0 ${mode} abort/completion and native duration persist across session reload`,
    { timeout: 30000 },
    async () => {
      const fixture = await createNativeFixture('compact');
      let child: Awaited<ReturnType<typeof spawnNativeSdkHost>>['child'] | undefined;
      let transport: RpcTransport | undefined;
      try {
        const host = await spawnNativeSdkHost(fixture, mode, 'tool-modifiers');
        child = host.child;
        const output = new PassThrough();
        let buffer = '';
        let opened!: (value: any) => void;
        const ready = new Promise<any>((resolve) => {
          opened = resolve;
        });
        child.stdout!.on('data', (chunk) => {
          buffer += chunk;
          let index;
          while ((index = buffer.indexOf('\n')) >= 0) {
            const { k, d } = JSON.parse(buffer.slice(0, index));
            buffer = buffer.slice(index + 1);
            if (k !== 'one') continue;
            if (d.command === 'open') opened(d);
            else output.write(JSON.stringify(d) + '\n');
          }
        });
        const input = new Writable({
          write(chunk, _encoding, callback) {
            child!.stdin!.write(
              JSON.stringify({ k: 'one', d: JSON.parse(String(chunk)) }) + '\n',
              callback
            );
          },
        });
        transport = new RpcTransport(input, output, child.stderr!, {
          maxRecordBytes: 1000000,
          maxBufferBytes: 1000000,
          maxPendingRequests: 64,
          maxQueuedWrites: 64,
        });
        const client = new RpcClient(1, transport, { shortTimeoutMs: 10000, longTimeoutMs: 10000 });
        const events: RpcEvent[] = [];
        client.onEvent((event) => events.push(event));
        child.stdin!.write(JSON.stringify({ k: 'one', d: host.open }) + '\n');
        assert.equal((await ready).success, true);
        const file = join(fixture.cwd, 'owned-timing-session.jsonl');
        await writeFile(
          file,
          JSON.stringify({
            type: 'session',
            version: 3,
            id: 'owned-timing',
            timestamp: '2024-01-01T00:00:00.000Z',
            cwd: fixture.cwd,
          }) + '\n'
        );
        await client.switchSession(file);
        fixture.setSummaryOutcome('hold');
        assert.equal((await client.prompt('owned held request'))?.disposition, 'started');
        await until(() => fixture.requests > 0);
        await client.abort();
        await until(() => events.some((event) => event.type === 'agent_settled'));
        assert.equal(events.find((event) => event.type === 'agent_settled')!.aborted, true);
        events.length = 0;
        fixture.setSummaryOutcome('tool');
        await client.prompt('owned read-only tool request');
        await until(() => events.some((event) => event.type === 'agent_settled'));
        assert.equal(events.find((event) => event.type === 'agent_settled')!.aborted, false);
        const tool = events.find((event) => event.type === 'tool_execution_end');
        assert.ok(tool);
        assert.equal(tool.isError, false);
        assert.ok(
          typeof tool.durationMs === 'number' &&
            Number.isFinite(tool.durationMs) &&
            tool.durationMs >= 0
        );
        const saved = (await readFile(file, 'utf8'))
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
          .filter((record) => record.type === 'message')
          .map((record) => record.message);
        const savedTool = saved.find((message) => message.role === 'toolResult');
        assert.equal(savedTool.durationMs, tool.durationMs);
        assert.ok(
          saved.some(
            (message) =>
              message.role === 'assistant' &&
              typeof message.durationMs === 'number' &&
              message.durationMs >= 0
          )
        );
        await client.newSession();
        await client.switchSession(file);
        const replay = (await client.getMessages())!.messages as any[];
        assert.equal(
          replay.find((message) => message.role === 'toolResult').durationMs,
          savedTool.durationMs
        );
        assert.ok(
          replay.some(
            (message) => message.role === 'assistant' && typeof message.durationMs === 'number'
          )
        );
      } finally {
        transport?.disconnect(new Error('test shutdown'));
        if (child && child.exitCode === null && child.signalCode === null) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(() => child!.kill('SIGKILL'), 1000);
            child!.once('exit', () => {
              clearTimeout(timer);
              resolve();
            });
            child!.kill('SIGTERM');
          });
        }
        const denied = await readFile(fixture.networkLog, 'utf8');
        await fixture.dispose();
        assert.equal(denied.trim(), '', 'no forbidden network requests');
      }
    }
  );
}
