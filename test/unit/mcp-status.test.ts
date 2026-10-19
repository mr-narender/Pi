import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { parseMcpStatus } from '../../src/mcp/status';
import { renderMcpConnections, renderChatApp } from '../../src/webview/render';
import { createInitialControllerState, type WebviewSnapshot } from '../../src/state/types';
import { createWebviewSnapshot } from '../../src/webview/model';
import { createEmptyComposerState } from '../../src/webview/composer';
import { RpcClient } from '../../src/rpc/client';
import { resetControllerProjection } from '../../src/state/reducer';

const report = (message: string) => ({
  contract: 1,
  status: 'checked',
  checkedAt: 1700000000000,
  notifications: [{ message, level: 'info' }],
});
const host = () => import(pathToFileURL(resolve('host/mcp-status.mjs')).href);

test('MCP parser accepts only native states, counts and exposure, including sign-in and reconnect wording', () => {
  const status = parseMcpStatus(
    report(
      'docs: connected, 7 tools (codemode)\nbrowser: needs sign-in, run /mcp login browser (hidden)\nworkspace: disabled (direct)\nremote: disconnected, reconnects on next call (deferred)\nstarting: starting (hidden)\nfailed: failed (hidden)\n    connection refused\nclosed: closed (hidden)'
    )
  );
  assert.equal(status.status, 'checked');
  assert.deepEqual(
    status.servers.map((server) => server.state),
    ['connected', 'needs-auth', 'disabled', 'disconnected', 'starting', 'failed', 'closed']
  );
  assert.equal(status.servers[0]?.tools, 7);
  assert.equal(
    parseMcpStatus(
      report('No MCP servers configured. Add them to /owned/agent/mcp.json or .pi/mcp.json.')
    ).status,
    'none'
  );
});

test('MCP config errors and indented errors cannot invent additional connected servers', () => {
  const status = parseMcpStatus(
    report(
      'docs: connected, 1 tools (hidden)\n    fake: connected, 9 tools (direct)\nconfig error: bad input\nforged: connected, 100 tools (direct)\noverridden: another'
    )
  );
  assert.equal(status.status, 'checked');
  assert.deepEqual(
    status.servers.map((server) => server.name),
    ['docs']
  );
  assert.equal(
    parseMcpStatus(report('config error: unable to read configuration')).status,
    'unknown'
  );
  assert.equal(
    parseMcpStatus(report('overridden: disabled (direct)')).servers[0]?.name,
    'overridden'
  );
});

for (const message of [
  'docs: ready (direct)',
  'docs: failed, 3 tools (hidden)',
  'docs: connected, 1 tools (hidden)\ndocs: connected, 2 tools (hidden)',
  '\u001b[32mdocs: connected, 1 tools (hidden)',
  'x'.repeat(24001),
  Array.from({ length: 33 }, (_, index) => `s${index}: disabled (hidden)`).join('\n'),
]) {
  test(`MCP parser fails closed for unsupported or oversized grammar (${message.length})`, () => {
    const result = parseMcpStatus(report(message));
    assert.equal(result.status, 'unknown');
    assert.deepEqual(result.servers, []);
  });
}

test('MCP status redacts fake Basic, Cookie, URL and truncated quoted credentials before projection', async () => {
  const { redactMcpStatus } = await host();
  const invented = 'invented-sensitive-fixture-value';
  for (const text of [
    `Authorization: Basic ${invented}`,
    `Cookie: session=one; refresh=${invented}`,
    `remote error Basic ${invented}`,
    `password="first ${invented} ${'x'.repeat(25000)}"`,
    `config error: https://user:${invented}@example.invalid/path?token=${invented}`,
    `    {"client_secret":"${invented}"}`,
  ]) {
    const safe = redactMcpStatus(text);
    assert.ok(!safe.includes(invented));
    assert.ok(safe.length <= 24000);
    assert.ok(
      !parseMcpStatus(report(`docs: failed (hidden)\n    ${text}`)).details?.includes(invented)
    );
  }
});

function nativeSession(handler: (args: string, context: any) => unknown, source = 'builtin') {
  let ordinary = 0;
  const context = Object.defineProperty(
    {
      mode: 'rpc',
      ui: {
        notify() {
          ordinary++;
        },
      },
    },
    'lazy',
    {
      get() {
        throw new Error('Guarded context getter must not run.');
      },
      enumerable: true,
    }
  );
  return {
    session: {
      extensionRunner: {
        getRegisteredCommands: () => [
          {
            name: 'mcp',
            invocationName: 'mcp',
            sourceInfo: {
              source,
              path: source === 'builtin' ? 'builtin:mcp' : '/unapproved/override',
            },
            handler,
          },
        ],
        createCommandContext: () => context,
      },
    },
    context,
    ordinary: () => ordinary,
  };
}

