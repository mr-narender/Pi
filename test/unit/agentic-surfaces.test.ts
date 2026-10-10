import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { build } from 'esbuild';

async function nativeClasses(vscode: unknown) {
  const compiled = await build({
    stdin: {
      contents:
        "export {ChatTabManager, collectOpenableAttachmentUris} from './src/editorTabs/tabManager'; export {ExtensionUiBroker} from './src/ui/extensionUiBroker';",
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

test('captured context opens only through the current snapshot allowlist', async () => {
  const opened: string[] = [];
  const classes = await nativeClasses({
    commands: {
      executeCommand: async (_command: string, uri: { value: string }) => opened.push(uri.value),
    },
    Uri: { parse: (value: string) => ({ value }) },
  });
  const registered = 'file:///workspace/src/registered.ts';
  const allowed = classes.collectOpenableAttachmentUris({
    messages: [
      {
        attachments: [],
        capturedContext: [
          {
            fileRef: { uri: registered, path: 'src/registered.ts' },
          },
        ],
      },
    ],
  });
  const manager = Object.create(classes.ChatTabManager.prototype);
  const host = { hasAttachment: (uri: string) => allowed.has(uri) };

  await manager.handleOpenAttachment(host, registered);
  await manager.handleOpenAttachment(host, 'file:///workspace/src/unregistered.ts');
  assert.deepEqual(opened, [registered]);
});

test('deleting a saved chat closes its original draft tab and honors a close veto', async () => {
  const resource = {
    scheme: 'pi-chat',
    path: '/draft.chat',
    toString: () => 'pi-chat:/draft.chat',
  };
  const tab = { input: { uri: resource, viewType: 'piRpc.chatEditor' } };
  let closeAllowed = false;
  const closed: unknown[] = [];
  const classes = await nativeClasses({
    window: {
      tabGroups: {
        all: [{ tabs: [tab] }],
        close: async (item: unknown) => {
          closed.push(item);
          return closeAllowed;
        },
      },
    },
  });
  const manager = Object.create(classes.ChatTabManager.prototype);
  manager.assertSessionFileNotCompacting = () => {};
  manager.contextForResource = () => ({
    controller: { snapshot: { state: { sessionFile: '/s/a.jsonl' } } },
  });
  await assert.rejects(manager.closeForSessionFile('/s/a.jsonl'), /could not be closed/);
  assert.deepEqual(closed, [tab]);
  closeAllowed = true;
  await manager.closeForSessionFile('/s/a.jsonl');
  assert.deepEqual(closed, [tab, tab]);
});

test('deleting a session closes adjacent matching tabs when VS Code mutates the tab list', async () => {
  const tabs = ['/first.chat', '/second.chat'].map((path) => ({
    input: {
      uri: { scheme: 'pi-chat', path, toString: () => `pi-chat:${path}` },
      viewType: 'piRpc.chatEditor',
    },
  }));
  const expected = [...tabs];
  const group = { tabs };
  const closed: unknown[] = [];
  const classes = await nativeClasses({
    window: {
      tabGroups: {
        all: [group],
        close: async (tab: (typeof tabs)[number]) => {
          closed.push(tab);
          group.tabs.splice(group.tabs.indexOf(tab), 1);
          return true;
        },
      },
    },
  });
  const manager = Object.create(classes.ChatTabManager.prototype);
  manager.assertSessionFileNotCompacting = () => {};
  manager.contextForResource = () => ({
    controller: { snapshot: { state: { sessionFile: '/s/a.jsonl' } } },
  });
  await manager.closeForSessionFile('/s/a.jsonl');
  assert.deepEqual(closed, expected, 'every matching tab must be closed');
  assert.deepEqual(group.tabs, []);
});

test('tab disposal retains the tracked controller for the delete stop safeguard', async () => {
  const classes = await nativeClasses({});
  const manager = Object.create(classes.ChatTabManager.prototype);
  const events: string[] = [];
  const controller = {
    folder: { uri: { toString: () => 'file:///workspace' } },
    snapshot: { state: { sessionFile: '/s/a.jsonl' } },
    assertNoManualCompaction() {},
    abort: async () => {
      events.push('abort');
    },
    stop: async () => {
      events.push('stop');
    },
  };
  const resource = { toString: () => 'pi-chat:/a.chat' };
  const host = { resource };
  manager.trackedControllers = new Set([controller]);
  manager.sessions = { keyFor: () => 'chat:a', unbind() {} };
  manager.hosts = new Map([[resource.toString(), host]]);
  manager.openChatsEmitter = { fire() {} };
  manager.cache = { markClosed: async () => {} };
  manager.registry = {
    remove: () => {
      events.push('registry-remove');
      void controller.stop();
    },
  };
  await manager.onHostDisposed(host);
  manager.stopControllersForSessionFile('/s/a.jsonl');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['registry-remove', 'stop', 'abort', 'stop']);
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

test('native input and inline multiline editor callbacks respond without opening tabs', async () => {
  const notifications: unknown[] = [];
  const vscode = {
    workspace: {
      openTextDocument: async () => {
        throw new Error('extension UI must not create an untitled editor');
      },
    },
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
      showTextDocument: async () => {
        throw new Error('extension UI must not show an editor tab');
      },
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
  const manager = Object.create(classes.ChatTabManager.prototype);
  assert.deepEqual(await broker.handleRequest(controller, { id: 'input', method: 'input' }), {
    value: 'native input',
  });
  assert.deepEqual(
    await broker.handleRequest(controller, {
      id: 'editor',
      method: 'editor',
      prefill: 'first\nsecond',
    }),
    { inline: true }
  );
  assert.equal(controller.pending.has('editor'), true);
  await manager.handleRespondUi({ controller }, 'editor', 'first\nsecond\nthird', undefined, false);
  assert.deepEqual(controller.replies, [
    { id: 'input', value: 'native input' },
    { id: 'editor', value: 'first\nsecond\nthird' },
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
