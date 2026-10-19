import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { RpcClient } from '../../src/rpc/client';
import { RpcTransport } from '../../src/rpc/transport';
import type { ExtensionUiRequest } from '../../src/rpc/protocol';
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
    assert.ok(Date.now() < deadline, 'Owned native extension UI event timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function connect(
  fixture: NativeFixture,
  mode: 'shared' | 'dedicated',
  version: string
): Promise<SpawnedRpc> {
  const selected = await resolveNativeCli(version === '1.3.0' ? 'path-cli' : 'supported-sdk');
  assert.equal(selected.version, version);
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
      if (k !== 'extension-ui-owned') continue;
      if (d.command === 'open') opened(d);
      else output.write(JSON.stringify(d) + '\n');
    }
  });
  const input = new Writable({
    write(chunk, _encoding, callback) {
      child.stdin.write(
        JSON.stringify({ k: 'extension-ui-owned', d: JSON.parse(String(chunk)) }) + '\n',
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
  child.stdin.write(JSON.stringify({ k: 'extension-ui-owned', d: host.open }) + '\n');
  if (!(await ready).success) {
    await shutdown(rpc);
    throw new Error('Owned extension UI host failed to open');
  }
  try {
    assert.equal((await client.getCapabilities())!.sdkVersion, version);
  } catch (error) {
    await shutdown(rpc);
    throw error;
  }
  return rpc;
}

for (const version of ['1.2.0', '1.3.0']) {
  for (const mode of ['shared', 'dedicated'] as const) {
    test(
      `native extension UI ${version} ${mode}: cancel, timeout, synchronous getter limits and terminal-only custom UI`,
      { timeout: 20000 },
      async () => {
        const fixture = await createNativeFixture(
          'extension-ui',
          version === '1.3.0' ? 'selected-sdk' : 'supported-sdk'
        );
        let rpc: SpawnedRpc | undefined;
        try {
          rpc = await connect(fixture, mode, version);
          const client = rpc.client;
          const requests: ExtensionUiRequest[] = [];
          client.onExtensionUi((request) => requests.push(request));
          const trace = async (): Promise<any[]> =>
            (await readFile(join(fixture.cwd, 'extension-ui-trace.jsonl'), 'utf8').catch(() => ''))
              .trim()
              .split('\n')
              .filter(Boolean)
              .map((line) => JSON.parse(line));
          const settings = await readFile(fixture.globalSettings, 'utf8');
          const cancel = async (command: string, title: string, method: string) => {
            const start = requests.length;
            const pending = client.prompt(`/${command}`);
            await until(() => requests.slice(start).some((request) => request.title === title));
            const request = requests.slice(start).find((request) => request.title === title)!;
            assert.equal(request.method, method);
            await client.respondExtensionUi({ id: request.id, cancelled: true });
            assert.equal((await pending)!.disposition, 'handled');
            return request;
          };
          const input = await cancel('owned-ui-input', 'Owned input', 'input');
          const selected = await cancel('owned-ui-select', 'Owned select', 'select');
          assert.deepEqual(selected.options, ['Owned A', 'Owned B']);
          const editor = await cancel('owned-ui-editor', 'Owned editor', 'editor');
          assert.equal(editor.prefill, 'Owned prefill');
          await client.prompt('/owned-ui-input-pre-aborted');
          assert.ok(!requests.some((request) => request.title === 'Owned pre-aborted input'));

          for (const [command, title, reason] of [
            ['owned-ui-input-timeout', 'Owned timeout input', 'timeout'],
            ['owned-ui-select-timeout', 'Owned timeout select', 'timeout'],
            ['owned-ui-input-abort', 'Owned abort input', 'aborted'],
          ]) {
            const start = requests.length;
            const pending = client.prompt(`/${command}`);
            await until(() => requests.slice(start).some((request) => request.title === title));
            const request = requests.slice(start).find((request) => request.title === title)!;
            assert.equal((await pending)!.disposition, 'handled');
            await until(() =>
              requests
                .slice(start)
                .some((value) => value.method === 'cancel' && value.requestId === request.id)
            );
            const cancellation = requests
              .slice(start)
              .find((value) => value.method === 'cancel' && value.requestId === request.id)!;
            assert.equal(cancellation.reason, reason);
            assert.notEqual(cancellation.id, request.id);
            await client.respondExtensionUi({
              id: request.id,
              value: 'late answer must be ignored',
            });
            await client.getState();
          }
          const writeStart = requests.length;
          assert.equal((await client.prompt('/owned-ui-write'))!.disposition, 'handled');
          await until(() =>
            requests.slice(writeStart).some((request) => request.method === 'set_editor_text')
          );
          assert.equal(
            requests.slice(writeStart).find((request) => request.method === 'set_editor_text')!
              .text,
            'Owned proposed text'
          );
          await client.prompt('/owned-ui-read');
          const writes = (await trace()).find((row) => row.kind === 'editor-write');
          assert.deepEqual(
            writes,
            { kind: 'editor-write', before: '', after: '' },
            'RPC getter remains honestly unsupported, not a claimed synchronous GUI mirror'
          );
          assert.equal((await trace()).find((row) => row.kind === 'editor-read').text, '');

          const customStart = requests.length;
          assert.equal((await client.prompt('/owned-ui-custom'))!.disposition, 'handled');
          await until(() =>
            requests
              .slice(customStart)
              .some(
                (request) =>
                  request.method === 'unsupported_ui' && request.uiCapability === 'custom'
              )
          );
          const custom = requests
            .slice(customStart)
            .find(
              (request) => request.method === 'unsupported_ui' && request.uiCapability === 'custom'
            )!;
          assert.match(custom.message!, /terminal|TUI/i);
          await client.prompt('/owned-ui-status');
          assert.ok(
            requests.some(
              (request) => request.method === 'setStatus' && request.statusKey === 'owned-status'
            )
          );
          assert.ok(
            requests.some(
              (request) => request.method === 'setWidget' && request.widgetKey === 'owned-widget'
            )
          );
          assert.ok(
            requests.some(
              (request) => request.method === 'setTitle' && request.title === 'Owned title'
            )
          );
          const widgetStart = requests.length;
          await client.prompt('/owned-ui-widget-factory');
          await until(() =>
            requests
              .slice(widgetStart)
              .some(
                (request) =>
                  request.method === 'unsupported_ui' && request.uiCapability === 'widget'
              )
          );
          assert.ok(
            !requests
              .slice(widgetStart)
              .some(
                (request) => request.method === 'setWidget' && request.widgetKey === 'owned-widget'
              ),
            'an unsupported widget factory does not erase the existing visible text widget'
          );
          const recorded = await trace();
          assert.ok(!recorded.some((row) => row.kind === 'custom-factory-executed'));
          assert.ok(!recorded.some((row) => row.kind === 'widget-factory-executed'));
          assert.equal(recorded.find((row) => row.kind === 'custom-result').value, null);
          for (const kind of [
            'input-result',
            'select-result',
            'editor-result',
            'abort-result',
            'pre-aborted-result',
          ]) {
            assert.ok(recorded.some((row) => row.kind === kind));
            assert.ok(
              recorded.filter((row) => row.kind === kind).every((row) => row.value === null)
            );
          }
          assert.equal(
            recorded.filter((row) => row.kind === 'input-result').length,
            2,
            'late answers never invoke a completed native callback again'
          );
          for (const answered of [input, selected, editor])
            assert.ok(
              !requests.some(
                (request) => request.method === 'cancel' && request.requestId === answered.id
              ),
              'an answered dialog does not later time out or abort'
            );
          for (const input of recorded.filter((row) => row.kind === 'input'))
            assert.equal(input.source, 'rpc');
          assert.equal(fixture.requests, 0);
          assert.deepEqual((await client.getMessages())!.messages, []);
          assert.equal(await readFile(fixture.globalSettings, 'utf8'), settings);
          const closingStart = requests.length;
          const closing = client.prompt('/owned-ui-editor');
          void closing.catch(() => {});
          await until(() =>
            requests.slice(closingStart).some((request) => request.method === 'editor')
          );
          const closingRequest = requests
            .slice(closingStart)
            .find((request) => request.method === 'editor')!;
          rpc.child.stdin.write(
            JSON.stringify({ k: 'extension-ui-owned', d: { type: 'close' } }) + '\n'
          );
          await until(() =>
            requests
              .slice(closingStart)
              .some(
                (request) => request.method === 'cancel' && request.requestId === closingRequest.id
              )
          );
          assert.equal(
            requests
              .slice(closingStart)
              .filter(
                (request) => request.method === 'cancel' && request.requestId === closingRequest.id
              ).length,
            1
          );
          assert.equal(
            requests
              .slice(closingStart)
              .find(
                (request) => request.method === 'cancel' && request.requestId === closingRequest.id
              )!.reason,
            'closed'
          );
          await closing;
          assert.equal((await trace()).filter((row) => row.kind === 'editor-result').length, 2);
        } finally {
          if (rpc) await shutdown(rpc);
          else await fixture.dispose();
        }
      }
    );
  }
}

test(
  'native extension UI startup: callback receives an answer before open acknowledgement',
  { timeout: 15000 },
  async () => {
    const fixture = await createNativeFixture('startup-ui', 'selected-sdk');
    let rpc: SpawnedRpc | undefined;
    let emitted = 0;
    try {
      const selected = await resolveNativeCli('path-cli');
      assert.equal(selected.version, '1.3.0');
      const plan = await nativeSdkHostPlan(fixture, 'shared');
      assert.equal(plan.env.PI_HOST_PI_ROOT, selected.root);
      const host = await spawnNativeSdkHost(fixture, 'shared');
      const child = host.child as SpawnedRpc['child'];
      const transport = new RpcTransport(child.stdin, child.stdout, child.stderr, {
        maxRecordBytes: 1000000,
        maxBufferBytes: 1000000,
        maxPendingRequests: 64,
        maxQueuedWrites: 64,
      });
      const client = new RpcClient(1, transport, { shortTimeoutMs: 10000, longTimeoutMs: 15000 });
      rpc = { child, transport, client, fixture, cwd: fixture.cwd };
      // Startup envelopes are handled directly before feeding them to RpcClient:
      // a missing-runner error is itself the regression being characterized.
      transport.disconnect(new Error('Owned raw startup characterization'));
      let buffer = '';
      let opened = false;
      const wireErrors: string[] = [];
      child.stdout.on('data', (chunk) => {
        buffer += chunk;
        let index;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const { k, d } = JSON.parse(buffer.slice(0, index));
          buffer = buffer.slice(index + 1);
          if (k !== 'startup-ui-owned') continue;
          if (d.command === 'open') {
            opened = d.success === true;
            continue;
          }
          if (d.error) wireErrors.push(d.error);
          if (
            d.type !== 'extension_ui_request' ||
            d.method !== 'input' ||
            d.title !== 'Owned startup input'
          )
            continue;
          emitted++;
          child.stdin.write(
            JSON.stringify({
              k,
              d: { type: 'extension_ui_response', id: d.id, value: 'Owned startup answer' },
            }) + '\n'
          );
        }
      });
      child.stdin.write(JSON.stringify({ k: 'startup-ui-owned', d: host.open }) + '\n');
      await until(() => opened);
      assert.equal(emitted, 1, 'the startup handler emitted exactly one native dialog');
      assert.deepEqual(
        wireErrors,
        [],
        'startup dialog responses must reach a registered native runner'
      );
      const recorded = JSON.parse(
        (await readFile(join(fixture.cwd, 'startup-ui-trace.jsonl'), 'utf8')).trim()
      );
      assert.equal(
        recorded.value,
        'Owned startup answer',
        'startup answers must reach the pending native callback before the open acknowledgement'
      );
      assert.equal(fixture.requests, 0);
    } finally {
      if (rpc) await shutdown(rpc);
      else await fixture.dispose();
    }
  }
);

test(
  'native extension UI startup: closing cancels the callback without acknowledging an orphan',
  { timeout: 15000 },
  async () => {
    const fixture = await createNativeFixture('startup-ui', 'selected-sdk');
    const host = await spawnNativeSdkHost(fixture, 'shared');
    const child = host.child as SpawnedRpc['child'];
    const output = new PassThrough();
    const transport = new RpcTransport(
      new Writable({
        write(_chunk, _encoding, done) {
          done();
        },
      }),
      output,
      child.stderr,
      {
        maxRecordBytes: 1000000,
        maxBufferBytes: 1000000,
        maxPendingRequests: 64,
        maxQueuedWrites: 64,
      }
    );
    const rpc = {
      child,
      transport,
      client: new RpcClient(1, transport, { shortTimeoutMs: 10000, longTimeoutMs: 15000 }),
      fixture,
      cwd: fixture.cwd,
    };
    let buffer = '',
      requestId = '',
      pinged = false;
    const replies: any[] = [];
    try {
      child.stdout.on('data', (chunk) => {
        buffer += chunk;
        let index;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const { k, d } = JSON.parse(buffer.slice(0, index));
          buffer = buffer.slice(index + 1);
          if (k !== 'startup-ui-close') continue;
          replies.push(d);
          if (d.type === 'extension_ui_request' && d.method === 'input') {
            requestId = d.id;
            child.stdin.write(JSON.stringify({ k, d: { type: 'close' } }) + '\n');
          }
          if (d.command === 'ping') pinged = true;
        }
      });
      child.stdin.write(JSON.stringify({ k: 'startup-ui-close', d: host.open }) + '\n');
      await until(() => replies.some((d) => d.method === 'cancel' && d.requestId === requestId));
      await until(
        async () =>
          !!(await readFile(join(fixture.cwd, 'startup-ui-trace.jsonl'), 'utf8').catch(() => ''))
      );
      child.stdin.write(JSON.stringify({ k: 'startup-ui-close', d: { type: 'ping' } }) + '\n');
      await until(() => pinged);
      assert.equal(
        replies.filter((d) => d.method === 'cancel' && d.requestId === requestId).length,
        1
      );
      assert.equal(replies.find((d) => d.method === 'cancel').reason, 'closed');
      assert.ok(!replies.some((d) => d.command === 'open' && d.success === true));
      assert.equal(
        JSON.parse((await readFile(join(fixture.cwd, 'startup-ui-trace.jsonl'), 'utf8')).trim())
          .value,
        null
      );
      assert.equal(fixture.requests, 0);
    } finally {
      await shutdown(rpc);
    }
  }
);
