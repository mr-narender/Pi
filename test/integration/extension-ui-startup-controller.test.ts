import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createNativeFixture, nativeSdkHostPlan, resolveNativeCli } from '../helpers/nativeFixture';
import { isSupportedPiSdkVersion, SUPPORTED_PI_SDK_VERSIONS } from '../../src/process/piLauncher';

const browserBundle = build({
  entryPoints: ['src/webview/media/chat.ts'],
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'iife',
});

for (const outcome of ['answer', 'cancel', 'stop'] as const) {
  test(
    `production controller renders native startup UI before open and handles ${outcome}`,
    { timeout: 15000 },
    async (t) => {
      const fixture = await createNativeFixture('startup-ui', 'selected-sdk');
      let cleaned = false;
      t.after(async () => {
        if (!cleaned) await fixture.dispose();
      });
      const selected = await resolveNativeCli('path-cli');
      assert.equal(selected.version, '1.3.0');
      const plan = await nativeSdkHostPlan(fixture, 'shared');
      const env = {
        ...plan.env,
        NODE_OPTIONS: fixture.nodeArgs.map((arg) => JSON.stringify(arg)).join(' '),
      };
      const built = await build({
        stdin: {
          contents: `export { PiProcessSupervisor } from './src/process/supervisor';
        export { SessionController } from './src/sessions/sessionController';
        export { SharedPiHost, initSharedPiHost, disposeSharedPiHost } from './src/process/sharedPiHost';
        export { createInitialControllerState } from './src/state/types';
        export { createEmptyComposerState } from './src/webview/composer';
        export { createWebviewSnapshot } from './src/webview/model';
        export { parseWebviewMessage } from './src/webview/messages';
        export { renderChatApp } from './src/webview/render';`,
          resolveDir: process.cwd(),
        },
        bundle: true,
        write: false,
        platform: 'node',
        format: 'cjs',
        external: ['vscode', 'owned-startup-plan'],
        plugins: [
          {
            name: 'owned-sealed-native-launch',
            setup(builder) {
              builder.onLoad({ filter: /piLauncher\.ts$/ }, () => ({
                contents:
                  "export { piLaunchEnvironment, resolvePiLaunch, isSupportedPiSdkVersion, SUPPORTED_PI_SDK_VERSIONS } from 'owned-startup-plan';",
                loader: 'ts',
              }));
            },
          },
        ],
      });
      const require = createRequire(`${process.cwd()}/package.json`),
        mod = { exports: {} as any };
      const vscode = {
        workspace: {
          isTrusted: true,
          getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }),
        },
        window: {},
      };
      new Function('require', 'module', 'exports', built.outputFiles[0]!.text)(
        (name: string) =>
          name === 'vscode'
            ? vscode
            : name === 'owned-startup-plan'
              ? {
                  isSupportedPiSdkVersion,
                  SUPPORTED_PI_SDK_VERSIONS,
                  piLaunchEnvironment: () => env,
                  resolvePiLaunch: () => ({
                    command: plan.command,
                    prefixArgs: [],
                    usingBundled: true,
                    mode: 'subprocess',
                    label: 'owned sealed native Pi',
                    sdkRoot: selected.root,
                    cwd: fixture.cwd,
                    env,
                  }),
                }
              : require(name),
        mod,
        mod.exports
      );
      const logger = { info() {}, warn() {}, error() {} };
      // Only the fixture's sealed artifact location differs from the shipped layout.
      mod.exports.SharedPiHost.scriptPath = () => plan.args.at(-1)!;
      const pool = mod.exports.initSharedPiHost(
        fixture.root,
        env,
        logger,
        async () => selected.root,
        1
      );
      let openAcknowledged = false;
      const openSession = pool.openSession.bind(pool);
      pool.openSession = (...args: any[]) =>
        openSession(...args).then((handle: unknown) => {
          openAcknowledged = true;
          return handle;
        });
      const folder = { name: 'Owned startup', uri: { fsPath: fixture.cwd, scheme: 'file' } };
      const supervisor = new mod.exports.PiProcessSupervisor(folder, logger, {
        sharedRuntime: true,
        additionalArgs: [...plan.open.args],
        offline: true,
        allowApproveInTrustedWorkspace: false,
        maxRecordBytes: 1000000,
        maxPendingRequests: 64,
        maxQueuedWrites: 64,
        responseTimeoutMs: 10000,
        longRunningTimeoutMs: 15000,
      });
      const changes: Array<() => void> = [];
      const controller = Object.create(mod.exports.SessionController.prototype);
      Object.assign(controller, {
        state: mod.exports.createInitialControllerState('owned', fixture.cwd),
        folder,
        logger,
        supervisor,
        settings: { offline: true },
        navigationEpoch: 1,
        authDisposed: false,
        changeEmitter: {
          fire() {
            for (const listener of changes) listener();
          },
        },
        extensionUiEmitter: { fire() {} },
        reconcile: async () => {
          const native = await supervisor.currentClient.getState();
          controller.state = { ...controller.state, state: native, connectionState: 'ready' };
        },
      });
      controller.state.connectionState = 'starting';
      const dom = new JSDOM('<div id="app"></div>', {
        pretendToBeVisual: true,
        runScripts: 'outside-only',
        url: 'https://webview.test/',
      });
      t.after(() => dom.window.close());
      const w = dom.window;
      let nativeResponse: Promise<void> | undefined;
      Object.assign(w, {
        acquireVsCodeApi: () => ({
          postMessage(message: unknown) {
            const parsed = mod.exports.parseWebviewMessage(message);
            if (parsed?.type !== 'respondUi') return;
            nativeResponse = controller.respondExtensionUi(
              {
                id: parsed.id,
                value: parsed.value,
                confirmed: parsed.confirmed,
                cancelled: parsed.cancelled,
              },
              parsed.requestKey
            );
          },
          getState() {},
          setState() {},
        }),
        ResizeObserver: class {
          observe() {}
          unobserve() {}
          disconnect() {}
        },
        IntersectionObserver: class {
          observe() {}
          unobserve() {}
          disconnect() {}
        },
        matchMedia: () => ({
          matches: false,
          addEventListener() {},
          removeEventListener() {},
          addListener() {},
          removeListener() {},
        }),
      });
      w.HTMLElement.prototype.scrollTo = () => {};
      w.HTMLElement.prototype.scrollIntoView = () => {};
      w.eval((await browserBundle).outputFiles[0]!.text);
      let shownBeforeOpen = false,
        controlsEnabled = false,
        presented = false,
        response: Promise<void> | undefined;
      changes.push(() => {
        const pending = controller.snapshot.pendingUi.find(
          (request: any) => request.method === 'input'
        );
        if (!pending || presented) return;
        presented = true;
        const snapshot = mod.exports.createWebviewSnapshot(controller.snapshot, 1, {
          composer: mod.exports.createEmptyComposerState(),
          isTrusted: true,
          folders: [],
        });
        response = (async () => {
          const rendered = new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => {
              observer.disconnect();
              reject(new Error('Startup prompt did not render'));
            }, 2000);
            const observer = new w.MutationObserver(() => {
              if (!w.document.querySelector('[data-ui-input-submit]')) return;
              clearTimeout(timeout);
              observer.disconnect();
              resolve();
            });
            observer.observe(w.document.getElementById('app')!, { childList: true, subtree: true });
          });
          w.dispatchEvent(new w.MessageEvent('message', { data: { type: 'snapshot', snapshot } }));
          await rendered;
          const submit = w.document.querySelector<HTMLButtonElement>('[data-ui-input-submit]')!;
          const cancel = w.document.querySelector<HTMLButtonElement>('[data-ui-cancelled]')!;
          const field = w.document.querySelector<HTMLInputElement>('.approval-input')!;
          controlsEnabled = !submit.disabled && !cancel.disabled && !field.readOnly;
          shownBeforeOpen = !openAcknowledged;
          assert.equal(controlsEnabled, true, 'real startup controls must accept user input');
          if (outcome === 'stop') {
            await controller.stop();
            return;
          }
          if (outcome === 'cancel') cancel.click();
          else {
            field.value = 'Owned production answer';
            field.dispatchEvent(new w.Event('input', { bubbles: true }));
            field.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
          }
          assert.ok(nativeResponse, 'the real webview must post a validated response');
          await nativeResponse;
        })();
        void response.catch(() => {});
      });
      try {
        await controller.start();
        await response;
        assert.equal(
          controlsEnabled,
          true,
          'startup Submit and Cancel must be enabled before native open completes'
        );
        assert.equal(
          shownBeforeOpen,
          true,
          'the real controller must render before native open completes'
        );
        const deadline = Date.now() + 2000;
        while (
          !(await readFile(join(fixture.cwd, 'startup-ui-trace.jsonl'), 'utf8').catch(() => ''))
        ) {
          assert.ok(
            Date.now() < deadline,
            'native startup callback must settle after the GUI decision'
          );
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        const recorded = JSON.parse(
          (await readFile(join(fixture.cwd, 'startup-ui-trace.jsonl'), 'utf8')).trim()
        );
        assert.equal(recorded.value, outcome === 'answer' ? 'Owned production answer' : null);
        if (outcome === 'stop') {
          assert.equal(controller.snapshot.connectionState, 'stopped');
          assert.equal(supervisor.currentClient, undefined);
          assert.ok(
            pool.poolStatus().every((worker: { sessions: number }) => worker.sessions === 0)
          );
        }
        assert.equal(fixture.requests, 0);
      } finally {
        await supervisor.stop();
        mod.exports.disposeSharedPiHost();
        await fixture.dispose();
        cleaned = true;
      }
    }
  );
}
