import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { build, transform } from 'esbuild';
import ts from 'typescript';

// Execute maintained activation statements rather than a copy of their logic.
async function sidebarFactory() {
  const source = readFileSync('src/extension.ts', 'utf8');
  const parsed = ts.createSourceFile('extension.ts', source, ts.ScriptTarget.Latest, true);
  const activate = parsed.statements.find(
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === 'activate'
  );
  assert.ok(activate?.body);
  const names = new Set([
    'sidebarSurface',
    'sidebarTransition',
    'agenticListHost',
    'attachedSidebarView',
    'attachedSidebarSurface',
    'attachSidebar',
    'showSidebarSurface',
  ]);
  const statements = activate.body.statements.filter(
    (node) =>
      ts.isVariableStatement(node) &&
      node.declarationList.declarations.some(
        (declaration) => ts.isIdentifier(declaration.name) && names.has(declaration.name.text)
      )
  );
  assert.equal(statements.length, names.size);
  const compiled = await transform(
    `${statements.map((node) => node.getText(parsed)).join('\n')}
     return {attachSidebar, showSidebarSurface, surface: () => sidebarSurface};`,
    { loader: 'ts', target: 'es2022' }
  );
  return new Function(
    'vscode',
    'context',
    'chatTabs',
    'recentSessions',
    'AgenticChatListHost',
    compiled.code
  );
}

async function nativeClasses(vscode: unknown) {
  const compiled = await build({
    stdin: {
      contents:
        "export {ChatTabManager} from './src/editorTabs/tabManager'; export {ExtensionUiBroker} from './src/ui/extensionUiBroker';",
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    external: ['vscode'],
  });
  const require = createRequire(`${process.cwd()}/package.json`);
  const module = { exports: {} as Record<string, any> };
  new Function('require', 'module', 'exports', compiled.outputFiles[0]!.text)(
    (id: string) => (id === 'vscode' ? vscode : require(id)),
    module,
    module.exports
  );
  return module.exports;
}

async function sidebarFixture(saved?: unknown) {
  const events: string[] = [];
  const data = new Map<string, unknown>();
  if (saved !== undefined) data.set('piRpc.sidebarSurface', saved);
  const folder = { uri: { toString: () => 'file:///workspace' }, name: 'workspace' };
  const controller = {
    folder,
    snapshot: { state: { sessionFile: '/workspace/session.jsonl' } },
    draft: 'keep draft',
    images: ['keep chip'],
  };
  const vscode = {
    workspace: { workspaceFolders: [folder] },
    commands: {
      executeCommand: async (...args: unknown[]) => {
        events.push(`command:${args.join(':')}`);
      },
    },
  };
  const classes = await nativeClasses(vscode);
  const manager = Object.create(classes.ChatTabManager.prototype);
  let closeGate = async () => {};
  let active = true;
  manager.getActiveContext = () => (active ? { controller } : undefined);
  manager.registry = { getOrCreate: () => controller };
  manager.context = {
    workspaceState: {
      get: (key: string) => data.get(key),
      update: async (key: string, value: unknown) => {
        data.set(key, value);
      },
    },
    extensionUri: {},
    subscriptions: [],
    globalState: {},
  };
  manager.closeForSessionFile = async (file: string) => {
    events.push(`close:${file}`);
    await closeGate();
    active = false;
  };
  manager.openForSessionFile = async (owner: unknown, file: string) => {
    assert.equal(owner, controller);
    events.push(`open:${file}`);
    active = true;
  };
  manager.attachSidebarChat = async () => {
    events.push('attach:full-chat');
  };
  manager.detachSidebarChatHost = () => {
    events.push('detach:full-chat');
  };
  class ListHost {
    attach() {
      events.push('attach:list');
    }
    detach() {
      events.push('detach:list');
    }
  }
  const factory = await sidebarFactory();
  const surface = factory(vscode, manager.context, manager, {}, ListHost);
  return {
    surface,
    events,
    data,
    controller,
    manager,
    setCloseGate: (gate: typeof closeGate) => {
      closeGate = gate;
    },
  };
}

test('Agentic defaults to list, validates saved surfaces and restores full-chat after reload', async () => {
  for (const saved of [undefined, 'chat', 'advanced', false]) {
    const fixture = await sidebarFixture(saved);
    assert.equal(fixture.surface.surface(), 'list');
    await fixture.surface.attachSidebar({});
    assert.deepEqual(fixture.events, ['attach:list']);
  }
  const fixture = await sidebarFixture('full-chat');
  assert.equal(fixture.surface.surface(), 'full-chat');
  await fixture.surface.attachSidebar({});
  assert.deepEqual(fixture.events, ['attach:full-chat']);
});

test('rapid full/list/full requests serialize the same saved session and detach its previous host first', async () => {
  const fixture = await sidebarFixture();
  await fixture.surface.attachSidebar({});
  fixture.events.length = 0;
  let release: () => void = () => {};
  fixture.setCloseGate(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      })
  );
  const first = fixture.surface.showSidebarSurface('full-chat');
  const second = fixture.surface.showSidebarSurface('list');
  const third = fixture.surface.showSidebarSurface('full-chat');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(fixture.events, ['close:/workspace/session.jsonl']);
  assert.equal(fixture.surface.surface(), 'list');
  fixture.setCloseGate(async () => {});
  release();
  await Promise.all([first, second, third]);
  assert.deepEqual(
    fixture.events.filter((event) => !event.startsWith('command:')),
    [
      'close:/workspace/session.jsonl',
      'detach:list',
      'attach:full-chat',
      'open:/workspace/session.jsonl',
      'detach:full-chat',
      'attach:list',
      'close:/workspace/session.jsonl',
      'detach:list',
      'attach:full-chat',
    ]
  );
  assert.equal(fixture.surface.surface(), 'full-chat');
  assert.equal(fixture.data.get('piRpc.sidebarSurface'), 'full-chat');
  assert.equal(fixture.controller.draft, 'keep draft');
  assert.deepEqual(fixture.controller.images, ['keep chip']);
});

