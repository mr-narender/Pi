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
for (const mode of ['prompt', 'steer', 'follow_up'])
  for (const outcome of ['cancel', 'stale', 'dispose'])
    test(
      `stored callback invalidated before GUI observation editor/${mode}/${outcome}`,
      { timeout: 15000 },
      async (t) => {
        const fixture = await createNativeFixture('scopes');
        t.after(() => fixture.dispose());
        const child = await spawnNativePublicAuth(fixture, true);
        const pending = new Map<number, { resolve(data: any): void; reject(error: Error): void }>();
        let stopped: Error | undefined;
        let stage = 'native initialization';
        let fail!: (error: Error) => void;
        const interrupted = new Promise<never>((_resolve, reject) => {
          fail = reject;
        });
        const waitFor = async <T>(promise: Promise<T>, name: string): Promise<T> => {
          stage = name;
          return Promise.race([promise, interrupted]);
        };
        let seq = 0;
        let ready!: () => void;
        const initialized = new Promise<void>((r) => (ready = r));
        const lines = createInterface({ input: child.stdout! });
        lines.on('line', (line) => {
          const value = JSON.parse(line);
          if (value.oauthStore) ready();
          else {
            pending.get(value.id)?.resolve(value.data);
            pending.delete(value.id);
          }
        });
        const command = (type: string, payload?: any): Promise<any> =>
          new Promise((resolve, reject) => {
            if (stopped) return reject(stopped);
            const id = ++seq;
            pending.set(id, { resolve, reject });
            child.stdin!.write(JSON.stringify({ id, type, payload }) + '\n');
          });
        const progress = new CancellationTokenSource();
        let observeApplied: (() => void) | undefined;
        let cleanup: Promise<void> | undefined;
        const stop = () => {
          if (cleanup) return cleanup;
          stopped = new Error(`Native auth fixture stopped during ${stage}`);
          fail(stopped);
          for (const request of pending.values()) request.reject(stopped);
          pending.clear();
          progress.cancel();
          observeApplied?.();
          lines.close();
          child.stdin!.end();
          child.kill();
          cleanup = fixture.dispose();
          return cleanup;
        };
        t.after(stop);
        const abort = () => {
          void stop();
        };
        t.signal.addEventListener('abort', abort, { once: true });
        child.once('error', () => {
          void stop();
        });
        child.once('exit', () => {
          void stop();
        });
        child.stdin!.on('error', () => {
          void stop();
        });
        try {
          await waitFor(initialized, 'native initialization');
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
                "export {SessionController} from './src/sessions/sessionController';export {ChatTabManager} from './src/editorTabs/tabManager';",
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
          let reachedApplied!: () => void;
          const nativeApplied = new Promise<void>((resolve) => {
            reachedApplied = resolve;
          });
          const appliedObservation = new Promise<void>((r) => {
            observeApplied = r;
          });
          let current = true;
          const client = {
            engineCommand: async (type: string, _origin: any, payload: any) => {
              calls.push({ type, payload });
              const result = await command(type, payload);
              if (type === 'auth_poll' && result?.status === 'applied') {
                reachedApplied();
                await appliedObservation;
              }
              return result;
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
          const instance = Object.create(module.exports['ChatTabManager'].prototype);
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
          const send = instance
            .handleRequestSend(resource, mode, 'ack')
            .finally(() => (settled = true));
          await waitFor(inputEntered, 'held GUI input');
          await waitFor(command('release'), 'native callback release');
          for (let i = 0; i < 100; i++) {
            if ((await waitFor(command('inspect'), 'credential storage')).stored) break;
            await sleep(5);
          }
          assert.equal(
            (await waitFor(command('inspect'), 'stored credential inspection')).stored,
            true
          );
          // Credential storage precedes native login completion; invalidate only the held GUI observation.
          await waitFor(nativeApplied, 'native applied result before GUI observation');
          if (outcome === 'cancel') progress.cancel();
          if (outcome === 'stale') current = false;
          if (outcome === 'dispose') controller.authDisposed = true;
          await sleep(60);
          observeApplied!();
          await sleep(600);
          assert.equal(settled, true, 'operation settles without manually dismissing held UI');
          assert.equal(inputToken.isCancellationRequested, true, 'obsolete input dismissed');
          await waitFor(send, 'GUI completion');
          const native = await waitFor(command('inspect'), 'final native inspection');
          assert.equal(native.stored, true, 'already committed credential is not rolled back');
          assert.equal(native.aborted, false, 'completed native flow is not aborted');
          assert.equal(
            state.localCommandAck,
            undefined,
            'cancelled/stale/disposed origin cannot ACK'
          );
          if (outcome === 'cancel')
            assert.match(
              state.recovery?.detail ?? '',
              /already.*stored credentials|Cancellation does not revoke/
            );
          assert.equal(fixture.requests, 0);
        } finally {
          t.signal.removeEventListener('abort', abort);
          await stop();
        }
      }
    );