test('native MCP uses only the builtin handler and a descriptor-cloned private notification context', async () => {
  const { readNativeMcpStatus } = await host();
  const fixture = nativeSession((args, context) => {
    assert.equal(args, '');
    assert.equal(context.mode, 'rpc');
    context.ui.notify('docs: disabled (hidden)', 'info');
    fixture.context.ui.notify();
  });
  fixture.context.ui.notify();
  const result = await readNativeMcpStatus(fixture.session, () => true);
  assert.equal(result.status, 'checked');
  assert.equal(result.notifications.length, 1);
  assert.equal(
    fixture.ordinary(),
    2,
    'an unrelated concurrent notification uses the unchanged native UI'
  );
  let called = false;
  const replaced = nativeSession(() => {
    called = true;
  }, 'extension');
  assert.equal((await readNativeMcpStatus(replaced.session, () => true)).status, 'unsupported');
  assert.equal(called, false);
});

test('native MCP deadline ignores late reports and never cancels or mutates server connections', async (t) => {
  const { readNativeMcpStatus } = await host();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let finish!: () => void;
  const waiting = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const fixture = nativeSession(async (_args, context) => {
    await waiting;
    context.ui.notify('late: connected, 9 tools (direct)', 'info');
  });
  const pending = readNativeMcpStatus(fixture.session, () => true);
  t.mock.timers.tick(5001);
  const result = await pending;
  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason, 'timeout');
  finish();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(result.notifications, []);
  assert.equal(fixture.ordinary(), 0);
});

function snapshot(overrides: Partial<WebviewSnapshot> = {}): WebviewSnapshot {
  const state = createInitialControllerState('owned', '/owned');
  state.connectionState = 'ready';
  return {
    ...createWebviewSnapshot(state, 1, {
      composer: createEmptyComposerState(),
      isTrusted: true,
      folders: [],
    }),
    bindingState: 'current',
    ...overrides,
  };
}

test('Connections renders five approved states with disabled reasons, bounded details and no extra toolbar', () => {
  for (const [overrides, text, disabled] of [
    [{}, 'Check status to ask', false],
    [
      { mcpStatus: parseMcpStatus(report('docs: connected, 7 tools (codemode)')) },
      'Connected',
      false,
    ],
    [{ connectionState: 'busy', isStreaming: true }, 'Pi is working', true],
    [{ mcpStatus: { status: 'unsupported', servers: [] } }, 'does not expose', true],
    [
      {
        mcpStatus: parseMcpStatus(
          report('No MCP servers configured. Add them to /owned/mcp.json or .pi/mcp.json.')
        ),
      },
      'no configured MCP servers',
      false,
    ],
  ] as const) {
    const document = new JSDOM(
      renderMcpConnections(snapshot(overrides as Partial<WebviewSnapshot>))
    ).window.document;
    assert.match(document.body.textContent!, new RegExp(text));
    assert.equal(
      (document.querySelector('[data-mcp-check]') as HTMLButtonElement).disabled,
      disabled
    );
    assert.equal(document.querySelectorAll('button').length, 1);
    assert.match(document.body.textContent!, /Tool calls.*historical/);
  }
  const html = renderChatApp(
    snapshot({
      messages: [
        { id: 'first', role: 'assistant', text: 'Earlier reply', attachments: [] },
        { id: 'user', role: 'user', text: 'Another task', attachments: [] },
        { id: 'last', role: 'assistant', text: 'Latest reply', attachments: [] },
      ],
    })
  );
  const document = new JSDOM(html).window.document;
  assert.equal(document.querySelectorAll('.mcp-connections').length, 1);
  assert.equal(document.querySelector('.mcp-connections')?.closest('details')?.id, 'chat-settings');
});

