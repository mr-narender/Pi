import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PassThrough, Writable } from 'node:stream';
import {
  resolveNativeCli,
  resolveNativeSdkDependency,
  createNativeFixture,
  spawnNativeSdkHost,
} from '../helpers/nativeFixture';
import { RpcClient } from '../../src/rpc/client';
import { RpcTransport } from '../../src/rpc/transport';
import { isSupportedPiSdkVersion, resolvePiLaunch } from '../../src/process/piLauncher';
import { CORE_SLASH_NAMES } from '../../src/commands/coreSlash';

test('current selected supported JS engine is admitted by exact host and launch contracts', async () => {
  const selected = await resolveNativeCli();
  assert.equal(isSupportedPiSdkVersion(selected.version), true);
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
    '1.0.1',
    '1.1.1',
    '1.1.0-next',
    '2.0.0',
    '1.0.0-next',
    '0.99.2-next',
  ])
    assert.throws(() => validateSdkMetadata({ ...metadata, version }), /VERSION_UNSUPPORTED/);
});

test('selected Pi replays signed reasoning before its paired response message', async () => {
  const selected = await resolveNativeCli();
  const { convertResponsesMessages } = await import(
    pathToFileURL(
      await resolveNativeSdkDependency(
        selected.root,
        '@earendil-works/pi-ai/dist/api/openai-responses-shared.js'
      )
    ).href
  );
  const signature = JSON.stringify({
    type: 'reasoning',
    id: 'rs_required',
    encrypted_content: 'opaque',
    summary: [],
  });
  const model = {
    provider: 'azure',
    api: 'azure-openai-responses',
    id: 'gpt-test',
    input: ['text'],
    reasoning: true,
  };
  const replayed = convertResponsesMessages(
    model,
    {
      systemPrompt: '',
      messages: [
        {
          role: 'assistant',
          provider: model.provider,
          api: model.api,
          model: model.id,
          content: [
            { type: 'thinking', thinking: '', thinkingSignature: signature },
            {
              type: 'text',
              text: 'done',
              textSignature: JSON.stringify({ v: 1, id: 'msg_required' }),
            },
          ],
          timestamp: 1,
        },
      ],
      tools: [],
    },
    new Set(['azure']),
    {}
  );
  assert.deepEqual(replayed, [
    JSON.parse(signature),
    {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'done', annotations: [] }],
      status: 'completed',
      id: 'msg_required',
      phase: undefined,
    },
  ]);
});

for (const mode of ['shared', 'dedicated'] as const) {
  test(
    `current supported ${mode}: actual client admits native preferences/scopes/thinking`,
    { timeout: 15000 },
    async () => {
      const fixture = await createNativeFixture('scopes');
      let child: Awaited<ReturnType<typeof spawnNativeSdkHost>>['child'] | undefined;
      let transport: RpcTransport | undefined;
      try {
        const currentModifiers = (await resolveNativeCli()).version === '1.1.0';
        const started = await spawnNativeSdkHost(
          fixture,
          mode,
          currentModifiers ? 'tool-modifiers' : 'default'
        );
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
        const state = await client.getState();
        assert.ok(state?.sessionId);
        if (currentModifiers) {
          const payload = await client.engineCommand(
            'delivery_payload',
            {
              sessionId: state!.sessionId!,
              ...(state!.sessionFile === undefined ? {} : { sessionFile: state!.sessionFile }),
              leafId: (await client.getEntries())?.leafId ?? null,
            },
            { share: true }
          );
          const entries = String(payload?.jsonl)
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line));
          assert.deepEqual(
            entries
              .find((entry) => entry.customType === 'pi.share')
              .data.tools.map((tool: any) => tool.name),
            ['ls'],
            '1.1.0 native modifiers preserve --no-tools and add only the selected read-only tool'
          );
        }
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