test('duplicate Agentic surface requests do not remount or move the conversation', async () => {
  const fixture = await sidebarFixture();
  await fixture.surface.attachSidebar({});
  await Promise.all([
    fixture.surface.showSidebarSurface('full-chat'),
    fixture.surface.showSidebarSurface('full-chat'),
  ]);
  assert.equal(fixture.events.filter((event) => event.startsWith('close:')).length, 1);
  assert.equal(fixture.events.filter((event) => event === 'attach:full-chat').length, 1);
  await Promise.all([
    fixture.surface.showSidebarSurface('list'),
    fixture.surface.showSidebarSurface('list'),
  ]);
  assert.equal(fixture.events.filter((event) => event.startsWith('open:')).length, 1);
});

test('a rejected conversation close keeps the attached surface and the next queued request recovers', async () => {
  const fixture = await sidebarFixture();
  await fixture.surface.attachSidebar({});
  fixture.setCloseGate(async () => {
    throw new Error('compaction prevents close');
  });
  const rejected = fixture.surface.showSidebarSurface('full-chat');
  await assert.rejects(rejected, /compaction prevents close/);
  assert.equal(fixture.surface.surface(), 'list');
  assert.equal(fixture.data.has('piRpc.sidebarSurface'), false);
  assert.deepEqual(
    fixture.events.filter((event) => event.startsWith('attach:')),
    ['attach:list']
  );
  fixture.setCloseGate(async () => {});
  await fixture.surface.showSidebarSurface('full-chat');
  assert.equal(fixture.surface.surface(), 'full-chat');
  assert.equal(fixture.controller.draft, 'keep draft');
  assert.deepEqual(fixture.controller.images, ['keep chip']);
});