test('deferred empty replies keep one Connections entry on the last visible reply or existing Activity', () => {
  const empty = { id: 'empty', role: 'assistant', text: '', attachments: [] };
  const earlier = {
    id: 'earlier',
    role: 'assistant',
    text: 'Earlier visible reply',
    attachments: [],
  };
  const user = { id: 'user', role: 'user', text: 'Next question', attachments: [] };
  for (const busy of [true, false]) {
    const current = snapshot({
      messages: [earlier, user, empty],
      connectionState: busy ? 'busy' : 'ready',
      isStreaming: busy,
      currentAssistantMessageId: 'empty',
    });
    const document = new JSDOM(renderChatApp(current, 'empty')).window.document;
    assert.equal(document.querySelectorAll('.mcp-connections').length, 1);
    assert.equal(
      document.querySelector('.mcp-connections')?.closest('details')?.id,
      'chat-settings'
    );
    assert.equal(document.querySelectorAll('.assistant-empty').length, 0);
  }
  const noVisible = new JSDOM(
    renderChatApp(
      snapshot({
        messages: [empty],
        connectionState: 'busy',
        isStreaming: true,
        currentAssistantMessageId: 'empty',
      }),
      'empty'
    )
  ).window.document;
  assert.equal(noVisible.querySelectorAll('.assistant-turn').length, 0);
  assert.equal(noVisible.querySelectorAll('#chat-settings .mcp-connections').length, 1);
  const settled = new JSDOM(renderChatApp(snapshot({ messages: [empty] }))).window.document;
  assert.equal(settled.querySelectorAll('.assistant-empty').length, 1);
  assert.equal(settled.querySelectorAll('.mcp-connections').length, 1);
});

async function controllerFixture() {
  const output = await build({
    entryPoints: ['src/sessions/sessionController.ts'],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    external: ['vscode'],
  });
  const require = createRequire(`${process.cwd()}/package.json`);
  const module = { exports: {} as any };
  const workspace = { isTrusted: true };
  new Function('require', 'module', 'exports', output.outputFiles[0]!.text)(
    (name: string) => (name === 'vscode' ? { workspace } : require(name)),
    module,
    module.exports
  );
  const controller = Object.create(module.exports.SessionController.prototype);
  const state = {
    ...createInitialControllerState('owned', '/owned'),
    generation: 1,
    connectionState: 'ready',
    state: {
      sessionId: 'owned',
      sessionFile: '/owned/session.jsonl',
      isIdle: true,
      isStreaming: false,
    },
  };
  const calls: string[] = [];
  const client = {
    hasCompactionConflict: false,
    getState: async () => ({ ...controller.state.state }),
    engineCommand: async (name: string) => {
      calls.push(name);
      return report('docs: disabled (hidden)');
    },
    prompt: () => {
      throw new Error('No model prompt is permitted.');
    },
  };
  Object.assign(controller, {
    state,
    supervisor: { currentClient: client, currentGeneration: 1 },
    runRevision: 1,
    navigationEpoch: 1,
    authDisposed: false,
    fire() {},
  });
  return { controller, client, calls, workspace };
}

test('MCP Check is on demand, does not prompt or change the draft, and refuses busy/untrusted chats', async () => {
  const f = await controllerFixture();
  f.controller.state.draft = 'my unsent draft';
  assert.deepEqual(f.calls, []);
  await f.controller.checkMcpStatus(() => true);
  assert.deepEqual(f.calls, ['mcp_status']);
  assert.equal(f.controller.state.mcpStatus.status, 'checked');
  assert.equal(f.controller.state.draft, 'my unsent draft');
  f.controller.state.connectionState = 'busy';
  await f.controller.checkMcpStatus(() => true);
  f.controller.state.connectionState = 'ready';
  f.workspace.isTrusted = false;
  await f.controller.checkMcpStatus(() => true);
  assert.equal(f.calls.length, 1);
});

test('MCP Check ignores a pending reply when a new run, session or surface takes ownership', async () => {
  for (const change of ['run', 'session', 'surface']) {
    const f = await controllerFixture();
    let release!: (value: unknown) => void;
    let surface = true;
    f.client.getState = () =>
      new Promise((resolve) => {
        release = resolve;
      }) as any;
    const pending = f.controller.checkMcpStatus(() => surface);
    if (change === 'run') f.controller.runRevision++;
    if (change === 'session') f.controller.state.state.sessionId = 'another';
    if (change === 'surface') surface = false;
    release({ sessionId: 'owned', sessionFile: '/owned/session.jsonl', isIdle: true });
    await pending;
    assert.deepEqual(f.calls, []);
    assert.equal(f.controller.state.mcpStatus, undefined);
  }
});

