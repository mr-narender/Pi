import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { createInitialControllerState } from '../../src/state/types';
import { createWebviewSnapshot } from '../../src/webview/model';
import { createEmptyComposerState } from '../../src/webview/composer';
import { renderChatApp } from '../../src/webview/render';
import { JSDOM } from 'jsdom';
import { parseWebviewMessage } from '../../src/webview/messages';

async function fixture(t: any) {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), 'pi-ide-')));
  const cwd = resolve(root, 'nested');
  await mkdir(cwd);
  await writeFile(resolve(cwd, 'a.ts'), 'saved file');
  await writeFile(resolve(root, 'outside.ts'), 'private sibling');
  await symlink(resolve(root, 'outside.ts'), resolve(cwd, 'escape.ts'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls: any[] = [];
  const api: any = {
    workspace: {
      isTrusted: true,
      openTextDocument: async (uri: any) => {
        calls.push(['document', uri.fsPath]);
        return { uri, lineCount: 2, lineAt: () => ({ text: 'unsaved buffer contents' }) };
      },
    },
    Uri: { file: (fsPath: string) => ({ scheme: 'file', fsPath }) },
    Position: class {
      constructor(
        public line: number,
        public character: number
      ) {}
    },
    Range: class {
      constructor(
        public start: any,
        public end: any
      ) {}
    },
    window: {
      showTextDocument: async () => {
        throw new Error('Query must not open an editor');
      },
    },
    commands: {
      executeCommand: async (...args: any[]) => {
        calls.push(args);
        return [];
      },
    },
    languages: { getDiagnostics: () => [] },
  };
  const output = await build({
    entryPoints: ['src/ide/query.ts'],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    external: ['vscode'],
    logLevel: 'silent',
  }).catch(() => undefined);
  assert.ok(output, 'read-only query processor must exist');
  const module = { exports: {} as any };
  const require = createRequire(resolve('package.json'));
  new Function('require', 'module', 'exports', output.outputFiles[0]!.text)(
    (name: string) => (name === 'vscode' ? api : require(name)),
    module,
    module.exports
  );
  return {
    cwd,
    api,
    calls,
    query: module.exports.runIdeQuery,
    open: module.exports.openIdeLocation,
    signal: new AbortController().signal,
  };
}

test('definition query uses the exact nested chat root and live unsaved document without showing tabs', async (t) => {
  const { cwd, api, calls, query, signal } = await fixture(t);
  api.commands.executeCommand = async (command: string, uri: any, position: any) => {
    calls.push([command, uri.fsPath, position.line, position.character]);
    return [
      {
        targetUri: api.Uri.file(resolve(cwd, 'a.ts')),
        targetSelectionRange: { start: { line: 1, character: 3 } },
      },
    ];
  };
  const result = await query(
    cwd,
    { operation: 'definitions', path: 'a.ts', line: 2, character: 2 },
    signal,
    () => true
  );
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.locations, [{ path: 'a.ts', line: 2, character: 4 }]);
  assert.deepEqual(calls, [
    ['document', resolve(cwd, 'a.ts')],
    ['vscode.executeDefinitionProvider', resolve(cwd, 'a.ts'), 1, 1],
  ]);
});

test('IDE query rejects escaped, symlink, URL, malformed and invalid locations before calling providers', async (t) => {
  const { cwd, calls, query, signal } = await fixture(t);
  for (const request of [
    { operation: 'definitions', path: '../outside.ts', line: 1, character: 1 },
    { operation: 'references', path: 'escape.ts', line: 1, character: 1 },
    { operation: 'document_symbols', path: 'https://example.com/private' },
    { operation: 'delete', path: 'a.ts' },
    { operation: 'diagnostics', command: 'workbench.action.closeAllEditors' },
    { operation: 'definitions', path: 'a.ts', line: 0, character: 1 },
    { operation: 'definitions', path: 'a.ts', line: 1000000, character: 1 },
    { operation: 'definitions', path: 'a.ts', line: 1, character: 1000000 },
  ]) {
    assert.equal((await query(cwd, request, signal, () => true)).status, 'error');
  }
  assert.ok(calls.every(([command]) => command === 'document'));
});