test('empty Agentic drafts switch surfaces without moving or rewriting their composer', async () => {
  const fixture = await sidebarFixture();
  fixture.controller.snapshot.state.sessionFile = '';
  await fixture.surface.attachSidebar({});
  await fixture.surface.showSidebarSurface('full-chat');
  await fixture.surface.showSidebarSurface('list');
  assert.equal(
    fixture.events.some((event) => /^(close|open):/.test(event)),
    false
  );
  assert.equal(fixture.controller.draft, 'keep draft');
  assert.deepEqual(fixture.controller.images, ['keep chip']);
});

function uiController() {
  const pending = new Map<string, unknown>();
  const replies: unknown[] = [];
  const completed: string[] = [];
  return {
    pending,
    replies,
    completed,
    snapshot: { state: {}, draft: '' },
    applyExtensionUiRequest: (request: { id: string }) => {
      pending.set(request.id, request);
    },
    respondExtensionUi: async (response: unknown) => {
      replies.push(response);
    },
    completeExtensionUiRequest: (id: string) => {
      pending.delete(id);
      completed.push(id);
    },
  };
}

test('native select/confirm approvals stay pending until the real chat response handler replies once', async () => {
  const classes = await nativeClasses({});
  const controller = uiController();
  const broker = new classes.ExtensionUiBroker(
    { list: () => [] },
    undefined,
    () => true,
    () => true
  );
  const manager = Object.create(classes.ChatTabManager.prototype);
  for (const [method, value, confirmed] of [
    ['select', 'Allow', undefined],
    ['confirm', undefined, false],
  ] as const) {
    const id = `native-${method}`;
    assert.deepEqual(await broker.handleRequest(controller, { id, method, options: ['Allow'] }), {
      inline: true,
    });
    assert.equal(controller.pending.has(id), true);
    assert.equal(controller.replies.length, method === 'select' ? 0 : 1);
    await manager.handleRespondUi({ controller }, id, value, confirmed);
    assert.deepEqual(
      controller.replies.at(-1),
      method === 'select' ? { id, value } : { id, confirmed }
    );
    assert.equal(controller.pending.has(id), false);
    assert.equal(controller.completed.filter((item) => item === id).length, 1);
  }
  broker.dispose();
});

test('native input/editor callbacks send real responses while notify stays a one-way notification', async () => {
  const notifications: unknown[] = [];
  const vscode = {
    workspace: { openTextDocument: async () => ({ getText: () => 'edited native text' }) },
    window: {
      createInputBox: () => {
        let accept = () => {};
        let hide = () => {};
        return {
          value: 'native input',
          onDidAccept: (callback: () => void) => {
            accept = callback;
          },
          onDidHide: (callback: () => void) => {
            hide = callback;
          },
          show: () => {
            accept();
          },
          hide: () => {
            hide();
          },
          dispose() {},
        };
      },
      showTextDocument: async () => {},
      showInformationMessage: async () => 'Submit',
      setStatusBarMessage: (...args: unknown[]) => {
        notifications.push(args);
      },
      showErrorMessage: (message: string) => {
        notifications.push(message);
      },
    },
  };
  const classes = await nativeClasses(vscode);
  const controller = uiController();
  const broker = new classes.ExtensionUiBroker({ list: () => [] });
  assert.deepEqual(await broker.handleRequest(controller, { id: 'input', method: 'input' }), {
    value: 'native input',
  });
  assert.deepEqual(
    await broker.handleRequest(controller, { id: 'editor', method: 'editor', prefill: 'prefill' }),
    { value: 'edited native text' }
  );
  assert.deepEqual(controller.replies, [
    { id: 'input', value: 'native input' },
    { id: 'editor', value: 'edited native text' },
  ]);
  assert.deepEqual(controller.completed, ['input', 'editor']);
  await broker.handleRequest(controller, {
    id: 'notify',
    method: 'notify',
    message: 'native notice',
  });
  await broker.handleRequest(controller, {
    id: 'error',
    method: 'notify',
    message: 'native error',
    notifyType: 'error',
  });
  assert.deepEqual(notifications, [['$(info) Pi: native notice', 6000], 'native error']);
  assert.equal(controller.replies.length, 2);
  broker.dispose();
});
