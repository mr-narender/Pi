import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';
import { createNativeFixture, spawnNativePublicAuth } from '../helpers/nativeFixture';
import { createEmptyComposerState } from '../../src/webview/composer';
class CancellationTokenSource {
  listeners = new Set<() => void>();
  token = {
    isCancellationRequested: false,
    onCancellationRequested: (f: () => void) => {
      this.listeners.add(f);
      return { dispose: () => this.listeners.delete(f) };
    },
  };
  cancel() {
    this.token.isCancellationRequested = true;
    for (const f of this.listeners) f();
  }
  dispose() {
    this.listeners.clear();
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
for (const route of ['editor', 'sidebar'])
  for (const mode of ['prompt', 'steer', 'follow_up'])
    for (const outcome of ['applied', 'cancel', 'stale', 'dispose'])
      test(
        `native callback completion ${route}/${mode}/${outcome}`,
        { timeout: 15000 },
        async () => {
          const fixture = await createNativeFixture('scopes');
          const child = await spawnNativePublicAuth(fixture, true);
          const pending = new Map<number, (data: any) => void>();
          let seq = 0;
          let ready!: () => void;
          const initialized = new Promise<void>((r) => (ready = r));
          const lines = createInterface({ input: child.stdout! });
          lines.on('line', (line) => {
            const value = JSON.parse(line);
            if (value.oauthStore) ready();
            else {
              pending.get(value.id)?.(value.data);
              pending.delete(value.id);
            }
          });
          const command = (type: string, payload?: any): Promise<any> =>
            new Promise((resolve) => {
              const id = ++seq;
              pending.set(id, resolve);
              child.stdin!.write(JSON.stringify({ id, type, payload }) + '\n');
            });
          const progress = new CancellationTokenSource();
          try {
            await initialized;
            let entered!: () => void;
            const inputEntered = new Promise<void>((r) => (entered = r));
            let inputToken: any;
            const ui = {
              CancellationTokenSource,
              workspace: { isTrusted: true },
              ProgressLocation: { Notification: 1 },
              window: {
                showQuickPick: async (items: any[]) => items[0],
                showWarningMessage: async (_a: string, _b: any, action: string) => action,
                showInputBox: (_opts: any, token: any) => {
                  inputToken = token;
                  entered();
                  return new Promise<string>(() => {});
                },
                withProgress: async (_opts: any, f: any) => f({}, progress.token),
              },
            };
            const compiled = await build({
              stdin: {
                contents:
                  "export {SessionController} from './src/sessions/sessionController';export {ChatTabManager} from './src/editorTabs/tabManager';export {ChatPanelProvider} from './src/webview/provider';",
                resolveDir: process.cwd(),
              },
              bundle: true,
              write: false,
              platform: 'node',
              format: 'cjs',
              external: ['vscode'],
            });
            const module = { exports: {} as any };
            const require = createRequire(`${process.cwd()}/package.json`);
            new Function('require', 'module', 'exports', compiled.outputFiles[0]!.text)(
              (id: string) => (id === 'vscode' ? ui : require(id)),
              module,
              module.exports
            );
            const calls: any[] = [];
            let current = true;
            const client = {
              engineCommand: async (type: string, _origin: any, payload: any) => {
                calls.push({ type, payload });
                return command(type, payload);
              },
            };
            const controller: any = {
              supervisor: { currentClient: client },
              generation: 1,
              state: {
                state: { sessionId: 'owned', sessionFile: '/owned/session' },
                leafId: 'owned',
              },
              snapshot: { state: { sessionId: 'owned', sessionFile: '/owned/session' } },
              folder: {
                uri: { scheme: 'file', fsPath: '/owned', toString: () => 'file:///owned' },
              },
              captureLocalCommandOrigin: () => () => current,
              assertNoManualCompaction() {},
              refreshState: async () => {},
              captureEngineIntent: () => ({ valid: () => current }),
            };
            controller.captureAuthIntent = () =>
              module.exports.SessionController.prototype.captureAuthIntent.call(controller);
            const state = createEmptyComposerState();
            state.draft = '/login';
            const instance = Object.create(
              module.exports[route === 'editor' ? 'ChatTabManager' : 'ChatPanelProvider'].prototype
            );
            const resource = { toString: () => 'owned-resource' };
            instance.uiState = {
              captureIdentity: () => ({}),
              getComposerStateForIdentity: async () => structuredClone(state),
              setComposerStateForIdentity: async (_c: any, _i: any, next: any) =>
                Object.assign(state, next),
            };
            instance.contextForResource = () => ({ controller, target: {}, resource });
            instance.renderResource = instance.postSnapshot = async () => {};
            instance.preparePromptContext = () => {
              throw Error('Unexpected send');
            };
            let settled = false;
            const send = (
              route === 'editor'
                ? instance.handleRequestSend(resource, mode, false, 'ack')
                : instance.handleRequestSend(controller, mode, 'ack')
            ).finally(() => (settled = true));
            await inputEntered;
            if (outcome === 'cancel') progress.cancel();
            if (outcome === 'stale') current = false;
            if (outcome === 'dispose') controller.authDisposed = true;
            if (outcome !== 'applied') await sleep(60);
            await command('release');
            await sleep(600);
            assert.equal(settled, true, 'operation settles without manually dismissing held UI');
            assert.equal(inputToken.isCancellationRequested, true, 'obsolete input dismissed');
            await send;
            const native = await command('inspect');
            assert.equal(native.stored, outcome === 'applied');
            assert.equal(
              native.aborted,
              outcome !== 'applied',
              'completed native auth must NOT abort'
            );
            if (outcome === 'applied') {
              assert.ok(state.localCommandAck, 'success ACK belongs to owned origin');
              assert.equal(
                calls.some((c) => c.type === 'auth_response'),
                false,
                'no cancellation or stale secret after completion'
              );
            } else assert.equal(state.localCommandAck, undefined, 'no old operation success ACK');
            assert.equal(fixture.requests, 0);
          } finally {
            progress.cancel();
            lines.close();
            child.stdin!.end();
            child.kill();
            await fixture.dispose();
          }
        }
      );