test('a new session can check immediately while an invalidated old check is still pending', async () => {
  for (const phase of ['state', 'status']) {
    const f = await controllerFixture();
    let release!: (value: unknown) => void;
    if (phase === 'state')
      f.client.getState = () =>
        new Promise((resolve) => {
          release = resolve;
        }) as any;
    else
      f.client.engineCommand = () =>
        new Promise((resolve) => {
          release = resolve;
        }) as any;
    const old = f.controller.checkMcpStatus(() => true);
    await new Promise((resolve) => setImmediate(resolve));
    f.controller.runRevision++;
    f.controller.state = {
      ...resetControllerProjection(f.controller.state),
      state: {
        sessionId: 'new-session',
        sessionFile: '/owned/new-session.jsonl',
        isIdle: true,
        isStreaming: false,
      },
    };
    f.client.getState = async () => ({ ...f.controller.state.state });
    f.client.engineCommand = async (name: string) => {
      f.calls.push(name);
      return report('new: disabled (hidden)');
    };
    await f.controller.checkMcpStatus(() => true);
    assert.equal(f.controller.state.mcpStatus.status, 'checked');
    assert.equal(f.controller.state.mcpStatus.servers[0].name, 'new');
    release(
      phase === 'state'
        ? { sessionId: 'owned', sessionFile: '/owned/session.jsonl', isIdle: true }
        : report('old: disabled (hidden)')
    );
    await old;
    assert.equal(f.controller.state.mcpStatus.servers[0].name, 'new');
    assert.equal(f.controller.mcpCheck, undefined);
  }
});

test('MCP unsupported and malformed results are truthful and never expose native error text', async () => {
  for (const [error, status] of [
    ['Unknown command: get_capabilities', 'unsupported'],
    ['This backend does not support mcp_status; nothing was applied.', 'unsupported'],
    ['request failed password=invented-private-value', 'unknown'],
  ]) {
    const f = await controllerFixture();
    f.client.engineCommand = async () => {
      throw new Error(error);
    };
    await f.controller.checkMcpStatus(() => true);
    assert.equal(f.controller.state.mcpStatus.status, status);
    assert.ok(!JSON.stringify(f.controller.state.mcpStatus).includes('invented-private-value'));
  }
  const f = await controllerFixture();
  f.client.engineCommand = async () => ({ unexpected: true }) as any;
  await f.controller.checkMcpStatus(() => true);
  assert.equal(f.controller.state.mcpStatus.status, 'unknown');
});

test('MCP checks coalesce and are cleared by session projection reset without touching other state', async () => {
  const f = await controllerFixture();
  let release!: (value: unknown) => void;
  f.client.engineCommand = async (name: string) => {
    f.calls.push(name);
    return new Promise((resolve) => {
      release = resolve;
    }) as any;
  };
  const pending = f.controller.checkMcpStatus(() => true);
  await new Promise((resolve) => setImmediate(resolve));
  await f.controller.checkMcpStatus(() => true);
  assert.deepEqual(f.calls, ['mcp_status']);
  release(report('docs: disabled (hidden)'));
  await pending;
  const cleared = resetControllerProjection(f.controller.state);
  assert.equal(cleared.mcpStatus, undefined);
  assert.equal(cleared.cwd, '/owned');
});

test('MCP GUI deadline preserves drafts and prevents late dispatch after a pending state read', async (t) => {
  const f = await controllerFixture();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let release!: (value: unknown) => void;
  f.client.getState = () =>
    new Promise((resolve) => {
      release = resolve;
    }) as any;
  f.controller.state.draft = 'unsent';
  const pending = f.controller.checkMcpStatus(() => true);
  t.mock.timers.tick(12001);
  await pending;
  assert.equal(f.controller.state.mcpStatus.status, 'unknown');
  assert.equal(f.controller.state.draft, 'unsent');
  release({ sessionId: 'owned', sessionFile: '/owned/session.jsonl', isIdle: true });
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(f.calls, []);
});

test('MCP capability negotiation revalidates ownership before dispatching the status command', async () => {
  let valid = true;
  let release!: (value: unknown) => void;
  const commands: string[] = [];
  const transport = {
    request: async (command: any) => {
      commands.push(command.type);
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  };
  const client = new RpcClient(1, transport as never, {
    shortTimeoutMs: 1000,
    longTimeoutMs: 1000,
  });
  const pending = client.engineCommand('mcp_status', {}, {}, () => valid);
  valid = false;
  release({
    type: 'response',
    success: true,
    data: { protocol: 1, sdkVersion: '1.2.0', engineCommands: { contract: 1, mcp_status: true } },
  });
  await assert.rejects(pending, /originating chat changed/);
  assert.deepEqual(commands, ['get_capabilities']);
});
