import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createNativeFixture,
  spawnNativeSdkHost,
  resolveNativeCli,
} from '../helpers/nativeFixture';
import { RpcClient } from '../../src/rpc/client';
import { RpcTransport } from '../../src/rpc/transport';
import type { RpcEvent } from '../../src/rpc/protocol';

async function until(predicate: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 10000;
  while (!(await predicate())) {
    assert.ok(Date.now() < deadline, 'owned startup lifecycle timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

for (const mode of ['shared', 'dedicated'] as const) {
  test(
    `Pi 1.2.0 ${mode}: startup cancellation, queued input and custom runs`,
    { timeout: 30000 },
    async () => {
      assert.equal((await resolveNativeCli()).version, '1.2.0');
      const fixture = await createNativeFixture('startup');
      let child: Awaited<ReturnType<typeof spawnNativeSdkHost>>['child'] | undefined;
      let transport: RpcTransport | undefined;
      try {
        const host = await spawnNativeSdkHost(fixture, mode);
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
        child.once('exit', () => opened({ success: false }));
        child.stdin!.write(JSON.stringify({ k: 'one', d: host.open }) + '\n');
        assert.equal((await ready).success, true);
        const traceFile = join(fixture.cwd, 'startup-trace.jsonl');
        const releaseFile = join(fixture.cwd, 'startup-release');
        const trace = async (): Promise<any[]> =>
          (await readFile(traceFile, 'utf8').catch(() => ''))
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line));
        const starting = client.prompt('owned start-block cancel');
        await until(async () =>
          (await trace()).some((event) => event.type === 'before_agent_start')
        );
        assert.equal(
          (await client.getState())!.isStreaming,
          true,
          'starting handler is already busy'
        );
        const userStart = (await trace()).find((event) => event.type === 'before_agent_start');
        assert.equal(userStart.messageType, 'user');
        assert.equal(userStart.hasPrompt, true);
        assert.equal(userStart.idle, false);
        let aborted = false;
        const abort = client.abort().then(() => {
          aborted = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 25));
        assert.equal(aborted, false, 'abort waits for starting run to settle');
        await writeFile(releaseFile, 'release');
        assert.equal((await starting)?.disposition, 'started');
        await abort;
        await until(() => events.some((event) => event.type === 'agent_settled'));
        assert.equal(events.find((event) => event.type === 'agent_settled')!.aborted, true);
        assert.equal(fixture.requests, 0, 'startup abort prevents the provider request');

        await client.newSession();
        events.length = 0;
        await rm(releaseFile);
        await writeFile(traceFile, '');
        const queuedStart = client.prompt('owned start-block queued');
        await until(async () =>
          (await trace()).some((event) => event.type === 'before_agent_start')
        );
        assert.equal(
          (await client.prompt('owned queued steer', undefined, 'steer'))?.disposition,
          'queued'
        );
        await client.followUp('owned queued follow-up');
        await writeFile(releaseFile, 'release');
        assert.equal((await queuedStart)?.disposition, 'started');
        await until(() => events.some((event) => event.type === 'agent_settled'));
        assert.equal(events.find((event) => event.type === 'agent_settled')!.aborted, false);
        const messages = JSON.stringify((await client.getMessages())!.messages);
        assert.ok(messages.includes('owned queued steer'));
        assert.ok(messages.includes('owned queued follow-up'));
        assert.equal(
          (await trace()).filter((event) => event.type === 'before_agent_start').length,
          1,
          'queued inputs share the starting run'
        );

        events.length = 0;
        assert.equal((await client.prompt('/owned-custom'))?.disposition, 'handled');
        await until(() => events.some((event) => event.type === 'agent_settled'));
        const traces = await trace();
        const custom = traces.find((event) => event.messageType === 'custom');
        assert.ok(custom, 'extension-triggered custom run executes before_agent_start');
        assert.equal(custom.hasPrompt, false);
        assert.equal(custom.idle, false);
        for (const event of traces.filter((event) => event.type === 'input'))
          assert.equal(event.source, 'rpc');
        const replay = JSON.stringify((await client.getMessages())!.messages);
        for (const content of ['OWNED CUSTOM START', 'OWNED NEXT TURN', 'OWNED RUN SETUP'])
          assert.ok(replay.includes(content), content);
      } finally {
        transport?.disconnect(new Error('owned test shutdown'));
        if (child && child.exitCode === null && child.signalCode === null) {
          const exited = new Promise((resolve) => child!.once('exit', resolve));
          child.kill('SIGKILL');
          await exited;
        }
        const denied = await readFile(fixture.networkLog, 'utf8');
        await fixture.dispose();
        assert.equal(denied.trim(), '', 'no forbidden network requests');
      }
    }
  );
}