test('untrusted, stale and cancelled IDE requests disclose no workspace data', async (t) => {
  const { cwd, api, calls, query } = await fixture(t);
  const cancelled = new AbortController();
  cancelled.abort();
  assert.equal(
    (await query(cwd, { operation: 'diagnostics' }, cancelled.signal, () => true)).status,
    'cancelled'
  );
  assert.equal(
    (await query(cwd, { operation: 'diagnostics' }, new AbortController().signal, () => false))
      .status,
    'cancelled'
  );
  api.workspace.isTrusted = false;
  assert.equal(
    (await query(cwd, { operation: 'diagnostics' }, new AbortController().signal, () => true))
      .status,
    'restricted'
  );
  assert.equal(calls.length, 0);
});

test('empty language results do not claim provider availability; nested symbols and diagnostics stay scoped', async (t) => {
  const { cwd, api, query, signal } = await fixture(t);
  const empty = await query(
    cwd,
    { operation: 'document_symbols', path: 'a.ts' },
    signal,
    () => true
  );
  assert.equal(empty.status, 'empty');
  assert.match(empty.message, /provider availability.*unknown/i);
  api.commands.executeCommand = async () => [
    {
      name: 'outer',
      kind: 11,
      selectionRange: { start: { line: 0, character: 0 } },
      children: [{ name: 'inner', kind: 12, selectionRange: { start: { line: 1, character: 1 } } }],
    },
  ];
  const symbols = await query(
    cwd,
    { operation: 'document_symbols', path: 'a.ts' },
    signal,
    () => true
  );
  assert.deepEqual(
    symbols.locations.map((item: any) => item.name),
    ['outer', 'inner']
  );
  api.languages.getDiagnostics = () => [
    [
      api.Uri.file(resolve(cwd, 'a.ts')),
      [{ message: 'unsaved error', severity: 0, range: { start: { line: 1, character: 2 } } }],
    ],
    [
      api.Uri.file(resolve(cwd, '../outside.ts')),
      [{ message: 'SIBLING_PRIVATE', severity: 0, range: { start: { line: 0, character: 0 } } }],
    ],
  ];
  const diagnostics = await query(cwd, { operation: 'diagnostics' }, signal, () => true);
  assert.equal(diagnostics.locations[0].message, 'unsaved error');
  assert.doesNotMatch(JSON.stringify(diagnostics), /SIBLING_PRIVATE/);
});

test('IDE query discards results from a replaced chat or cancelled pending provider', async (t) => {
  const { cwd, api, query } = await fixture(t);
  let finish!: (value: any[]) => void;
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  api.commands.executeCommand = () => {
    entered();
    return new Promise((resolve) => {
      finish = resolve;
    });
  };
  let current = true;
  const cancel = new AbortController();
  const result = query(
    cwd,
    { operation: 'references', path: 'a.ts', line: 1, character: 1 },
    cancel.signal,
    () => current
  );
  await waiting;
  current = false;
  cancel.abort();
  assert.equal((await result).status, 'cancelled');
  finish([
    { uri: api.Uri.file(resolve(cwd, 'a.ts')), range: { start: { line: 0, character: 0 } } },
  ]);
});

test('provider results omit foreign URI authorities and sibling paths, cap payloads and redact diagnostics', async (t) => {
  const { cwd, api, query, signal } = await fixture(t);
  api.commands.executeCommand = async () => [
    {
      uri: { ...api.Uri.file(resolve(cwd, 'a.ts')), authority: 'foreign-host' },
      range: { start: { line: 0, character: 0 } },
    },
    {
      uri: api.Uri.file(resolve(cwd, '../outside.ts')),
      range: { start: { line: 0, character: 0 } },
    },
    ...Array.from({ length: 500 }, () => ({
      uri: api.Uri.file(resolve(cwd, 'a.ts')),
      range: { start: { line: 1, character: 0 } },
    })),
  ];
  const references = await query(
    cwd,
    { operation: 'references', path: 'a.ts', line: 1, character: 1 },
    signal,
    () => true
  );
  assert.equal(references.omitted, 2);
  assert.equal(references.locations.length, 100);
  assert.equal(references.truncated, true);
  assert.ok(JSON.stringify(references).length < 25000);
  api.languages.getDiagnostics = () => [
    [
      api.Uri.file(resolve(cwd, 'a.ts')),
      Array.from({ length: 500 }, () => ({
        message: 'Bearer private-secret-token ' + 'x'.repeat(2000),
        severity: 0,
        range: { start: { line: 0, character: 0 } },
      })),
    ],
  ];
  const diagnostics = await query(cwd, { operation: 'diagnostics' }, signal, () => true);
  assert.ok(JSON.stringify(diagnostics).length < 25000);
  assert.doesNotMatch(JSON.stringify(diagnostics), /private-secret-token/);
});

