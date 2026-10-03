import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { createRequire } from 'node:module';
import { createEmptyComposerState } from '../../src/webview/composer';

for (const route of ['editor', 'sidebar'])
  for (const name of ['new', 'resume', 'import', 'fork', 'clone'])
    for (const outcome of ['success', 'cancel', 'veto', 'error', 'newer', 'retyped'])
      test(`DOM IPC ${route} /${name} ${outcome} composer authority`, async () => {
        const vscode = {
          EventEmitter: class {
            event = () => {};
            fire() {}
            dispose() {}
          },
          workspace: { isTrusted: true },
          Uri: {
            from: (parts: any) => ({ ...parts, toString: () => `${parts.scheme}:${parts.path}` }),
          },
          window: {
            showOpenDialog: async () => [{ fsPath: '/owned/new.jsonl' }],
            showQuickPick: async (items: any[]) => items[0],
            showWarningMessage: async () => 'Import',
          },
        };
        const compiled = await build({
          stdin: {
            contents:
              "export { ChatTabManager } from './src/editorTabs/tabManager'; export { ChatPanelProvider } from './src/webview/provider'; export { ChatUiState } from './src/webview/composerState';",
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
          (id: string) =>
            id === 'vscode' ? vscode : createRequire(`${process.cwd()}/package.json`)(id),
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
        const oldState = { sessionId: 'old', sessionFile: '/owned/old.jsonl' };
        const newState = { sessionId: 'new', sessionFile: '/owned/new.jsonl' };
        let release!: () => void;
        const barrier = new Promise<void>((r) => {
          release = r;
        });
        let running = false;
        const controller = {
          folder: { uri: { toString: () => 'owned-workspace', scheme: 'file' } },
          snapshot: { state: oldState, isStreaming: false },
          setDraft() {},
          prompt() {
            throw Error('no actual send allowed');
          },
          captureLifecycleIntent: () => ({
            valid: () => controller.snapshot.state === oldState,
            prepareImport: async () => ({ nonce: 'owned', source: '/owned/import.jsonl' }),
            forkMessages: async () => [{ entryId: 'leaf', text: 'fork text' }],
            run: async () => {
              running = true;
              await barrier;
              if (outcome === 'error') throw Error('owned native failure');
              if (outcome === 'cancel' || outcome === 'veto')
                return { cancelled: true, valid: () => controller.snapshot.state === oldState };
              controller.snapshot.state = newState;
              return {
                cancelled: false,
                replacementIdentity: newState,
                editorText: name === 'fork' ? 'fork text' : undefined,
                valid: () => controller.snapshot.state === newState,
              };
            },
          }),
        };
        const identity = (s: any) => ({
          workspaceFolderUri: 'owned-workspace',
          kind: 'sessionFile',
          ...s,
        });
        let target = identity(oldState);
        const instance = Object.create(
          module.exports[route === 'editor' ? 'ChatTabManager' : 'ChatPanelProvider'].prototype
        );
        const host = { resource: { toString: () => 'owned.chat' } };
        instance.contextForResource = () => ({ controller, target, resource: host.resource });
        instance.registry = { getActive: () => controller, list: () => [controller] };
        instance.panel = {};
        instance.hosts = new Map([[host.resource.toString(), host]]);
        instance.promoteResource = async () => {
          target = identity(newState);
        };
        const ui = new module.exports.ChatUiState({
          workspaceState: { get: () => ({}), update: async () => {} },
          globalState: { get: () => undefined },
        });
        instance.uiState = ui;
        const image = (id: string) => ({
          itemId: id,
          name: `${id}.png`,
          mimeType: 'image/png',
          sizeBytes: 1,
        });
        const outgoing = createEmptyComposerState();
        outgoing.pendingImages = [image('outgoing')];
        const incoming = createEmptyComposerState();
        incoming.draft = 'incoming saved draft';
        incoming.pendingImages = [image('incoming')];
        for (const [s, composer] of [
          [oldState, outgoing],
          [newState, incoming],
        ] as const) {
          await ui.getComposerStateForIdentity(controller, identity(s));
          await ui.setComposerStateForIdentity(controller, identity(s), composer);
        }
        const dom = new JSDOM('<div id="app"></div>', {
          pretendToBeVisual: true,
          runScripts: 'outside-only',
        });
        const w = dom.window;
        let transport = Promise.resolve();
        const tasks: Promise<any>[] = [];
        const posted: any[] = [];
        const snapshot = async () => {
          const s = await ui.getComposerStateForIdentity(
            controller,
            identity(controller.snapshot.state)
          );
          w.dispatchEvent(
            new w.MessageEvent('message', {
              data: {
                type: 'snapshot',
                snapshot: {
                  sequence: 1,
                  title: 'Chat',
                  bindingState: 'current',
                  uiMode: 'simple',
                  connectionState: 'ready',
                  ...controller.snapshot.state,
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
        Object.assign(w, {
          acquireVsCodeApi: () => ({
            postMessage(m: any) {
              posted.push(m);
              if (['setDraft', 'requestSend'].includes(m.type))
                transport = transport.then(
                  () =>
                    new Promise<void>((resolve) =>
                      setImmediate(() => {
                        tasks.push(
                          route === 'editor' ? instance.onMessage(host, m) : instance.onMessage(m)
                        );
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
          const field = () => w.document.querySelector('textarea')!;
          field().focus();
          field().value = name === 'import' ? '/import /owned/import.jsonl' : `/${name}`;
          field().dispatchEvent(new w.Event('input', { bubbles: true }));
          field().dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          field().dispatchEvent(
            new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
          );
          await transport;
          for (let i = 0; i < 100 && !running; i++) await new Promise((r) => setTimeout(r, 2));
          assert.ok(running, 'actual parsed host route reaches the captured native intent');
          if (outcome === 'newer' || outcome === 'retyped') {
            field().value =
              outcome === 'newer'
                ? 'newer input'
                : name === 'import'
                  ? '/import /owned/import.jsonl'
                  : `/${name}`;
            field().dispatchEvent(new w.Event('input', { bubbles: true }));
            await transport;
            await new Promise((r) => setImmediate(r));
          }
          release();
          await Promise.all(tasks);
          if (outcome !== 'success') {
            const current = await ui.getComposerStateForIdentity(
              controller,
              identity(controller.snapshot.state)
            );
            assert.equal(
              current.localCommandAck,
              undefined,
              'no success ACK for cancellation/failure or newer edit'
            );
            assert.match(w.document.body.textContent!, /outgoing.png/);
            if (outcome === 'newer' || outcome === 'retyped') {
              const text =
                outcome === 'newer'
                  ? 'newer input'
                  : name === 'import'
                    ? '/import /owned/import.jsonl'
                    : `/${name}`;
              assert.equal(
                field().value,
                text,
                'replacement must not overwrite newer/retyped input'
              );
              assert.equal(current.draft, `incoming saved draft\n${text}`);
              assert.match(w.document.body.textContent!, /incoming.png/);
            } else {
              assert.equal(controller.snapshot.state, oldState);
              assert.equal(current.pendingImages.length, 1);
              assert.equal(
                field().value,
                ['resume', 'fork'].includes(name)
                  ? ''
                  : name === 'import'
                    ? '/import /owned/import.jsonl'
                    : `/${name}`
              );
            }
            return;
          }
          const next = await ui.getComposerStateForIdentity(controller, identity(newState));
          const expected =
            name === 'fork' ? 'incoming saved draft\nfork text' : 'incoming saved draft';
          assert.equal(
            next.draft,
            expected,
            'native returned text and incoming saved draft retained'
          );
          assert.equal(
            next.localCommandAck,
            posted.find((m) => m.type === 'requestSend').submissionId
          );
          assert.equal(field().value, next.draft, 'visible composer equals next-send host state');
          assert.match(w.document.body.textContent!, /incoming.png/);
          assert.match(w.document.body.textContent!, /outgoing.png/);
          const savedOld = await ui.getComposerStateForIdentity(controller, identity(oldState));
          assert.deepEqual(
            savedOld.pendingImages.map((i: any) => i.name),
            ['outgoing.png']
          );
          assert.deepEqual(
            next.pendingImages.map((i: any) => i.name),
            ['incoming.png', 'outgoing.png']
          );
          // Replays cannot overwrite newer or identically retyped input.
          for (const text of ['newer input', expected]) {
            field().value = text;
            field().dispatchEvent(new w.Event('input', { bubbles: true }));
            await snapshot();
            assert.equal(field().value, text);
            assert.match(w.document.body.textContent!, /incoming.png/);
          }
          const stale = {
            sequence: 99,
            title: 'Chat',
            bindingState: 'current',
            uiMode: 'simple',
            connectionState: 'ready',
            ...newState,
            messages: [],
            queue: { steering: [], followUp: [] },
            statuses: {},
            widgets: [],
            isTrusted: true,
            folders: [],
            ...next,
            draft: 'stale completion',
            pendingImages: [],
          };
          for (const change of [
            { sessionId: 'unrelated' },
            { sessionFile: '/owned/unrelated.jsonl' },
            { localCommandAck: 'wrong-generation:1' },
            { composerResetSeq: 500 },
            {
              localCommandReplacement: { ...next.localCommandReplacement, originKey: 'unrelated' },
            },
          ]) {
            w.dispatchEvent(
              new w.MessageEvent('message', {
                data: { type: 'snapshot', snapshot: { ...stale, ...change } },
              })
            );
            assert.equal(field().value, expected, 'stale/unrelated ACK has no composer authority');
            assert.match(w.document.body.textContent!, /incoming.png/);
          }
        } finally {
          release();
          w.close();
          ui.dispose();
        }
      });
