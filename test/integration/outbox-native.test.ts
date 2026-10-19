import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { RpcClient } from '../../src/rpc/client';
import { RpcTransport } from '../../src/rpc/transport';
import type { ExtensionUiRequest, JsonObject, RpcEvent } from '../../src/rpc/protocol';
import {
  createNativeFixture,
  nativeSdkHostPlan,
  resolveNativeCli,
  spawnNativeSdkHost,
  type NativeFixture,
} from '../helpers/nativeFixture';
import { shutdown, type SpawnedRpc } from '../helpers/rpc';

async function until(predicate: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 10000;
  while (!(await predicate())) {
    assert.ok(Date.now() < deadline, 'Owned native outbox event timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function connect(fixture: NativeFixture, mode: 'shared' | 'dedicated'): Promise<SpawnedRpc> {
  const selected = await resolveNativeCli('path-cli');
  assert.equal(selected.version, '1.3.0');
  const plan = await nativeSdkHostPlan(fixture, mode);
  assert.equal(plan.env.PI_HOST_PI_ROOT, selected.root);
  assert.equal(plan.env.PI_HOST_DEDICATED, mode === 'dedicated' ? '1' : '0');
  const host = await spawnNativeSdkHost(fixture, mode);
  const child = host.child as SpawnedRpc['child'];
  const output = new PassThrough();
  let buffer = '';
  let opened!: (value: any) => void;
  const ready = new Promise<any>((resolve) => {
    opened = resolve;
  });
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const { k, d } = JSON.parse(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
      if (k !== 'outbox-owned') continue;
      if (d.command === 'open') opened(d);
      else output.write(JSON.stringify(d) + '\n');
    }
  });
  const input = new Writable({
    write(chunk, _encoding, callback) {
      child.stdin.write(
        JSON.stringify({ k: 'outbox-owned', d: JSON.parse(String(chunk)) }) + '\n',
        callback
      );
    },
  });
  const transport = new RpcTransport(input, output, child.stderr, {
    maxRecordBytes: 1000000,
    maxBufferBytes: 1000000,
    maxPendingRequests: 64,
    maxQueuedWrites: 64,
  });
  const client = new RpcClient(1, transport, { shortTimeoutMs: 10000, longTimeoutMs: 15000 });
  const rpc = { child, client, transport, fixture, cwd: fixture.cwd };
  child.once('exit', () => opened({ success: false }));
  child.stdin.write(JSON.stringify({ k: 'outbox-owned', d: host.open }) + '\n');
  if (!(await ready).success) {
    await shutdown(rpc);
    throw new Error('Owned native outbox fixture failed to open');
  }
  assert.equal((await client.getCapabilities())!.sdkVersion, '1.3.0');
  assert.equal(
    ((await client.getCapabilities())!.engineCommands as JsonObject).outbox_prompt,
    true
  );
  return rpc;
}