test('hanging editor providers time out and late results are discarded', async (t) => {
  const { cwd, api, query } = await fixture(t);
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let finish!: (value: any[]) => void;
  api.commands.executeCommand = () => {
    entered();
    return new Promise((resolve) => {
      finish = resolve;
    });
  };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = query(
    cwd,
    { operation: 'document_symbols', path: 'a.ts' },
    new AbortController().signal,
    () => true
  );
  await waiting;
  t.mock.timers.tick(8001);
  assert.equal((await pending).status, 'timeout');
  finish([]);
});

test('only an explicit location click opens the validated existing file and exact position', async (t) => {
  const { cwd, api, calls, open } = await fixture(t);
  api.window.showTextDocument = async (document: any, options: any) =>
    calls.push([
      'show',
      document.uri.fsPath,
      options.selection.start.line,
      options.selection.start.character,
    ]);
  await assert.rejects(open(cwd, { path: 'escape.ts', line: 1, character: 1 }));
  await assert.rejects(open(cwd, { path: 'a.ts', line: 999, character: 1 }));
  assert.ok(calls.every(([command]) => command !== 'show'));
  await open(cwd, { path: 'a.ts', line: 2, character: 3 });
  assert.deepEqual(calls.at(-1), ['show', resolve(cwd, 'a.ts'), 1, 2]);
});

test('GUI resource exposes four read-only IDE tools and sends scoped cancellable requests', async () => {
  const module = await import(pathToFileURL(resolve('resources/pi-vscode-ide.mjs')).href).catch(
    () => ({})
  );
  assert.equal(typeof module.default, 'function', 'GUI IDE resource must register tools');
  const tools: any[] = [];
  const commands: any[] = [];
  module.default({
    registerTool: (tool: any) => tools.push(tool),
    registerCommand: (name: string, command: any) => commands.push({ name, ...command }),
  });
  assert.equal(commands[0]?.name, 'vscode-ide');
  let help = '';
  await commands[0].handler('', {
    ui: {
      notify: (message: string) => {
        help = message;
      },
    },
  });
  assert.match(help, /provider availability.*query/i);
  assert.match(help, /policy/i);
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ['vscode_diagnostics', 'vscode_document_symbols', 'vscode_definitions', 'vscode_references']
  );
  const signal = new AbortController().signal;
  const requests: any[] = [];
  const result = await tools[2].execute(
    'call',
    { path: 'src/file.ts', line: 4, character: 2 },
    signal,
    undefined,
    {
      hasUI: true,
      ui: {
        input: async (...args: any[]) => {
          requests.push(args);
          return JSON.stringify({
            vscodeIde: 1,
            operation: 'definitions',
            status: 'ok',
            locations: [],
          });
        },
      },
    }
  );
  assert.equal(requests[0][0], 'pi-vscode-ide-v1');
  assert.deepEqual(JSON.parse(requests[0][1]), {
    operation: 'definitions',
    path: 'src/file.ts',
    line: 4,
    character: 2,
  });
  assert.equal(requests[0][2].signal, signal);
  assert.ok(requests[0][2].timeout <= 15000);
  assert.equal(JSON.parse(result.content[0].text).status, 'ok');
  assert.equal(result.details.vscodeIde, 1);
  const offline = await tools[0].execute('call', {}, signal, undefined, { hasUI: false });
  assert.equal(offline.isError, true);
  assert.match(offline.content[0].text, /unavailable/i);
});

