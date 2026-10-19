import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { RpcClient } from '../../src/rpc/client';
import { RpcTransport } from '../../src/rpc/transport';
import type { JsonObject, RpcEvent } from '../../src/rpc/protocol';
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
    assert.ok(Date.now() < deadline, 'Owned native model-tools event timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function connect(
  fixture: NativeFixture,
  mode: 'shared' | 'dedicated',
  version: string,
  filtered = false
) {
  const scenario = filtered ? 'model-tools-filtered' : 'default';
  const selected = await resolveNativeCli(version === '1.3.0' ? 'path-cli' : 'supported-sdk');
  assert.equal(selected.version, version);
  const plan = await nativeSdkHostPlan(fixture, mode, scenario);
  assert.equal(plan.env.PI_HOST_PI_ROOT, selected.root);
  assert.equal(plan.env.PI_HOST_DEDICATED, mode === 'dedicated' ? '1' : '0');
  const host = await spawnNativeSdkHost(fixture, mode, scenario);
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
      if (k !== 'model-tools-owned') continue;
      if (d.command === 'open') opened(d);
      else output.write(JSON.stringify(d) + '\n');
    }
  });
  const input = new Writable({
    write(chunk, _encoding, callback) {
      child.stdin.write(
        JSON.stringify({ k: 'model-tools-owned', d: JSON.parse(String(chunk)) }) + '\n',
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
  child.stdin.write(JSON.stringify({ k: 'model-tools-owned', d: host.open }) + '\n');
  if (!(await ready).success) {
    await shutdown(rpc);
    throw new Error('Owned model-tools host failed to open');
  }
  const capabilities = (await client.getCapabilities())!;
  assert.equal(capabilities.sdkVersion, version);
  assert.equal((capabilities.engineCommands as JsonObject).read_model_tools, true);
  assert.equal((capabilities.engineCommands as JsonObject).set_model_tools, true);
  const origin = async () => {
    const state = (await client.getState())!;
    return {
      sessionId: state.sessionId,
      sessionFile: state.sessionFile,
      leafId: (await client.getEntries())!.leafId,
    };
  };
  const read = async () => client.engineCommand('read_model_tools', await origin()) as Promise<any>;
  const apply = async (revision: string, names: string[]) =>
    client.engineCommand('set_model_tools', await origin(), { revision, names }) as Promise<any>;
  return { ...rpc, origin, read, apply };
}

for (const version of ['1.2.0', '1.3.0']) {
  for (const mode of ['shared', 'dedicated'] as const) {
    test(
      `native model tools ${version} ${mode}: readonly discovery, explicit idle loadout and version-accurate JSONL resume`,
      { timeout: 20000 },
      async () => {
        const fixture = await createNativeFixture(
          'model-tools',
          version === '1.3.0' ? 'selected-sdk' : 'supported-sdk'
        );
        let rpc: Awaited<ReturnType<typeof connect>> | undefined;
        try {
          rpc = await connect(fixture, mode, version);
          const file = join(fixture.cwd, 'owned-model-tools-session.jsonl');
          const timestamp = '2024-01-01T00:00:00.000Z';
          await writeFile(
            file,
            [
              {
                type: 'session',
                version: 3,
                id: 'owned-model-tools-session',
                timestamp,
                cwd: fixture.cwd,
              },
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
          await rpc.client.replaceChat('resume', file, await rpc.origin());
          const beforeFile = await readFile(file, 'utf8');
          const beforeSettings = await readFile(fixture.globalSettings, 'utf8');
          const initial = await rpc.read();
          assert.equal(initial.contract, 1);
          assert.equal(initial.persistence, version === '1.3.0' ? 'after-turn' : 'runtime-only');
          assert.match(initial.revision, /^[a-f0-9]{64}$/);
          assert.deepEqual(await rpc.read(), initial);
          assert.equal(
            await readFile(file, 'utf8'),
            beforeFile,
            'reading catalog never writes history'
          );
          assert.equal(fixture.requests, 0);
          for (const [name, exposure] of [
            ['owned_direct', 'direct'],
            ['owned_model_only', 'model-only'],
            ['owned_deferred', 'deferred'],
            ['owned_codemode', 'codemode'],
          ])
            assert.equal(initial.tools.find((tool: any) => tool.name === name)?.exposure, exposure);
          assert.ok(
            !initial.tools.some((tool: any) =>
              ['owned_hidden', 'owned_excluded'].includes(tool.name)
            )
          );
          for (const name of ['owned_hidden', 'owned_excluded', 'owned_missing']) {
            await assert.rejects(
              rpc.apply(initial.revision, [name]),
              /MODEL_TOOLS_INVALID_SELECTION/
            );
            assert.deepEqual((await rpc.read()).active, initial.active);
          }
          await assert.rejects(
            rpc.client.engineCommand('read_model_tools', {
              ...(await rpc.origin()),
              sessionId: 'other-owned-session',
            }),
            /STALE_ORIGIN/
          );
          await rpc.client.prompt('/owned-model-tools-widget');
          const wanted = ['owned_direct', 'owned_deferred'];
          const applied = await rpc.apply(initial.revision, wanted);
          assert.equal(applied.matched, true);
          assert.equal(applied.persistence, initial.persistence);
          assert.deepEqual(applied.active.slice().sort(), wanted.slice().sort());
          assert.equal(
            await readFile(fixture.globalSettings, 'utf8'),
            beforeSettings,
            'per-chat Apply never changes global defaults'
          );
          await rpc.client.prompt('/owned-clear-model-tools');
          assert.deepEqual((await rpc.read()).active, []);
          await assert.rejects(rpc.apply(applied.revision, wanted), /MODEL_TOOLS_STALE_CATALOG/);
          await rpc.apply((await rpc.read()).revision, wanted);

          const events: RpcEvent[] = [];
          rpc.client.onEvent((event) => events.push(event));
          fixture.setSummaryOutcome('hold');
          await rpc.client.prompt('owned active model-tools request');
          await until(() => fixture.summaryRequests.length === 1);
          const busyCatalog = await rpc.read();
          assert.deepEqual(
            busyCatalog.active.slice().sort(),
            wanted.slice().sort(),
            'busy discovery remains readonly'
          );
          await assert.rejects(rpc.apply(busyCatalog.revision, []), /MODEL_TOOLS_BUSY/);
          await rpc.client.abort();
          await until(() => events.some((event) => event.type === 'agent_settled'));
          fixture.setSummaryOutcome('success');
          events.length = 0;
          await rpc.client.prompt('owned record selected model tools');
          await until(() => events.some((event) => event.type === 'agent_settled'));
          assert.equal((await rpc.client.getState())!.sessionFile, file);
          const recorded = await readFile(file, 'utf8');
          assert.ok(recorded.includes('owned record selected model tools'));
          await rpc.client.replaceChat('new', undefined, await rpc.origin());
          await rpc.client.replaceChat('resume', file, await rpc.origin());
          assert.equal((await rpc.client.getState())!.sessionFile, file);
          assert.deepEqual(
            (await rpc.read()).active.slice().sort(),
            (version === '1.3.0' ? wanted : initial.active).slice().sort(),
            version === '1.3.0'
              ? 'Pi 1.3 restores the explicitly recorded native loadout'
              : 'Pi 1.2 restores its exact native defaults; Apply is current-runtime only'
          );
          const trace = (await readFile(join(fixture.cwd, 'model-tools-trace.jsonl'), 'utf8'))
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line));
          for (const input of trace) assert.equal(input.source, 'rpc');
          assert.equal(await readFile(fixture.globalSettings, 'utf8'), beforeSettings);
        } finally {
          if (rpc) await shutdown(rpc);
          else await fixture.dispose();
        }
      }
    );

    test(
      `native model tools ${version} ${mode}: CLI allowlist and exclusions cannot be reactivated`,
      { timeout: 12000 },
      async () => {
        const fixture = await createNativeFixture(
          'model-tools',
          version === '1.3.0' ? 'selected-sdk' : 'supported-sdk'
        );
        let rpc: Awaited<ReturnType<typeof connect>> | undefined;
        try {
          rpc = await connect(fixture, mode, version, true);
          const initial = await rpc.read();
          assert.deepEqual(initial.tools.map((tool: any) => tool.name).sort(), [
            'owned_codemode',
            'owned_deferred',
            'owned_direct',
            'owned_model_only',
          ]);
          for (const name of ['read', 'owned_excluded', 'owned_hidden'])
            await assert.rejects(
              rpc.apply(initial.revision, [name]),
              /MODEL_TOOLS_INVALID_SELECTION/
            );
          assert.deepEqual(await rpc.read(), initial);
          assert.equal(fixture.requests, 0);
          assert.deepEqual((await rpc.client.getMessages())!.messages, []);
        } finally {
          if (rpc) await shutdown(rpc);
          else await fixture.dispose();
        }
      }
    );
  }
}
