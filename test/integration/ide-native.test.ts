import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createNativeFixture,
  nativeSpawnPlan,
  resolveNativeCli,
  spawnNativeSdkHost,
  type NativeFixture,
} from '../helpers/nativeFixture';
import { spawnRealPi, shutdown, type SpawnedRpc } from '../helpers/rpc';
import { RpcClient } from '../../src/rpc/client';
import { RpcTransport } from '../../src/rpc/transport';
import type { RpcEvent, ExtensionUiRequest } from '../../src/rpc/protocol';

async function until(predicate: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 12000;
  while (!(await predicate())) {
    assert.ok(Date.now() < deadline, 'native IDE event timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function connect(
  fixture: NativeFixture,
  mode: 'stock' | 'shared' | 'dedicated',
  existingHost?: Awaited<ReturnType<typeof spawnNativeSdkHost>>,
  channel = 'ide-one'
): Promise<SpawnedRpc> {
  if (mode === 'stock') return spawnRealPi([], fixture);
  const host = existingHost ?? (await spawnNativeSdkHost(fixture, mode));
  const child = host.child as SpawnedRpc['child'];
  const output = new PassThrough();
  let buffer = '';
  let opened!: (reply: any) => void;
  const ready = new Promise<any>((resolve) => {
    opened = resolve;
  });
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const { k, d } = JSON.parse(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
      if (k !== channel) continue;
      if (d.command === 'open') opened(d);
      else output.write(JSON.stringify(d) + '\n');
    }
  });
  const input = new Writable({
    write(chunk, _encoding, callback) {
      child.stdin.write(
        JSON.stringify({ k: channel, d: JSON.parse(String(chunk)) }) + '\n',
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
  child.once('exit', () => opened({ success: false }));
  child.stdin.write(JSON.stringify({ k: channel, d: host.open }) + '\n');
  assert.equal((await ready).success, true);
  return { child, client, transport, fixture, cwd: fixture.cwd };
}

test(
  'native IDE shared: simultaneous chats receive only their own query responses',
  { timeout: 30000 },
  async () => {
    const fixture = await createNativeFixture('ide-tools');
    let first: SpawnedRpc | undefined;
    let second: SpawnedRpc | undefined;
    try {
      const host = await spawnNativeSdkHost(fixture, 'shared');
      first = await connect(fixture, 'shared', host, 'ide-first');
      second = await connect(fixture, 'shared', host, 'ide-second');
      const replyIds = new Set<string>();
      for (const [index, current] of [first, second].entries()) {
        current.client.onExtensionUi((request) => {
          if (request.title !== 'pi-vscode-ide-v1') return;
          assert.ok(!replyIds.has(request.id), 'query correlation is unique across sessions');
          replyIds.add(request.id);
          const query = JSON.parse(request.placeholder!);
          const wrongClient = index === 0 ? second! : first!;
          void wrongClient.client.respondExtensionUi({
            id: request.id,
            value: '{"wrong":"other chat"}',
          });
          void current.client.respondExtensionUi({
            id: request.id,
            value: JSON.stringify({
              vscodeIde: 1,
              operation: query.operation,
              status: 'ok',
              locations: [{ path: 'owned.ts', line: 1, character: 1, name: `chat-${index}` }],
            }),
          });
        });
      }
      await Promise.all([
        first.client.prompt('owned first chat'),
        second.client.prompt('owned second chat'),
      ]);
      await until(
        async () =>
          !(await first!.client.getState())!.isStreaming &&
          !(await second!.client.getState())!.isStreaming
      );
      assert.equal(replyIds.size, 8);
      for (const [index, current] of [first, second].entries()) {
        const results = ((await current.client.getMessages())!.messages as any[]).filter(
          (message) => message.role === 'toolResult'
        );
        assert.equal(results.length, 4);
        for (const result of results)
          assert.equal(JSON.parse(result.content[0].text).locations[0].name, `chat-${index}`);
      }
    } finally {
      second?.transport.disconnect(new Error('owned second chat shutdown'));
      if (first) await shutdown(first);
      else await fixture.dispose();
    }
  }
);

const operations = ['diagnostics', 'document_symbols', 'definitions', 'references'];

for (const mode of ['stock', 'shared', 'dedicated'] as const) {
  test(
    `native IDE ${mode}: registered tools execute through real RPC reverse UI and preserve ordinary questions`,
    { timeout: 45000 },
    async () => {
      const runtime = mode === 'stock' ? 'path-cli' : 'supported-sdk';
      const selected = await resolveNativeCli(runtime);
      if (mode !== 'stock') assert.equal(selected.version, '1.2.0');
      const fixture = await createNativeFixture('ide-tools', runtime);
      let spawned: SpawnedRpc | undefined;
      try {
        const plan = await nativeSpawnPlan(fixture);
        assert.equal(
          plan.args.find((arg) => arg.endsWith('/dist/bundle/cli.js')),
          selected.cli
        );
        spawned = await connect(fixture, mode);
        const events: RpcEvent[] = [];
        const requests: ExtensionUiRequest[] = [];
        const replies: Promise<void>[] = [];
        spawned.client.onEvent((event) => events.push(event));
        spawned.client.onExtensionUi((request) => {
          requests.push(request);
          if (request.title !== 'pi-vscode-ide-v1') return;
          const query = JSON.parse(request.placeholder!);
          assert.ok(operations.includes(query.operation));
          assert.equal(query.path, 'owned.ts');
          replies.push(
            spawned!.client.respondExtensionUi({
              id: 'unrelated-native-request',
              value: '{"status":"wrong request"}',
            })
          );
          replies.push(
            spawned!.client.respondExtensionUi({
              id: request.id,
              value: JSON.stringify({
                vscodeIde: 1,
                operation: query.operation,
                status: 'ok',
                locations: [
                  { path: 'owned.ts', line: 1, character: 1, name: `owned-${query.operation}` },
                ],
              }),
            })
          );
        });
        await spawned.client.getState();
        await spawned.client.prompt('/owned-ide-tools');
        await until(() =>
          requests.some(
            (request) => request.method === 'notify' && request.message?.includes('"tools"')
          )
        );
        const registered = JSON.parse(
          requests.find((request) => request.message?.includes('"tools"'))!.message!
        );
        for (const operation of operations) {
          assert.ok(registered.tools.includes(`vscode_${operation}`), JSON.stringify(registered));
          assert.ok(registered.active.includes(`vscode_${operation}`));
        }
        await spawned.client.prompt('owned IDE all queries');
        await until(
          () => events.filter((event) => event.type === 'tool_execution_end').length === 4
        );
        await Promise.all(replies);
        await until(async () => !(await spawned!.client.getState())!.isStreaming);
        assert.equal(
          requests.filter((request) => request.title === 'pi-vscode-ide-v1').length,
          4,
          'native context exposes RPC UI'
        );
        assert.equal(
          new Set(requests.map((request) => request.id)).size,
          requests.length,
          'native request correlation IDs are unique'
        );
        const messages = (await spawned.client.getMessages())!.messages as any[];
        for (const operation of operations) {
          const result = messages.find(
            (message) => message.role === 'toolResult' && message.toolName === `vscode_${operation}`
          );
          assert.ok(result, `persisted ${operation} result`);
          assert.equal(result.toolCallId, `owned_ide_${operation}`);
          const body = JSON.parse(result.content[0].text);
          assert.equal(body.status, 'ok');
          assert.equal(body.locations[0].name, `owned-${operation}`);
        }
        assert.equal(
          fixture.requests,
          2,
          'owned local model executes tool turn and completion only'
        );
        const provider = fixture.summaryRequests[0] as any;
        for (const operation of operations)
          assert.ok(
            provider.tools.some((tool: any) => tool.function.name === `vscode_${operation}`)
          );
        const trace = await readFile(join(fixture.cwd, 'ide-native-trace.jsonl'), 'utf8');
        for (const input of trace
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line)))
          assert.equal(input.source, 'rpc');
        const ordinary = spawned.client.prompt('/owned-ide-question');
        await until(() => requests.some((request) => request.title === 'Owned ordinary question'));
        const question = requests.find((request) => request.title === 'Owned ordinary question')!;
        assert.equal(question.placeholder, 'ordinary placeholder');
        await spawned.client.respondExtensionUi({ id: question.id, value: 'ordinary answer' });
        await ordinary;
        await until(async () =>
          (await readFile(join(fixture.cwd, 'ide-native-trace.jsonl'), 'utf8')).includes(
            'ordinary answer'
          )
        );
      } finally {
        if (spawned) await shutdown(spawned);
        else await fixture.dispose();
      }
    }
  );

  test(
    `native IDE ${mode}: errors remain tool results and abort cancels pending reverse UI`,
    { timeout: 45000 },
    async () => {
      const fixture = await createNativeFixture(
        'ide-tools',
        mode === 'stock' ? 'path-cli' : 'supported-sdk'
      );
      let spawned: SpawnedRpc | undefined;
      try {
        spawned = await connect(fixture, mode);
        const events: RpcEvent[] = [];
        const requests: ExtensionUiRequest[] = [];
        let hold = false;
        spawned.client.onEvent((event) => events.push(event));
        spawned.client.onExtensionUi((request) => {
          if (request.title !== 'pi-vscode-ide-v1') return;
          requests.push(request);
          if (hold) return;
          const query = JSON.parse(request.placeholder!);
          void spawned!.client.respondExtensionUi({
            id: request.id,
            value: JSON.stringify({
              vscodeIde: 1,
              operation: query.operation,
              status: 'error',
              locations: [],
              message: 'Owned language service unavailable',
            }),
          });
        });
        await spawned.client.getState();
        await spawned.client.prompt('owned IDE provider unavailable');
        await until(
          () => events.filter((event) => event.type === 'tool_execution_end').length === 4
        );
        await until(async () => !(await spawned!.client.getState())!.isStreaming);
        const messages = (await spawned.client.getMessages())!.messages as any[];
        const results = messages.filter((message) => message.role === 'toolResult');
        assert.equal(results.length, 4);
        for (const result of results) {
          assert.equal(result.isError, true);
          assert.equal(JSON.parse(result.content[0].text).status, 'error');
        }
        assert.ok(
          events
            .filter((event) => event.type === 'tool_execution_end')
            .every((event) => event.isError === true)
        );
        await spawned.client.newSession();
        events.length = 0;
        requests.length = 0;
        fixture.resetRequests();
        hold = true;
        const pending = spawned.client.prompt('owned IDE abort pending');
        await until(() => requests.length > 0);
        const abort = spawned.client.abort();
        await Promise.all([pending, abort]);
        await until(async () => !(await spawned!.client.getState())!.isStreaming);
        assert.equal(fixture.requests, 1, 'aborting an editor query never calls the model again');
        assert.ok(events.some((event) => event.type === 'tool_execution_end'));
        const cancelledMessages = (await spawned.client.getMessages())!.messages as any[];
        const cancelled = cancelledMessages.filter((message) => message.role === 'toolResult');
        assert.ok(cancelled.length > 0);
        assert.ok(cancelled.every((message) => message.isError));
        const before = JSON.stringify(cancelledMessages);
        await spawned.client.respondExtensionUi({
          id: requests[0]!.id,
          value: JSON.stringify({
            vscodeIde: 1,
            operation: 'diagnostics',
            status: 'ok',
            locations: [{ path: 'late.ts', line: 1, character: 1 }],
          }),
        });
        assert.equal(
          JSON.stringify((await spawned.client.getMessages())!.messages),
          before,
          'late responses cannot alter the cancelled session'
        );
      } finally {
        if (spawned) await shutdown(spawned);
        else await fixture.dispose();
      }
    }
  );
}

test('owned IDE profile binds the selected PATH CLI and exact GUI resources', async () => {
  await assert.rejects(createNativeFixture('default', 'path-cli'), /Unowned fixture runtime/);
  const fixture = await createNativeFixture('ide-tools', 'path-cli');
  try {
    const plan = await nativeSpawnPlan(fixture);
    assert.ok(plan.args.some((arg) => arg.endsWith('/dist/bundle/cli.js')));
    assert.equal(plan.args.filter((arg) => arg === '--extension').length, 2);
    assert.ok(plan.args.some((arg) => arg.endsWith('/pi-vscode-ide.mjs')));
    assert.ok(plan.args.some((arg) => arg.endsWith('/ide-native-driver.mjs')));
    await assert.rejects(nativeSpawnPlan(fixture, ['--extension', '/foreign.mjs']));
    const copiedResource = plan.args.find((arg) => arg.endsWith('/pi-vscode-ide.mjs'))!;
    assert.equal(
      await readFile(copiedResource, 'utf8'),
      await readFile('resources/pi-vscode-ide.mjs', 'utf8')
    );
    await writeFile(copiedResource, 'export default function() {}');
    await assert.rejects(nativeSpawnPlan(fixture), /Unowned host asset mutation/);
  } finally {
    await fixture.dispose();
  }
});
