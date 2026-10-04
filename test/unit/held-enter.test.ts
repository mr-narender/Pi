import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { createEmptyComposerState } from '../../src/webview/composer';
test(`real compiled DOM → parsed editor → held owned picker → DOM`, async () => {
  let cancel: (() => void) | undefined,
    opened = 0;
  let releaseDiscovery: () => void;
  const discovery = new Promise<void>((r) => {
    releaseDiscovery = r;
  });
  const vscode = {
    EventEmitter: class {
      event = () => {};
      fire() {}
      dispose() {}
    },
    workspace: { isTrusted: true },
    QuickPickItemKind: { Separator: -1 },
    window: {
      createQuickPick() {
        opened++;
        let hide: () => void;
        return {
          items: [],
          selectedItems: [],
          onDidChangeValue() {},
          onDidAccept() {},
          onDidHide(fn: () => void) {
            hide = fn;
          },
          show() {
            cancel = () => hide();
          },
          hide() {
            hide();
          },
          dispose() {},
        };
      },
      showErrorMessage() {},
      showWarningMessage() {},
    },
  };
  const compiled = await build({
    stdin: {
      contents:
        "export { ChatTabManager } from './src/editorTabs/tabManager'; export { ChatUiState } from './src/webview/composerState';",
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    external: ['vscode'],
  });
  const module = { exports: {} as any };
  new Function('require', 'module', 'exports', compiled.outputFiles[0]!.text)(
    () => vscode,
    module,
    module.exports
  );
  const browser = await build({
    entryPoints: ['src/webview/media/chat.ts'],
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
  });
  const state = createEmptyComposerState();
  state.pendingImages = [{ itemId: 'img', name: 'kept.png', mimeType: 'image/png', sizeBytes: 1 }];
  const controller = {
    folder: { uri: { toString: () => 'owned-workspace' } },
    snapshot: { state: { sessionId: 'sid' }, isStreaming: false },
    getAvailableModels: async () => {
      await discovery;
      return [{ provider: 'dummy', id: 'owned' }];
    },
    setDraft() {},
    prompt() {
      throw Error('no prompt');
    },
    selectModel() {
      throw Error('cancel cannot apply');
    },
  };
  const identity = { workspaceFolderUri: 'owned-workspace', kind: 'sessionId', sessionId: 'sid' };
  const instance = Object.create(module.exports['ChatTabManager'].prototype);
  const host = { resource: { toString: () => 'owned.chat' } };
  instance.contextForResource = () => ({ controller, target: identity, resource: host.resource });
  instance.registry = { getActive: () => controller };
  instance.panel = {};
  const ui = new module.exports.ChatUiState({
    workspaceState: { get: () => ({}), update: async () => {} },
    globalState: { get: () => undefined },
  });
  instance.uiState = ui;
  await ui.getComposerStateForIdentity(controller, identity);
  await ui.setComposerStateForIdentity(controller, identity, state);
  const dom = new JSDOM('<div id="app"></div>', {
    pretendToBeVisual: true,
    runScripts: 'outside-only',
  });
  const w = dom.window;
  const posted: any[] = [],
    tasks: Promise<any>[] = [];
  let transport = Promise.resolve();
  let forwardRequests = true;
  const snapshot = async () => {
    const s = await ui.getComposerStateForIdentity(controller, identity);
    w.dispatchEvent(
      new w.MessageEvent('message', {
        data: {
          type: 'snapshot',
          snapshot: {
            sequence: 1,
            title: 'Chat',
            bindingState: 'current',
            connectionState: 'ready',
            sessionId: 'sid',
            messages: [],
            queue: { steering: [], followUp: [] },
            statuses: {},
            widgets: [],
            isTrusted: true,
            folders: [],
            ...s,
          },
        },
      })
    );
  };
  instance.renderResource = instance.postSnapshot = snapshot;
  // VS Code IPC emits distinct message tasks, not concurrent synchronous JS callbacks.
  Object.assign(w, {
    acquireVsCodeApi: () => ({
      postMessage(m: any) {
        posted.push(m);
        if (forwardRequests && ['setDraft', 'requestSend'].includes(m.type))
          transport = transport.then(
            () =>
              new Promise<void>((resolve) =>
                setImmediate(() => {
                  tasks.push(instance.onMessage(host, m));
                  resolve();
                })
              )
          );
      },
      getState() {},
      setState() {},
    }),
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
    IntersectionObserver: class {
      observe() {}
      disconnect() {}
    },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
  });
  w.HTMLElement.prototype.scrollTo = () => {};
  w.HTMLElement.prototype.scrollIntoView = () => {};
  try {
    w.eval(browser.outputFiles[0]!.text);
    await snapshot();
    w.dispatchEvent(
      new w.MessageEvent('message', {
        data: { type: 'slashCommands', items: [{ name: 'model', description: 'owned picker' }] },
      })
    );
    const field = () => w.document.querySelector('textarea')!;
    field().focus();
    field().value = '/mo';
    field().dispatchEvent(new w.Event('input', { bubbles: true }));
    w.document
      .querySelector('.slash-item')!
      .dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
    assert.equal(field().value, '');
    field().dispatchEvent(
      new w.KeyboardEvent('keydown', {
        key: 'Enter',
        repeat: true,
        bubbles: true,
        cancelable: true,
      })
    );
    assert.equal(posted.filter((m) => m.type === 'requestSend').length, 1);
    await transport;
    await new Promise((r) => setImmediate(r));
    assert.equal(opened, 0, 'discovery still held; no native focus transfer');
    const beforeRepeat = await ui.getComposerStateForIdentity(controller, identity);
    assert.equal(
      beforeRepeat.localCommandConsumed,
      posted.find((m) => m.type === 'requestSend').submissionId
    );
    field().focus();
    field().dispatchEvent(
      new w.KeyboardEvent('keydown', {
        key: 'Enter',
        repeat: true,
        bubbles: true,
        cancelable: true,
      })
    );
    assert.equal(
      posted.filter((m) => m.type === 'requestSend').length,
      1,
      'held Enter after consumption during discovery must not submit attachment-only prompt'
    );
    releaseDiscovery!();
    for (let i = 0; i < 50 && !cancel; i++) await new Promise((r) => setTimeout(r, 5));
    assert.ok(cancel, 'original payload opens held picker');
    assert.equal(opened, 1);
    const consumed = await ui.getComposerStateForIdentity(controller, identity);
    assert.equal(consumed.draft, '');
    assert.equal(
      consumed.localCommandConsumed,
      posted.find((m) => m.type === 'requestSend').submissionId
    );
    assert.equal(consumed.localCommandAck, undefined);
    assert.match(w.document.body.textContent!, /kept.png/);
    field().focus();
    field().dispatchEvent(
      new w.KeyboardEvent('keydown', {
        key: 'Enter',
        repeat: true,
        bubbles: true,
        cancelable: true,
      })
    );
    assert.equal(
      posted.filter((m) => m.type === 'requestSend').length,
      1,
      'held Enter after correlated consumption must not submit attachment-only prompt'
    );
    field().value = 'newer text';
    field().dispatchEvent(new w.Event('input', { bubbles: true }));
    await transport;
    cancel!();
    await Promise.all(tasks);
    assert.equal(field().value, 'newer text');
    const final = await ui.getComposerStateForIdentity(controller, identity);
    assert.equal(final.draft, 'newer text');
    assert.equal(final.localCommandAck, undefined);
    assert.equal(final.pendingImages.length, 1);
    // Observe fresh frontend intent without sending the owned attachment to a provider.
    forwardRequests = false;
    field().value = '';
    field().dispatchEvent(new w.Event('input', { bubbles: true }));
    field().dispatchEvent(
      new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    );
    assert.equal(
      posted.filter((m) => m.type === 'requestSend').length,
      2,
      'fresh chip-only Enter after cancellation must remain available'
    );
  } finally {
    w.close();
    ui.dispose();
  }
});
