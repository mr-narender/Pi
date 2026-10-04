import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PassThrough, Writable } from 'node:stream';
import {
  resolveNativeCli,
  createNativeFixture,
  spawnNativeSdkHost,
} from '../helpers/nativeFixture';
import { RpcClient } from '../../src/rpc/client';
import { RpcTransport } from '../../src/rpc/transport';
import { resolvePiLaunch } from '../../src/process/piLauncher';
import { CORE_SLASH_NAMES } from '../../src/commands/coreSlash';

test('1.0.1 client admits disposal/engine/export; unreviewed 1.0.2 stays denied', async () => {
  for (const version of ['1.0.1', '1.0.2']) {
    const client = new RpcClient(1, {} as RpcTransport, {
      shortTimeoutMs: 5000,
      longTimeoutMs: 5000,
    });
    const calls: string[] = [];
    (client as any).command = async (type: string) => {
      if (type === 'get_capabilities')
        return {
          protocol: 1,
          sdkVersion: version,
          closeChat: true,
          engineCommands: { contract: 1, get_project_trust: true },
          exports: { jsonl: true },
        };
      calls.push(type);
      return { accepted: true };
    };
    for (const operation of [
      () => client.engineCommand('get_project_trust', {}),
      () => client.exportJsonl('/owned-fixture/export.jsonl'),
      () => client.closeChat(),
    ]) {
      if (version === '1.0.1') assert.deepEqual(await operation(), { accepted: true });
      else await assert.rejects(operation);
    }
    assert.deepEqual(
      calls,
      version === '1.0.1' ? ['get_project_trust', 'export_jsonl', 'close_chat'] : []
    );
  }
});

test('current selected 1.0.1 JS engine is admitted by exact host and launch contracts', async () => {
  const selected = await resolveNativeCli();
  assert.equal(selected.version, '1.0.1');
  const { validateSdkMetadata } = await import(
    pathToFileURL(resolve('host/startup-adapter.mjs')).href
  );
  const metadata = JSON.parse(await readFile(join(selected.root, 'package.json'), 'utf8'));
  validateSdkMetadata(metadata);
  const launch = resolvePiLaunch({
    piSource: 'external',
    executable: selected.cli,
    launchShell: '',
  } as any);
  assert.equal(launch.sdkRoot, selected.root);
  for (const version of [
    '0.99.0',
    '0.99.3',
    '0.100.0',
    '1.0.2',
    '2.0.0',
    '1.0.0-next',
    '0.99.2-next',
  ])
    assert.throws(() => validateSdkMetadata({ ...metadata, version }), /VERSION_UNSUPPORTED/);
});

for (const mode of ['shared', 'dedicated'] as const) {
  test(
    `current 1.0.1 ${mode}: actual client admits native preferences/scopes/thinking`,
    { timeout: 15000 },
    async () => {
      const fixture = await createNativeFixture('scopes');
      let child: Awaited<ReturnType<typeof spawnNativeSdkHost>>['child'] | undefined;
      let transport: RpcTransport | undefined;
      try {
        const started = await spawnNativeSdkHost(fixture, mode);
        child = started.child;
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
          maxRecordBytes: 1_000_000,
          maxBufferBytes: 1_000_000,
          maxPendingRequests: 64,
          maxQueuedWrites: 64,
        });
        const client = new RpcClient(1, transport, { shortTimeoutMs: 5000, longTimeoutMs: 5000 });
        child.stdin!.write(JSON.stringify({ k: 'one', d: started.open }) + '\n');
        child.once('exit', () => opened({ success: false }));
        assert.equal((await ready).success, true);
        const preferences = await client.getPreferences();
        assert.ok(preferences.rows.some((row) => row.key === 'blockImages'));
        assert.equal((await client.getScopedModels()).models.length, 3);
        assert.deepEqual((await client.getThinkingCapabilities()).levels, ['off']);
        assert.ok((await client.getState())?.sessionId);
        assert.equal(fixture.requests, 0);
        assert.equal(await readFile(fixture.networkLog, 'utf8'), '');
      } finally {
        transport?.disconnect(new Error('owned test shutdown'));
        if (child && child.exitCode === null && child.signalCode === null) {
          const exited = new Promise((resolve) => child!.once('exit', resolve));
          child.kill('SIGKILL');
          await exited;
        }
        await fixture.dispose();
      }
    }
  );
}

test('current native 24 advertised plus 3 hidden TUI commands match the existing 27 reservations', async () => {
  const selected = await resolveNativeCli();
  const source = await readFile(join(selected.root, 'dist/core/slash-commands.js'), 'utf8');
  const advertised = [...source.matchAll(/name: "([^"]+)"/g)].map((m) => m[1]!);
  assert.equal(advertised.length, 24);
  const interactive = await readFile(
    join(selected.root, 'dist/modes/interactive/interactive-mode.js'),
    'utf8'
  );
  const hidden = ['debug', 'arminsayshi', 'dementedelves'];
  for (const name of hidden) assert.ok(interactive.includes(`"/${name}"`), name);
  assert.deepEqual([...advertised, ...hidden].sort(), [...CORE_SLASH_NAMES].sort());
});
