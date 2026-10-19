import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createNativeFixture,
  nativeSdkHostPlan,
  resolveNativeCli,
  spawnNativeSdkHost,
  spawnNativePublicAuth,
  type NativeFixture,
} from '../helpers/nativeFixture';
import { shutdown, type SpawnedRpc } from '../helpers/rpc';
import { RpcClient } from '../../src/rpc/client';
import { RpcTransport } from '../../src/rpc/transport';
import { parseMcpStatus } from '../../src/mcp/status';
import type {
  ExtensionUiRequest,
  JsonObject,
  RpcCommandType,
  RpcEvent,
} from '../../src/rpc/protocol';

type Scenario = Parameters<typeof spawnNativeSdkHost>[2];

async function until(predicate: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 12000;
  while (!(await predicate())) {
    assert.ok(Date.now() < deadline, 'Pi 1.3 native event timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test(
  'Pi 1.3: owned public OAuth login, logout and cancellation use the selected SDK',
  { timeout: 15000 },
  async () => {
    const owned = await fixture('scopes');
    let child: Awaited<ReturnType<typeof spawnNativePublicAuth>> | undefined;
    try {
      child = await spawnNativePublicAuth(owned);
      let output = '';
      child.stdout!.on('data', (chunk) => {
        output += chunk;
      });
      const exit = await new Promise<number | null>((resolve) => child!.once('exit', resolve));
      assert.equal(exit, 0);
      assert.deepEqual(JSON.parse(output.trim()), {
        oauthStore: true,
        logout: true,
        cancel: true,
        secretWire: false,
      });
      assert.equal(owned.requests, 0);
      assert.equal((await readFile(owned.networkLog, 'utf8')).trim(), '');
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await owned.dispose();
    }
  }
);

async function fixture(profile: Parameters<typeof createNativeFixture>[0]) {
  assert.equal((await resolveNativeCli('path-cli')).version, '1.3.0');
  return createNativeFixture(profile, 'selected-sdk');
}

async function connect(
  owned: NativeFixture,
  mode: 'shared' | 'dedicated',
  scenario: Scenario = 'default'
) {
  const selected = await resolveNativeCli('path-cli');
  const plan = await nativeSdkHostPlan(owned, mode, scenario);
  assert.equal(plan.env.PI_HOST_PI_ROOT, selected.root);
  assert.equal(plan.env.PI_HOST_DEDICATED, mode === 'dedicated' ? '1' : '0');
  const host = await spawnNativeSdkHost(owned, mode, scenario);
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
      if (k !== 'pi13-owned') continue;
      if (d.command === 'open') opened(d);
      else output.write(JSON.stringify(d) + '\n');
    }
  });
  const input = new Writable({
    write(chunk, _encoding, callback) {
      child.stdin.write(
        JSON.stringify({ k: 'pi13-owned', d: JSON.parse(String(chunk)) }) + '\n',
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
  child.stdin.write(JSON.stringify({ k: 'pi13-owned', d: host.open }) + '\n');
  const opening = await ready;
  if (!opening.success) {
    await shutdown({ child, client, transport, fixture: owned, cwd: owned.cwd });
    throw new Error(opening.error ?? 'Pi 1.3 SDK host failed to open');
  }
  let sequence = 0;
  const request = async (type: RpcCommandType, extra: JsonObject = {}) => {
    const reply = await transport.request({ type, ...extra, id: `pi13-raw-${++sequence}` });
    if (!reply.success) throw new Error(reply.error);
    return reply.data as JsonObject;
  };
  const capabilities = await request('get_capabilities');
  assert.equal(capabilities.sdkVersion, '1.3.0');
  assert.equal((capabilities.engineCommands as JsonObject).reload_session, mode === 'dedicated');
  const origin = async () => {
    const state = await client.getState();
    return {
      sessionId: state!.sessionId,
      sessionFile: state!.sessionFile,
      leafId: (await client.getEntries())!.leafId,
    };
  };
  const openAnother = async () => {
    let extraBuffer = '';
    let reply: any;
    const receive = (chunk: Buffer) => {
      extraBuffer += chunk;
      let index;
      while ((index = extraBuffer.indexOf('\n')) >= 0) {
        const line = JSON.parse(extraBuffer.slice(0, index));
        extraBuffer = extraBuffer.slice(index + 1);
        if (line.k === 'pi13-extra' && line.d.command === 'open') reply = line.d;
      }
    };
    child.stdout.on('data', receive);
    try {
      child.stdin.write(JSON.stringify({ k: 'pi13-extra', d: host.open }) + '\n');
      await until(() => reply !== undefined);
      return reply;
    } finally {
      child.stdout.off('data', receive);
    }
  };
  return {
    child,
    client,
    transport,
    fixture: owned,
    cwd: owned.cwd,
    request,
    origin,
    openAnother,
    open: host.open,
  };
}

async function savedSession(owned: NativeFixture) {
  const file = join(owned.cwd, 'pi13-owned-session.jsonl');
  const timestamp = '2024-01-01T00:00:00.000Z';
  const rows = [
    { type: 'session', version: 3, id: 'pi13-saved-session', timestamp, cwd: owned.cwd },
    {
      type: 'model_change',
      id: 'model',
      parentId: null,
      timestamp,
      provider: 'fixture-alpha',
      modelId: 'ping',
    },
    {
      type: 'message',
      id: 'system',
      parentId: 'model',
      timestamp,
      message: {
        role: 'system',
        content: 'Owned saved instructions',
        timestamp: 1,
        toolsAdded: ['read', 'vscode_diagnostics'].map((name) => ({
          name,
          description: 'Owned recorded tool',
          parameters: { type: 'object', properties: {} },
        })),
      },
    },
    {
      type: 'message',
      id: 'user',
      parentId: 'system',
      timestamp,
      message: { role: 'user', content: 'Owned saved user question', timestamp: 2 },
    },
  ];
  await writeFile(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  return file;
}

for (const mode of ['shared', 'dedicated'] as const) {
  test(
    `Pi 1.3 ${mode}: switching models omits old thinking from the provider request and retains history`,
    { timeout: 15000 },
    async () => {
      const owned = await fixture('startup');
      let rpc: Awaited<ReturnType<typeof connect>> | undefined;
      try {
        const file = await savedSession(owned);
        const rows = (await readFile(file, 'utf8'))
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line));
        rows.push({
          type: 'message',
          id: 'old-answer',
          parentId: 'user',
          timestamp: '2024-01-01T00:00:01.000Z',
          message: {
            role: 'assistant',
            api: 'openai-completions',
            provider: 'fixture-beta',
            model: 'ping',
            stopReason: 'stop',
            timestamp: 3,
            content: [
              { type: 'thinking', thinking: 'OWNED PREVIOUS MODEL THINKING' },
              { type: 'text', text: 'Owned previous visible answer' },
            ],
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
          },
        });
        await writeFile(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
        rpc = await connect(owned, mode);
        await rpc.client.replaceChat('resume', file, await rpc.origin());
        await rpc.client.setModel('fixture-alpha', 'ping');
        assert.equal((await rpc.client.getState())!.model!.provider, 'fixture-alpha');
        const events: RpcEvent[] = [];
        rpc.client.onEvent((event) => events.push(event));
        await rpc.client.prompt('owned Pi 1.3 answer with the selected model');
        await until(() => events.some((event) => event.type === 'agent_settled'));
        assert.equal(owned.summaryRequests.length, 1);
        const payload = JSON.stringify(owned.summaryRequests[0]);
        assert.ok(
          !payload.includes('OWNED PREVIOUS MODEL THINKING'),
          'old-model thinking stays out of the next provider request'
        );
        assert.ok(payload.includes('Owned previous visible answer'));
        assert.ok(
          JSON.stringify((await rpc.client.getMessages())!.messages).includes(
            'OWNED PREVIOUS MODEL THINKING'
          ),
          'original reasoning remains in local history'
        );
      } finally {
        if (rpc) await shutdown(rpc);
        else await owned.dispose();
      }
    }
  );

  test(
    `Pi 1.3 ${mode}: startup cancellation and extension-triggered completion remain coherent`,
    { timeout: 30000 },
    async () => {
      const owned = await fixture('startup');
      let rpc: Awaited<ReturnType<typeof connect>> | undefined;
      try {
        rpc = await connect(owned, mode);
        const events: RpcEvent[] = [];
        rpc.client.onEvent((event) => events.push(event));
        const traceFile = join(owned.cwd, 'startup-trace.jsonl');
        const trace = async () =>
          (await readFile(traceFile, 'utf8').catch(() => ''))
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line));
        const starting = rpc.client.prompt('owned start-block Pi 1.3 cancel');
        await until(async () =>
          (await trace()).some((event) => event.type === 'before_agent_start')
        );
        assert.equal((await rpc.client.getState())!.isStreaming, true);
        const stopping = rpc.client.abort();
        await rpc.client.getState();
        await writeFile(join(owned.cwd, 'startup-release'), 'release');
        await starting;
        await stopping;
        await until(() => events.some((event) => event.type === 'agent_settled'));
        assert.equal(events.find((event) => event.type === 'agent_settled')!.aborted, true);
        assert.equal(owned.requests, 0);
        for (const event of (await trace()).filter((entry) => entry.type === 'input'))
          assert.equal(event.source, 'rpc');
        await rpc.client.replaceChat('new', undefined, await rpc.origin());
        events.length = 0;
        await rpc.client.prompt('/owned-custom');
        await until(() => events.some((event) => event.type === 'agent_settled'));
        assert.equal(events.find((event) => event.type === 'agent_settled')!.aborted, false);
        const custom = (await trace()).find((event) => event.messageType === 'custom');
        assert.equal(custom.hasPrompt, false);
        assert.equal(custom.idle, false);
      } finally {
        if (rpc) await shutdown(rpc);
        else await owned.dispose();
      }
    }
  );

  test(
    `Pi 1.3 ${mode}: ambiguous CLI model fails locally and qualified provider succeeds`,
    { timeout: 15000 },
    async () => {
      const ambiguous = await fixture('scopes');
      try {
        await assert.rejects(
          connect(ambiguous, mode, 'model-ambiguous'),
          /SDK_STARTUP_MODEL_AMBIGUOUS/
        );
      } finally {
        await ambiguous.dispose();
      }
      const qualified = await fixture('scopes');
      let rpc: Awaited<ReturnType<typeof connect>> | undefined;
      try {
        rpc = await connect(qualified, mode, 'parity');
        assert.equal((await rpc.client.getState())!.model!.provider, 'fixture-beta');
        assert.equal(qualified.requests, 0);
      } finally {
        if (rpc) await shutdown(rpc);
        else await qualified.dispose();
      }
    }
  );

  test(
    `Pi 1.3 ${mode}: selected SDK MCP status, native trust and private parser`,
    { timeout: 30000 },
    async () => {
      const owned = await fixture('mcp-status');
      let rpc: Awaited<ReturnType<typeof connect>> | undefined;
      try {
        rpc = await connect(owned, mode);
        const before = await rpc.client.getEntries();
        const status = parseMcpStatus(
          await rpc.client.engineCommand('mcp_status', await rpc.origin())
        );
        assert.equal(status.status, 'checked');
        assert.deepEqual(
          status.servers.map(({ name, state, tools }) => ({ name, state, tools })),
          [
            { name: 'owned-connected', state: 'connected', tools: 1 },
            { name: 'owned-failed', state: 'failed', tools: undefined },
            { name: 'owned-disabled', state: 'disabled', tools: undefined },
          ]
        );
        assert.doesNotMatch(status.details!, /owned-project-only|https?:\/\//);
        assert.deepEqual(await rpc.client.getEntries(), before);
        assert.deepEqual((await rpc.client.getMessages())!.messages, []);
        assert.equal(owned.summaryRequests.length, 0);
        const additional = await rpc.openAnother();
        if (mode === 'dedicated') {
          assert.equal(additional.success, false);
          assert.match(additional.error, /DEDICATED_SINGLE_SESSION/);
        } else {
          assert.equal(additional.success, true);
          assert.deepEqual(await rpc.client.getEntries(), before);
        }
        await assert.rejects(
          rpc.client.engineCommand('mcp_status', {
            ...(await rpc.origin()),
            sessionId: 'other-chat',
          }),
          /STALE_ORIGIN/
        );
      } finally {
        if (rpc) await shutdown(rpc);
        else await owned.dispose();
      }
    }
  );

  test(
    `Pi 1.3 ${mode}: IDE resources, RPC source, completion timing and cancellation`,
    { timeout: 30000 },
    async () => {
      const owned = await fixture('ide-tools');
      let rpc: Awaited<ReturnType<typeof connect>> | undefined;
      try {
        rpc = await connect(owned, mode);
        const events: RpcEvent[] = [];
        const queries: ExtensionUiRequest[] = [];
        let respond = true;
        rpc.client.onEvent((event) => events.push(event));
        rpc.client.onExtensionUi((query) => {
          if (query.title !== 'pi-vscode-ide-v1') return;
          queries.push(query);
          if (respond)
            void rpc!.client.respondExtensionUi({
              id: query.id,
              value: JSON.stringify({
                vscodeIde: 1,
                operation: JSON.parse(query.placeholder!).operation,
                status: 'ok',
                locations: [],
              }),
            });
        });
        await rpc.client.prompt('owned Pi 1.3 IDE queries');
        await until(() => events.some((event) => event.type === 'agent_settled'));
        assert.equal(queries.length, 4);
        assert.equal(events.filter((event) => event.type === 'tool_execution_end').length, 4);
        const results = ((await rpc.client.getMessages())!.messages as any[]).filter(
          (message) => message.role === 'toolResult'
        );
        assert.equal(results.length, 4);
        for (const result of results) assert.equal(JSON.parse(result.content[0].text).status, 'ok');
        assert.equal(
          (events.find((event) => event.type === 'agent_settled') as any).aborted,
          false
        );
        for (const event of events.filter((event) => event.type === 'tool_execution_end'))
          assert.ok(Number.isFinite(event.durationMs));
        assert.equal(owned.requests, 2, 'only the owned local provider served the turn');
        const pid = rpc.child.pid;
        await rpc.client.replaceChat('new', undefined, await rpc.origin());
        assert.equal(rpc.child.pid, pid, 'new chat reuses the already warm SDK host');
        respond = false;
        events.length = 0;
        queries.length = 0;
        await rpc.client.prompt('owned Pi 1.3 cancelled IDE queries');
        await until(() => queries.length > 0);
        await rpc.client.abort();
        await until(() => events.some((event) => event.type === 'agent_settled'));
        assert.equal((events.find((event) => event.type === 'agent_settled') as any).aborted, true);
        for (const query of queries)
          await rpc.client.respondExtensionUi({ id: query.id, value: '{"late":true}' });
        assert.equal((await rpc.client.getState())!.isStreaming, false);
        const trace = (await readFile(join(owned.cwd, 'ide-native-trace.jsonl'), 'utf8'))
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line));
        assert.ok(trace.length >= 2);
        for (const input of trace) assert.equal(input.source, 'rpc');
      } finally {
        if (rpc) await shutdown(rpc);
        else await owned.dispose();
      }
    }
  );

  test(
    `Pi 1.3 ${mode}: persisted loadout resumes with exact CLI precedence`,
    { timeout: 30000 },
    async () => {
      const expected = {
        'loadout-default': ['read', 'vscode_diagnostics'],
        'loadout-modifiers': ['ls', 'vscode_diagnostics'],
        'loadout-explicit': ['read'],
        'loadout-none': [],
        'loadout-no-builtin': [
          'vscode_definitions',
          'vscode_diagnostics',
          'vscode_document_symbols',
          'vscode_references',
        ],
        'loadout-excluded': ['read'],
      };
      for (const [scenario, names] of Object.entries(expected)) {
        const owned = await fixture('ide-tools');
        let rpc: Awaited<ReturnType<typeof connect>> | undefined;
        try {
          const file = await savedSession(owned);
          rpc = await connect(owned, mode, scenario as Scenario);
          await rpc.client.replaceChat('resume', file, await rpc.origin());
          assert.equal((await rpc.client.getState())!.sessionFile, file);
          let active: string[] | undefined;
          rpc.client.onExtensionUi((query) => {
            if (query.method !== 'notify' || !query.message?.includes('"active"')) return;
            active = JSON.parse(query.message).active;
          });
          await rpc.client.prompt('/owned-ide-tools');
          await until(() => active !== undefined);
          assert.deepEqual(active!.sort(), names, scenario);
          assert.equal(owned.requests, 0);
          assert.ok(
            ((await rpc.client.getMessages())!.messages as any[]).some(
              (message) => message.content === 'Owned saved user question'
            )
          );
        } finally {
          if (rpc) await shutdown(rpc);
          else await owned.dispose();
        }
      }
    }
  );

  test(
    `Pi 1.3 ${mode}: model ambiguity, thinking, preferences, auth metadata and same JSONL lifecycle`,
    { timeout: 30000 },
    async () => {
      const owned = await fixture('scopes');
      let rpc: Awaited<ReturnType<typeof connect>> | undefined;
      try {
        const settings = JSON.parse(await readFile(owned.globalSettings, 'utf8'));
        settings.enabledModels = ['ping'];
        await writeFile(owned.globalSettings, JSON.stringify(settings));
        const models = JSON.parse(await readFile(owned.modelsFile, 'utf8'));
        for (const provider of Object.values(models.providers) as any[])
          for (const model of provider.models) model.reasoning = true;
        await writeFile(owned.modelsFile, JSON.stringify(models));
        const file = await savedSession(owned);
        rpc = await connect(owned, mode);
        const scope = await rpc.client.getScopedModels();
        assert.ok(scope.diagnostics.some((entry) => entry.code === 'ambiguous'));
        assert.deepEqual(scope.scoped.map((entry) => entry.provider).sort(), [
          'fixture-alpha',
          'fixture-beta',
        ]);
        await rpc.client.setModel('fixture-beta', 'ping');
        const thinking = await rpc.client.getThinkingCapabilities();
        assert.ok(thinking.levels.includes('high'));
        await rpc.client.setThinkingLevel('high', thinking.revision);
        assert.equal((await rpc.client.getState())!.thinkingLevel, 'high');
        const preferences = await rpc.client.getPreferences();
        const saved = await rpc.client.savePreference('retry', true, preferences.revision, false);
        assert.equal(saved.rows.find((row) => row.key === 'retry')!.active, true);
        const providers = await rpc.client.engineCommand('auth_providers', await rpc.origin());
        assert.ok(Array.isArray(providers!.providers));
        await rpc.client.replaceChat('resume', file, await rpc.origin());
        assert.equal((await rpc.client.getState())!.sessionFile, file);
        const original = await readFile(file, 'utf8');
        const tree = await rpc.client.getTree();
        assert.ok(Array.isArray(tree!.tree));
        const output = join(owned.cwd, 'pi13-copy.jsonl');
        await rpc.client.exportJsonl(output, await rpc.origin());
        assert.match(await readFile(output, 'utf8'), /Owned saved user question/);
        const html = join(owned.cwd, 'pi13-copy.html');
        await rpc.client.exportHtml(html, await rpc.origin());
        const encoded = /id="session-data"[^>]*>([A-Za-z0-9+/=]+)</.exec(
          await readFile(html, 'utf8')
        );
        assert.ok(encoded, 'HTML export embeds native session data');
        assert.ok(
          Buffer.from(encoded[1]!, 'base64').toString().includes('Owned saved user question')
        );
        const prepared = await rpc.client.engineCommand('import_prepare', await rpc.origin(), {
          sessionPath: output,
        });
        await rpc.client.replaceChat('import', prepared!.nonce as string, await rpc.origin());
        assert.match(
          JSON.stringify((await rpc.client.getMessages())!.messages),
          /Owned saved user question/
        );
        const old = await rpc.origin();
        await rpc.client.replaceChat('new', undefined, old);
        assert.notEqual((await rpc.client.getState())!.sessionId, old.sessionId);
        await assert.rejects(rpc.client.replaceChat('resume', file, old), /STALE_ORIGIN/);
        await rpc.client.replaceChat('resume', file, await rpc.origin());
        assert.equal((await rpc.client.getState())!.sessionFile, file);
        assert.equal(await readFile(file, 'utf8'), original);
        assert.equal(owned.requests, 0);
      } finally {
        if (rpc) await shutdown(rpc);
        else await owned.dispose();
      }
    }
  );

  for (const offline of [false, true]) {
    test(
      `Pi 1.3 ${mode}: OpenRouter discovery ${offline ? 'offline' : 'on demand'} preserves warm snapshots`,
      { timeout: 30000 },
      async () => {
        const owned = await fixture('openrouter');
        let rpc: Awaited<ReturnType<typeof connect>> | undefined;
        try {
          rpc = await connect(owned, mode, offline ? 'openrouter-offline' : 'default');
          const initial = await rpc.client.getAvailableModels();
          assert.equal(owned.requests, 0);
          const [first, second] = await Promise.all([
            rpc.client.getAvailableModels(true),
            rpc.client.getAvailableModels(true),
          ]);
          assert.deepEqual(first!.models, second!.models);
          if (offline) {
            assert.equal(owned.requests, 0);
            assert.deepEqual(first!.models, initial!.models);
          } else {
            assert.equal(owned.requests, 2);
            assert.ok(
              (first!.models as any[]).some(
                (model) => model.provider === 'openrouter' && model.id === 'openai/gpt-5-mini'
              )
            );
            await rpc.client.getAvailableModels();
            assert.equal(owned.requests, 2);
          }
        } finally {
          if (rpc) await shutdown(rpc);
          else await owned.dispose();
        }
      }
    );
  }
}