for (const mode of ['shared', 'dedicated'] as const) {
  test(
    `native outbox ${mode}: passive widgets permit handoff while native questions remain guarded`,
    { timeout: 15000 },
    async () => {
      const fixture = await createNativeFixture('ide-tools', 'selected-sdk');
      let rpc: SpawnedRpc | undefined;
      try {
        rpc = await connect(fixture, mode);
        const client = rpc.client;
        const requests: ExtensionUiRequest[] = [];
        const replies: Promise<void>[] = [];
        client.onExtensionUi((request) => {
          requests.push(request);
          if (request.title !== 'pi-vscode-ide-v1') return;
          const query = JSON.parse(request.placeholder!);
          replies.push(
            client.respondExtensionUi({
              id: request.id,
              value: JSON.stringify({
                vscodeIde: 1,
                operation: query.operation,
                status: 'ok',
                locations: [],
              }),
            })
          );
        });
        assert.equal((await client.prompt('/owned-ide-widget'))!.disposition, 'handled');
        await until(() => requests.some((request) => request.method === 'setWidget'));
        const state = (await client.getState())!;
        assert.equal(state.isIdle, true);
        const outbox = {
          sessionId: state.sessionId!,
          sessionFile: state.sessionFile,
          requireIdle: true,
        };
        const question = client.prompt('/owned-ide-question');
        await until(() => requests.some((request) => request.title === 'Owned ordinary question'));
        await assert.rejects(
          client.prompt('blocked native question', undefined, undefined, { outbox }),
          (error: any) =>
            error.outboxNotDispatched === true && error.message.includes('OUTBOX_BUSY')
        );
        const input = requests.find((request) => request.title === 'Owned ordinary question')!;
        await client.respondExtensionUi({ id: input.id, value: 'owned answer' });
        assert.equal((await question)!.disposition, 'handled');
        const events: RpcEvent[] = [];
        client.onEvent((event) => events.push(event));
        assert.equal(
          (await client.prompt('owned message with persistent widget', undefined, undefined, {
            outbox,
          }))!.disposition,
          'started'
        );
        await until(() => events.some((event) => event.type === 'agent_settled'));
        await Promise.all(replies);
        assert.equal(fixture.summaryRequests.length, 2, 'owned IDE tools finish before the reply');
        assert.ok(
          !JSON.stringify((await client.getMessages())!.messages).includes(
            'blocked native question'
          )
        );
        assert.equal((await client.getState())!.isIdle, true);
      } finally {
        if (rpc) await shutdown(rpc);
        else await fixture.dispose();
      }
    }
  );
  test(
    `native outbox ${mode}: exact origin, idle refusal, cancellation and RPC transcript handoff`,
    { timeout: 30000 },
    async () => {
      const fixture = await createNativeFixture('startup', 'selected-sdk');
      let rpc: SpawnedRpc | undefined;
      try {
        rpc = await connect(fixture, mode);
        const client = rpc.client;
        const saved = async (name: string) => {
          const file = join(fixture.cwd, `${name}.jsonl`);
          const timestamp = '2024-01-01T00:00:00.000Z';
          await writeFile(
            file,
            [
              { type: 'session', version: 3, id: name, timestamp, cwd: fixture.cwd },
              {
                type: 'model_change',
                id: 'model',
                parentId: null,
                timestamp,
                provider: 'fixture-alpha',
                modelId: 'ping',
              },
            ]
              .map((row) => JSON.stringify(row))
              .join('\n') + '\n'
          );
          const state = (await client.getState())!;
          await client.replaceChat('resume', file, {
            sessionId: state.sessionId,
            sessionFile: state.sessionFile,
            leafId: (await client.getEntries())!.leafId,
          });
          assert.equal((await client.getState())!.sessionFile, file);
          return file;
        };
        await saved('owned-outbox-first');
        const before = (await client.getState())!;
        const origin = {
          sessionId: before.sessionId!,
          sessionFile: before.sessionFile,
          requireIdle: true,
        };
        const traceFile = join(fixture.cwd, 'startup-trace.jsonl');
        const trace = async () =>
          (await readFile(traceFile, 'utf8').catch(() => ''))
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line));

        const malformed = await rpc.transport.request({
          type: 'prompt',
          id: 'owned-malformed',
          message: 'must not enter history',
          outbox: { sessionId: before.sessionId, requireIdle: 'yes' },
        } as any);
        assert.equal(malformed.success, false);
        assert.equal(malformed.error, 'OUTBOX_INVALID_ADMISSION');
        assert.equal((malformed as any).outboxNotDispatched, true);
        await assert.rejects(
          client.prompt('wrong session must not enter history', undefined, undefined, {
            outbox: { ...origin, sessionId: 'other-owned-session' },
          }),
          (error: any) =>
            error.outboxNotDispatched === true && error.message.includes('OUTBOX_STALE_ORIGIN')
        );
        assert.deepEqual((await client.getMessages())!.messages, []);
        assert.equal(fixture.requests, 0);

        const events: RpcEvent[] = [];
        client.onEvent((event) => events.push(event));
        const starting = client.prompt(
          'owned start-block managed cancellation',
          undefined,
          undefined,
          { outbox: origin }
        );
        void starting.catch(() => {}); // Preserve the first assertion if cleanup interrupts preflight.
        await until(async () =>
          (await trace()).some((event) => event.type === 'before_agent_start')
        );
        assert.equal((await client.getState())!.isStreaming, true);
        assert.equal(
          (await client.prompt('owned concurrent steering', undefined, 'steer'))!.disposition,
          'queued'
        );
        const thinking = (await client.getState())!.thinkingLevel;
        await assert.rejects(client.setThinkingLevel('high'), /SDK_OPERATION_FAILED/);
        assert.equal((await client.getState())!.thinkingLevel, thinking);
        await assert.rejects(
          client.prompt('busy must not enter history', undefined, undefined, { outbox: origin }),
          (error: any) =>
            error.outboxNotDispatched === true && error.message.includes('OUTBOX_BUSY')
        );
        const stopping = client.abort();
        await writeFile(join(fixture.cwd, 'startup-release'), 'release');
        assert.equal((await starting)!.disposition, 'started');
        await stopping;
        await until(() => events.some((event) => event.type === 'agent_settled'));
        assert.equal(events.find((event) => event.type === 'agent_settled')!.aborted, true);
        assert.equal(fixture.requests, 0, 'cancelled setup never calls a provider');

        const firstState = (await client.getState())!;
        const firstFile = firstState.sessionFile!;
        await saved('owned-outbox-second');
        await assert.rejects(
          client.prompt('stale session must not enter history', undefined, undefined, {
            outbox: origin,
          }),
          (error: any) =>
            error.outboxNotDispatched === true && error.message.includes('OUTBOX_STALE_ORIGIN')
        );
        const fresh = (await client.getState())!;
        events.length = 0;
        assert.equal(
          (await client.prompt('owned accepted managed message', undefined, undefined, {
            outbox: {
              sessionId: fresh.sessionId!,
              sessionFile: fresh.sessionFile,
              requireIdle: true,
            },
          }))!.disposition,
          'started'
        );
        await until(() => events.some((event) => event.type === 'agent_settled'));
        assert.equal(fixture.summaryRequests.length, 1);
        const completed = (await client.getState())!;
        assert.equal(completed.isIdle, true);
        assert.notEqual(completed.sessionFile, firstFile);
        const transcript = await readFile(completed.sessionFile!, 'utf8');
        assert.equal(
          transcript.split('owned accepted managed message').length - 1,
          1,
          'accepted payload occurs once in the canonical JSONL'
        );
        assert.ok(!transcript.includes('must not enter history'));
        const inputs = (await trace()).filter((event) => event.type === 'input');
        assert.equal(
          inputs.length,
          3,
          'only two managed payloads and ordinary steering reach native input'
        );
        for (const input of inputs) assert.equal(input.source, 'rpc');
      } finally {
        if (rpc) await shutdown(rpc);
        else await fixture.dispose();
      }
    }
  );
}