test('controller consumes only internal IDE requests and replies to captured originating client after replacement', async (t) => {
  const { cwd, api } = await fixture(t);
  const output = await build({
    entryPoints: ['src/sessions/sessionController.ts'],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    external: ['vscode'],
  });
  const module = { exports: {} as any };
  const require = createRequire(resolve('package.json'));
  new Function('require', 'module', 'exports', output.outputFiles[0]!.text)(
    (name: string) => (name === 'vscode' ? api : require(name)),
    module,
    module.exports
  );
  const controller = Object.create(module.exports.SessionController.prototype);
  const first: any[] = [],
    replacement: any[] = [],
    visible: any[] = [];
  const client = {
    respondExtensionUi: async (value: any) => {
      first.push(value);
    },
  };
  controller.supervisor = { currentClient: client, currentGeneration: 1 };
  controller.folder = { uri: { fsPath: cwd } };
  controller.state = { state: { sessionId: 'one', sessionFile: 'one.jsonl' } };
  controller.applyExtensionUiRequest = (value: any) => visible.push(value);
  controller.ideRequests = new Map();
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let complete!: (value: any[]) => void;
  api.commands.executeCommand = () => {
    entered();
    return new Promise((resolve) => {
      complete = resolve;
    });
  };
  controller.onExtensionUi(
    {
      id: 'ide-one',
      method: 'input',
      title: 'pi-vscode-ide-v1',
      placeholder: JSON.stringify({ operation: 'document_symbols', path: 'a.ts' }),
    },
    client
  );
  await Promise.race([
    waiting,
    new Promise((_r, reject) =>
      setTimeout(() => reject(new Error('IDE request was not intercepted')), 200)
    ),
  ]);
  controller.supervisor.currentClient = {
    respondExtensionUi: async (value: any) => {
      replacement.push(value);
    },
  };
  controller.supervisor.currentGeneration++;
  complete([
    { name: 'PRIVATE_STALE', selectionRange: { start: { line: 0, character: 0 } }, children: [] },
  ]);
  for (let i = 0; i < 50 && !first.length; i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(first.length, 1);
  assert.equal(JSON.parse(first[0].value).status, 'cancelled');
  assert.doesNotMatch(first[0].value, /PRIVATE_STALE/);
  assert.equal(replacement.length, 0);
  assert.equal(visible.length, 0);
  assert.equal(controller.ideRequests.size, 0);
  controller.onExtensionUi(
    { id: 'ordinary', method: 'input', title: 'Your name' },
    controller.supervisor.currentClient
  );
  assert.equal(visible[0].id, 'ordinary');
  const activeClient = controller.supervisor.currentClient;
  for (const malformed of [
    { method: 'select', title: 'pi-vscode-ide-v1', placeholder: '{}' },
    { method: 'input', title: 'pi-vscode-ide-v2', placeholder: '{}' },
    { method: 'input', title: 'pi-vscode-ide-v1', placeholder: '{invalid' },
    { method: 'input', title: 'pi-vscode-ide-v1', placeholder: 'x'.repeat(9000) },
  ]) {
    const count: number = replacement.length;
    controller.onExtensionUi({ id: `malformed-${count}`, ...malformed }, activeClient);
    for (let i = 0; i < 50 && replacement.length === count; i++)
      await new Promise((resolve) => setTimeout(resolve, 2));
    assert.equal(replacement.length, count + 1);
    assert.equal(JSON.parse(replacement.at(-1).value).status, 'error');
    assert.equal(visible.length, 1, 'reserved bridge requests must never become dialogs');
  }
  for (const mutation of [
    () => {
      controller.state.state.sessionFile = 'replaced.jsonl';
    },
    () => {
      controller.navigationEpoch = (controller.navigationEpoch ?? 0) + 1;
    },
    () => {
      controller.runRevision = (controller.runRevision ?? 0) + 1;
    },
  ]) {
    const count: number = replacement.length;
    let ready!: () => void;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    api.commands.executeCommand = () => {
      ready();
      return new Promise((resolve) => {
        complete = resolve;
      });
    };
    controller.onExtensionUi(
      {
        id: `same-client-${count}`,
        method: 'input',
        title: 'pi-vscode-ide-v1',
        placeholder: JSON.stringify({ operation: 'document_symbols', path: 'a.ts' }),
      },
      activeClient
    );
    await started;
    mutation();
    complete([]);
    for (let i = 0; i < 50 && replacement.length === count; i++)
      await new Promise((resolve) => setTimeout(resolve, 2));
    assert.equal(JSON.parse(replacement.at(-1).value).status, 'cancelled');
  }
  const count = replacement.length;
  api.languages.getDiagnostics = () => {
    queueMicrotask(() => {
      controller.navigationEpoch++;
    });
    return [];
  };
  controller.onExtensionUi(
    {
      id: 'late-microtask',
      method: 'input',
      title: 'pi-vscode-ide-v1',
      placeholder: JSON.stringify({ operation: 'diagnostics' }),
    },
    activeClient
  );
  for (let i = 0; i < 50 && replacement.length === count; i++)
    await new Promise((resolve) => setTimeout(resolve, 2));
  assert.equal(
    JSON.parse(replacement.at(-1).value).status,
    'cancelled',
    'recheck ownership immediately before replying'
  );
});

test('IDE results render minimal clickable locations inside the existing quiet activity footer', () => {
  const state = createInitialControllerState('project', '/project');
  const result = {
    vscodeIde: 1,
    operation: 'definitions',
    status: 'ok',
    message: 'One editor location.',
    locations: [{ path: 'src/a.ts', line: 4, character: 2, name: '<script>bad</script>' }],
  };
  state.messages = [
    { role: 'user', id: 'u', content: 'Find definition' },
    {
      role: 'assistant',
      id: 'a',
      content: [
        {
          type: 'toolCall',
          id: 'ide',
          name: 'vscode_definitions',
          arguments: { path: 'src/a.ts', line: 4, character: 2 },
        },
      ],
    },
    {
      role: 'toolResult',
      id: 'r',
      toolCallId: 'ide',
      toolName: 'vscode_definitions',
      content: [{ type: 'text', text: JSON.stringify(result) }],
      isError: false,
    },
    { role: 'assistant', id: 'final', content: 'Definition found.' },
  ];
  const doc = new JSDOM(
    renderChatApp(
      createWebviewSnapshot(state, 1, {
        composer: createEmptyComposerState(),
        isTrusted: true,
        folders: [],
      })
    )
  ).window.document;
  const location = doc.querySelector('[data-ide-location]');
  assert.ok(location, 'editor location must be clickable');
  assert.equal(location.getAttribute('data-ide-location'), 'src/a.ts');
  assert.equal(location.getAttribute('data-ide-line'), '4');
  assert.ok(location.closest('[data-inline-activity] [data-raw-details]'));
  assert.equal(doc.querySelector('#messages .message-card [data-ide-location]'), null);
  assert.equal(doc.querySelector('script'), null);
  assert.deepEqual(
    parseWebviewMessage({ type: 'openIdeLocation', path: 'src/a.ts', line: 4, character: 2 }),
    { type: 'openIdeLocation', path: 'src/a.ts', line: 4, character: 2 }
  );
  assert.equal(
    parseWebviewMessage({ type: 'openIdeLocation', path: 'a', line: -1, character: 2 }),
    undefined
  );
});

test('GUI launch injects the resource only into trusted extension-enabled sessions without altering loadouts or session identity', async () => {
  const api = { workspace: { isTrusted: true } };
  const output = await build({
    stdin: {
      contents:
        "export { PiProcessSupervisor } from './src/process/supervisor'; export { setIdeExtensionPath } from './src/ide/query';",
      resolveDir: process.cwd(),
      loader: 'ts',
    },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    external: ['vscode'],
  });
  const module = { exports: {} as any };
  const require = createRequire(resolve('package.json'));
  new Function('require', 'module', 'exports', output.outputFiles[0]!.text)(
    (name: string) => (name === 'vscode' ? api : require(name)),
    module,
    module.exports
  );
  module.exports.setIdeExtensionPath('/extension/resources/pi-vscode-ide.mjs');
  const supervisor = Object.create(module.exports.PiProcessSupervisor.prototype);
  supervisor.settingsOverride = {
    additionalArgs: ['--tools', 'read'],
    offline: true,
    allowApproveInTrustedWorkspace: true,
  };
  const enabled = supervisor.buildArgs('/sessions/original.jsonl');
  assert.deepEqual(enabled, [
    '--mode',
    'rpc',
    '--offline',
    '--extension',
    '/extension/resources/pi-vscode-ide.mjs',
    '--session',
    '/sessions/original.jsonl',
    '--tools',
    'read',
  ]);
  for (const excluded of ['--no-extensions', '-ne']) {
    supervisor.settingsOverride.additionalArgs = [excluded, '--tools', 'read'];
    assert.equal(supervisor.buildArgs().includes('--extension'), false);
  }
  supervisor.settingsOverride.additionalArgs = [];
  assert.equal(
    supervisor.buildArgs(undefined, { noExtensions: true }).includes('--extension'),
    false
  );
  api.workspace.isTrusted = false;
  assert.equal(supervisor.buildArgs().includes('--extension'), false);
});
