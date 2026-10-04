import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const compiled = build({
  stdin: {
    contents:
      "export {ChatTabManager} from './src/editorTabs/tabManager'; export {SessionController} from './src/sessions/sessionController';",
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
  external: ['vscode'],
});
const browser = build({
  entryPoints: ['src/webview/media/chat.ts'],
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'iife',
});
async function classes() {
  const m = { exports: {} as any };
  new Function('require', 'module', 'exports', (await compiled).outputFiles[0]!.text)(
    (name: string) => {
      if (name === 'vscode')
        return {
          workspace: { isTrusted: true },
          EventEmitter: class {
            fire() {}
            dispose() {}
            event() {}
          },
        };
      if (name.startsWith('node:')) return createRequire(`${process.cwd()}/package.json`)(name);
      throw Error(name);
    },
    m,
    m.exports
  );
  return m.exports;
}
for (const initial of ['starting', 'ready'])
  test(`catalog editor ${initial}: locals, recovery, bounded input, empty and typed command`, async () => {
    const c = await classes();
    const controller = Object.create(c.SessionController.prototype);
    let attached = initial === 'ready',
      fail = false,
      calls = 0;
    const client = {
      getCommands: async () => {
        calls++;
        if (fail) throw Error('transient');
        return {
          commands: [
            { name: 'native-owned', description: 'extension' },
            { name: 'skill:owned', description: 'skill' },
            { name: 'template-owned', description: 'template' },
          ],
        };
      },
    };
    controller.supervisor = {
      get currentClient() {
        return attached ? client : undefined;
      },
      currentGeneration: 1,
    };
    controller.state = { state: { sessionId: 'owned' }, commands: [], connectionState: initial };
    controller.fire = () => {};
    const instance = Object.create(c['ChatTabManager'].prototype);
    const target = { kind: 'sessionId', sessionId: 'owned' };
    const host = {
      resource: { toString: () => 'owned.chat' },
      post: (data: any) => receive(data),
    };
    instance.contextForResource = () => ({ controller, target, resource: host.resource });
    instance.registry = { getActive: () => controller };
    instance.panel = { webview: { postMessage: (data: any) => receive(data) } };
    const dom = new JSDOM('<div id="app"></div>', {
      runScripts: 'outside-only',
      pretendToBeVisual: true,
    });
    const w = dom.window,
      posted: any[] = [];
    let transport = Promise.resolve();
    const receive = (data: any) => w.dispatchEvent(new w.MessageEvent('message', { data }));
    Object.assign(w, {
      acquireVsCodeApi: () => ({
        postMessage(m: any) {
          posted.push(m);
          if (m.type === 'requestSlashCommands')
            transport = transport
              .then(() => new Promise<void>((resolve) => setImmediate(resolve)))
              .then(() => instance.onMessage(host, m));
        },
        getState() {},
        setState() {},
      }),
      matchMedia: () => ({ matches: false, addEventListener() {} }),
      ResizeObserver: class {
        observe() {}
        disconnect() {}
      },
      IntersectionObserver: class {
        observe() {}
        disconnect() {}
      },
    });
    w.HTMLElement.prototype.scrollTo = () => {};
    w.HTMLElement.prototype.scrollIntoView = () => {};
    let sequence = 0;
    const snapshot = (connectionState: string, sessionId = 'owned') =>
      receive({
        type: 'snapshot',
        snapshot: {
          sequence: ++sequence,
          title: 'Owned',
          bindingState: 'current',
          connectionState,
          sessionId,
          messages: [],
          queue: { steering: [], followUp: [] },
          statuses: {},
          widgets: [],
          isTrusted: true,
          folders: [],
          draft: '',
          pendingImages: [],
          pendingContextItems: [],
        },
      });
    const input = (text: string) => {
      const f = w.document.querySelector('textarea')!;
      f.value = text;
      f.dispatchEvent(new w.Event('input', { bubbles: true }));
    };
    try {
      w.eval((await browser).outputFiles[0]!.text);
      snapshot(initial);
      input('/hot');
      assert.match(
        w.document.body.textContent!,
        /hotkeys/,
        'local entries visible BEFORE queued RPC runs'
      );
      await transport;
      assert.match(
        w.document.body.textContent!,
        /hotkeys/,
        'local core catalog exists before attachment'
      );
      if (!attached) {
        attached = true;
        controller.state.connectionState = 'ready';
        snapshot('ready');
        await transport;
      }
      input('/native');
      await transport;
      assert.match(
        w.document.body.textContent!,
        /native-owned/,
        'ready event refreshes partial startup catalog'
      );
      const count = calls;
      for (let i = 0; i < 30; i++) input('/native');
      await transport;
      assert.equal(calls, count);
      attached = false;
      controller.state.connectionState = 'starting';
      snapshot('starting');
      fail = true;
      attached = true;
      controller.state.connectionState = 'ready';
      snapshot('ready');
      await transport;
      fail = false;
      input('/native');
      await transport;
      assert.match(w.document.body.textContent!, /native-owned/, 'transient failure recovers');
      assert.ok(calls <= count + 2, 'bounded event-driven retry');
      input('/hotkeys');
      const field = w.document.querySelector('textarea')!;
      field.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      field.dispatchEvent(
        new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
      );
      assert.equal(posted.filter((m) => m.type === 'requestSend').length, 1);
      client.getCommands = async () => {
        calls++;
        return { commands: [] };
      };
      snapshot('starting');
      snapshot('ready');
      input('/hot');
      await transport;
      assert.match(w.document.body.textContent!, /hotkeys/, 'empty remote still merges locals');
      const emptyCount = calls;
      input('/hot');
      await transport;
      assert.equal(calls, emptyCount);
      const oldRequest = posted.filter((m) => m.type === 'requestSlashCommands').at(-1);
      snapshot('ready', 'new-owner');
      input('/hot');
      await transport;
      receive({
        type: 'slashCommands',
        requestId: oldRequest.requestId,
        items: [{ name: 'poison', description: '' }],
      });
      input('/poison');
      assert.equal(w.document.querySelector('#slash-menu'), null, 'old context reply rejected');
    } finally {
      w.close();
    }
  });
test('actual controller rejects late client/generation and overlapping old reply', async () => {
  const c = await classes();
  const controller = Object.create(c.SessionController.prototype);
  let resolve!: (v: any) => void;
  const old = {
    getCommands: () =>
      new Promise((r) => {
        resolve = r;
      }),
  };
  controller.supervisor = { currentClient: old, currentGeneration: 1 };
  controller.state = { state: { sessionId: 'old' }, commands: [], connectionState: 'ready' };
  controller.fire = () => {};
  const pending = controller.getPiCommands();
  controller.supervisor.currentClient = {
    getCommands: async () => ({ commands: [{ name: 'new-owned' }] }),
  };
  controller.supervisor.currentGeneration++;
  controller.state.state.sessionId = 'new';
  await controller.getPiCommands();
  resolve({ commands: [{ name: 'old-poison' }] });
  await pending.catch(() => {});
  assert.ok(controller.state.commands.some((v: any) => v.name === 'new-owned'));
  assert.ok(!controller.state.commands.some((v: any) => v.name === 'old-poison'));
});
