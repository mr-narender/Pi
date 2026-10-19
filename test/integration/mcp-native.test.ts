import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { writeFile } from 'node:fs/promises';
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
import { parseMcpStatus } from '../../src/mcp/status';
import type { ExtensionUiRequest, RpcEvent } from '../../src/rpc/protocol';

async function connect(
  fixture: NativeFixture,
  mode: 'shared' | 'dedicated',
  existingHost?: Awaited<ReturnType<typeof spawnNativeSdkHost>>,
  channel = 'mcp-owned'
): Promise<SpawnedRpc> {
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

test('native MCP stock: selected PATH Pi does not claim the GUI status capability', async () => {
  const fixture = await createNativeFixture('mcp-status', 'path-cli');
  let spawned: SpawnedRpc | undefined;
  try {
    const selected = await resolveNativeCli('path-cli');
    const plan = await nativeSpawnPlan(fixture);
    assert.ok(plan.args.includes(selected.cli));
    spawned = await spawnRealPi([], fixture);
    const commands = (await spawned.client.getCommands())!.commands;
    assert.ok(Array.isArray(commands));
    const before = await spawned.client.getState();
    await assert.rejects(
      spawned.client.engineCommand('mcp_status', { sessionId: before!.sessionId }),
      /Unknown command|unsupported|support/i
    );
    assert.deepEqual((await spawned.client.getMessages())!.messages, []);
    assert.equal(fixture.summaryRequests.length, 0);
    assert.equal((await spawned.client.getState())!.isStreaming, false);
  } finally {
    if (spawned) await shutdown(spawned);
    else await fixture.dispose();
  }
});

for (const mode of ['shared', 'dedicated'] as const) {
  test(`native MCP ${mode}: explicit extension exclusion remains unsupported`, async () => {
    const fixture = await createNativeFixture();
    let spawned: SpawnedRpc | undefined;
    try {
      spawned = await connect(fixture, mode);
      const before = await spawned.client.getState();
      await assert.rejects(
        spawned.client.engineCommand('mcp_status', {
          sessionId: before!.sessionId,
          sessionFile: before!.sessionFile,
          leafId: (await spawned.client.getEntries())!.leafId,
        }),
        /does not support mcp_status/
      );
      assert.deepEqual((await spawned.client.getMessages())!.messages, []);
      assert.equal(fixture.requests, 0);
    } finally {
      if (spawned) await shutdown(spawned);
      else await fixture.dispose();
    }
  });

  for (const configured of [false, true]) {
    test(
      `native MCP ${mode}: ${configured ? 'connected, disabled, failed and invalid' : 'empty'} status is correlated and never enters model history`,
      { timeout: 30000 },
      async () => {
        assert.equal((await resolveNativeCli()).version, '1.2.0');
        const fixture = await createNativeFixture(configured ? 'mcp-status' : 'mcp-status-empty');
        let spawned: SpawnedRpc | undefined;
        try {
          spawned = await connect(fixture, mode);
          const requests: ExtensionUiRequest[] = [];
          const events: RpcEvent[] = [];
          spawned.client.onExtensionUi((request) => requests.push(request));
          spawned.client.onEvent((event) => events.push(event));
          const commands = (await spawned.client.getCommands())!.commands as any[];
          assert.ok(
            commands.some(
              (command) =>
                command.name === 'mcp' &&
                command.sourceInfo?.path === 'builtin:mcp' &&
                command.sourceInfo?.source === 'builtin'
            ),
            'the selected SDK registered its own built-in MCP command'
          );
          const before = await spawned.client.getState();
          const beforeEntries = await spawned.client.getEntries();
          const origin = {
            sessionId: before!.sessionId,
            sessionFile: before!.sessionFile,
            leafId: beforeEntries!.leafId,
          };
          const result = await spawned.client.engineCommand('mcp_status', origin);
          assert.equal(result!.contract, 1);
          assert.equal(result!.status, 'checked');
          assert.equal(typeof result!.checkedAt, 'number');
          assert.ok(Number.isFinite(result!.checkedAt));
          const notifications = result!.notifications as Array<{ message: string; level: string }>;
          assert.equal(notifications.length, 1);
          assert.equal(notifications[0]!.level, 'info');
          const report = notifications[0]!.message;
          const parsed = parseMcpStatus(result);
          assert.equal(parsed.checkedAt, result!.checkedAt);
          if (configured) {
            assert.match(report, /owned-connected: connected, 1 tools \(hidden\)/);
            assert.match(report, /owned-disabled: disabled \(hidden\)/);
            assert.match(report, /owned-failed: failed \(hidden\)/);
            assert.match(report, /config error: .*owned-invalid/);
            assert.doesNotMatch(report, /owned-project-only/);
            assert.equal(parsed.status, 'checked');
            assert.deepEqual(parsed.servers, [
              { name: 'owned-connected', state: 'connected', exposure: 'hidden', tools: 1 },
              { name: 'owned-failed', state: 'failed', exposure: 'hidden', tools: undefined },
              { name: 'owned-disabled', state: 'disabled', exposure: 'hidden', tools: undefined },
            ]);
            assert.match(parsed.details!, /config error: .*owned-invalid/);
            assert.doesNotMatch(parsed.details!, /https?:\/\/|owned-project-only/);
            assert.ok(fixture.requests > 0, 'only the owned loopback MCP stub was contacted');
          } else {
            assert.match(report, /^No MCP servers configured\./);
            assert.equal(parsed.status, 'none');
            assert.deepEqual(parsed.servers, []);
            assert.equal(parsed.details, undefined);
            assert.equal(fixture.requests, 0);
          }
          assert.ok(
            !requests.some((request) => request.message === report),
            'command-local status does not leak through uncorrelated global notifications'
          );
          assert.deepEqual(await spawned.client.getEntries(), beforeEntries);
          assert.deepEqual((await spawned.client.getMessages())!.messages, []);
          assert.equal(fixture.summaryRequests.length, 0);
          assert.equal((await spawned.client.getState())!.isStreaming, false);
          assert.ok(!events.some((event) => event.type === 'agent_start'));
          await assert.rejects(
            spawned.client.engineCommand('mcp_status', { ...origin, sessionId: 'stale-chat' }),
            /STALE_ORIGIN/
          );
        } finally {
          if (spawned) await shutdown(spawned);
          else await fixture.dispose();
        }
      }
    );
  }
}

test('native MCP shared: simultaneous chats keep status responses and origins private', async () => {
  const fixture = await createNativeFixture('mcp-status');
  let first: SpawnedRpc | undefined;
  let second: SpawnedRpc | undefined;
  try {
    const host = await spawnNativeSdkHost(fixture, 'shared');
    first = await connect(fixture, 'shared', host, 'mcp-first');
    second = await connect(fixture, 'shared', host, 'mcp-second');
    const origins = await Promise.all(
      [first, second].map(async ({ client }) => {
        const state = await client.getState();
        return {
          sessionId: state!.sessionId,
          sessionFile: state!.sessionFile,
          leafId: (await client.getEntries())!.leafId,
        };
      })
    );
    assert.notEqual(origins[0]!.sessionId, origins[1]!.sessionId);
    const results = await Promise.all(
      [first, second].map(({ client }, index) =>
        client.engineCommand('mcp_status', origins[index]!)
      )
    );
    for (const [index, current] of [first, second].entries()) {
      assert.equal(results[index]!.status, 'checked');
      assert.match(JSON.stringify(results[index]!.notifications), /owned-connected: connected/);
      assert.deepEqual((await current.client.getMessages())!.messages, []);
      await assert.rejects(
        current.client.engineCommand('mcp_status', origins[1 - index]!),
        /STALE_ORIGIN/
      );
    }
    assert.equal(fixture.summaryRequests.length, 0);
  } finally {
    second?.transport.disconnect(new Error('owned second MCP chat shutdown'));
    if (first) await shutdown(first);
    else await fixture.dispose();
  }
});

test('native MCP fixture rejects replacement of its sealed fixed server configuration', async () => {
  const fixture = await createNativeFixture('mcp-status');
  try {
    await writeFile(join(fixture.agentDir, 'mcp.json'), '{}');
    await assert.rejects(nativeSpawnPlan(fixture), /Unowned host asset mutation/);
  } finally {
    await fixture.dispose();
  }
});
