import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { readFile, writeFile } from 'node:fs/promises';
import {
  createNativeFixture,
  spawnNativeSdkHost,
  resolveNativeCli,
} from '../helpers/nativeFixture';
import { RpcClient } from '../../src/rpc/client';
import { RpcTransport } from '../../src/rpc/transport';

for (const mode of ['shared', 'dedicated'] as const) {
  for (const offline of [false, true]) {
    test(
      `Pi 1.2.0 ${mode}: OpenRouter discovery ${offline ? 'offline' : 'on demand'}`,
      { timeout: 20000 },
      async () => {
        assert.equal((await resolveNativeCli()).version, '1.2.0');
        const fixture = await createNativeFixture('openrouter');
        let child: Awaited<ReturnType<typeof spawnNativeSdkHost>>['child'] | undefined;
        let transport: RpcTransport | undefined;
        try {
          const host = await spawnNativeSdkHost(
            fixture,
            mode,
            offline ? 'openrouter-offline' : 'default'
          );
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
          const client = new RpcClient(1, transport, {
            shortTimeoutMs: 10000,
            longTimeoutMs: 10000,
          });
          child.once('exit', () => opened({ success: false }));
          child.stdin!.write(JSON.stringify({ k: 'one', d: host.open }) + '\n');
          assert.equal((await ready).success, true);
          assert.equal(fixture.requests, 0, 'host startup does not discover models');
          const cached = await client.getAvailableModels();
          assert.deepEqual(cached!.discoveryProviders, ['openrouter']);
          assert.equal(fixture.requests, 0, 'cached picker read does not discover models');
          assert.ok((cached!.models as any[]).some((model) => model.provider === 'openrouter'));
          const [first, concurrent] = await Promise.all([
            client.getAvailableModels(true),
            client.getAvailableModels(true),
          ]);
          if (offline) {
            assert.equal(fixture.requests, 0, 'explicit offline startup suppresses discovery');
            assert.deepEqual(first!.models, cached!.models);
            return;
          }
          assert.equal(
            fixture.requests,
            2,
            'concurrent pickers share one public catalog and one per-key request'
          );
          assert.deepEqual(first!.models, concurrent!.models);
          assert.equal(first!.discoveryError, undefined);
          const openrouter = (first!.models as any[]).filter(
            (model) => model.provider === 'openrouter'
          );
          assert.equal(openrouter.length, 1);
          assert.equal(openrouter[0].id, 'openai/gpt-5-mini');
          assert.equal(openrouter[0].contextWindow, 32000);
          assert.equal(openrouter[0].maxTokens, 777);
          assert.equal(openrouter[0].cost.input, 2);
          assert.equal(openrouter[0].cost.output, 4);
          await client.setModel('openrouter', 'openai/gpt-5-mini');
          assert.equal((await client.getState())!.model?.id, 'openai/gpt-5-mini');
          await client.getAvailableModels();
          assert.equal(fixture.requests, 2, 'ordinary snapshot reads reuse personalized models');
          await writeFile(
            fixture.authFile,
            JSON.stringify({ openrouter: { type: 'api_key', key: 'owned-openrouter-key-two' } })
          );
          const changed = await client.getAvailableModels(true);
          const changedModels = (changed!.models as any[]).filter(
            (model) => model.provider === 'openrouter'
          );
          assert.deepEqual(
            changedModels.map((model) => model.id),
            ['openai/gpt-5-nano'],
            'next refresh uses the new credential-scoped catalog'
          );
          assert.equal(
            fixture.requests,
            4,
            'a later refresh intentionally revalidates both endpoints'
          );
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
}
