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
    for (const reason of ['cancel', 'stale', 'late', 'native'])
      test(`public native callback barrier ${route}/${mode}/${reason}`, async () => {
        const fixture = await createNativeFixture('scopes');
        const child = await spawnNativePublicAuth(fixture, true);
        const pending = new Map<number, (data: any) => void>();
        let ready!: () => void;
        const initialized = new Promise<void>((r) => {
          ready = r;
        });
        const lines = createInterface({ input: child.stdout! });
        let output = '',
          errors = '',
          seq = 0;
        child.stderr!.on('data', (b) => {
          errors += b;
        });
        lines.on('line', (line) => {
          output += line;
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
        try {
          await initialized;
          let cancel!: () => void, entered!: () => void, dismiss!: (s: string) => void;
          const inputEntered = new Promise<void>((r) => {
            entered = r;
          });
          let inputToken: any;
          const progress = new CancellationTokenSource();
          cancel = () => progress.cancel();
          const ui = {
            CancellationTokenSource,
            workspace: { isTrusted: true },
            ProgressLocation: { Notification: 1 },
            window: {
              showQuickPick: async (items: any[]) => items[0],
              showWarningMessage: async (_a: string, _b: any, action: string) => action,
              showInputBox: (_options: any, token: any) => {
                inputToken = token;
                entered();
                return new Promise<string>((r) => {
                  dismiss = r;
                });
              },
              withProgress: async (_options: any, f: any) => f({}, progress.token),
            },
          };
          const compiled = await build({
            stdin: {
              contents:
                "export {SessionController} from './src/sessions/sessionController'; export {ChatTabManager} from './src/editorTabs/tabManager'; export {ChatPanelProvider} from './src/webview/provider';",
              resolveDir: process.cwd(),
            },
            bundle: true,
            write: false,
            platform: 'node',
            format: 'cjs',
            external: ['vscode'],
          });
          const module = { exports: {} as any },
            require = createRequire(`${process.cwd()}/package.json`);
          new Function('require', 'module', 'exports', compiled.outputFiles[0]!.text)(
            (id: string) => (id === 'vscode' ? ui : require(id)),
            module,
            module.exports
          );
          let generation = 1;
          const calls: any[] = [];
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
            folder: { uri: { scheme: 'file', fsPath: '/owned', toString: () => 'file:///owned' } },
            captureLocalCommandOrigin: () => {
              const g = generation;
              return () => g === generation;
            },
            assertNoManualCompaction() {},
            refreshState: async () => {},
            captureEngineIntent: () => {
              const g = generation;
              return { valid: () => g === generation };
            },
          };
          controller.captureAuthIntent = () =>
            module.exports.SessionController.prototype.captureAuthIntent.call(controller);
          const state = createEmptyComposerState();
          state.draft = '/login';
          state.pendingImages = [
            { itemId: 'owned', name: 'owned', mimeType: 'image/png', sizeBytes: 1 },
          ];
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
          instance.follow = {
            armOnce: () => {
              throw new Error('No follow');
            },
          };
          instance.preparePromptContext = () => {
            throw new Error('No prompt preparation');
          };
          const send =
            route === 'editor'
              ? instance.handleRequestSend(resource, mode, true, 'owned-ack')
              : instance.handleRequestSend(controller, mode, 'owned-ack');
          await inputEntered;
          if (reason === 'late') {
            await command('release');
            await sleep(150);
            assert.equal(
              (await command('inspect')).stored,
              true,
              'native callback already committed'
            );
            cancel();
          } else if (reason === 'cancel') cancel();
          else if (reason === 'native') await command('cancel_native');
          else generation++;
          await sleep(150);
          if (reason !== 'late')
            assert.equal(
              (await command('inspect')).aborted,
              true,
              'native signal must abort before manual UI resolves'
            );
          assert.equal(
            inputToken.isCancellationRequested,
            true,
            'native VS Code token dismisses pending input'
          );
          if (reason !== 'late') {
            await command('release');
            await sleep(100);
            assert.deepEqual(await command('inspect'), {
              aborted: true,
              stored: false,
              canary: false,
            });
          } else {
            assert.equal((await command('inspect')).stored, true);
          }
          await send;
          dismiss('PRIVATE_GUI_CANARY');
          await sleep(20);
          assert.equal(JSON.stringify(calls).includes('PRIVATE_GUI_CANARY'), false);
          assert.equal((output + errors).includes('PRIVATE_OWNED_CALLBACK_CANARY'), false);
          if (reason === 'late')
            assert.match(
              state.recovery?.detail ?? '',
              /already.*stored credentials|Cancellation does not revoke/
            );
          assert.equal(state.localCommandAck, undefined);
          assert.equal(state.draft, '', 'invoking text consumed independently of native success');
          assert.ok(state.localCommandConsumed);
          assert.equal(state.pendingImages[0]?.itemId, 'owned');
          assert.ok(
            calls.every((c) =>
              ['auth_providers', 'auth_login', 'auth_poll', 'auth_response'].includes(c.type)
            )
          );
          assert.equal(fixture.requests, 0);
        } finally {
          lines.close();
          child.stdin!.end();
          child.kill();
          await fixture.dispose();
        }
      });
