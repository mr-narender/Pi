import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { createEmptyComposerState } from '../../src/webview/composer';

async function load(vscode: unknown) {
  const result = await build({
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
  const module = { exports: {} as any };
  new Function('require', 'module', 'exports', result.outputFiles[0]!.text)(
    (id: string) => (id === 'vscode' ? vscode : createRequire(`${process.cwd()}/package.json`)(id)),
    module,
    module.exports
  );
  return module.exports;
}

{
  test(`editor: captured command origin survives held first UI read`, async () => {
    let effects = 0;
    const compiled = await load({
      workspace: { isTrusted: true },
      window: {
        showInformationMessage: async () => {
          effects++;
          return 'Copy JSON';
        },
      },
      env: {
        clipboard: {
          writeText: async () => {
            effects++;
          },
        },
      },
    });
    for (const change of ['generation', 'session', 'file', 'client', 'controller', 'focus']) {
      for (const command of [
        '/debug',
        '/copy',
        '/model',
        '/scoped-models',
        '/thinking',
        '/name',
        '/session',
        '/hotkeys',
        '/changelog',
        '/export',
        '/compact',
      ]) {
        const controller = Object.create(compiled.SessionController.prototype);
        controller.supervisor = { currentGeneration: 1, currentClient: {} };
        controller.state = {
          state: { sessionId: 'original', sessionFile: '/owned/original' },
          queue: {},
          lastSessionStats: { cost: 1 },
        };
        // Any dispatch is an observable failure for a stale origin, including siblings.
        for (const name of [
          'getAvailableModels',
          'copyLastAssistantText',
          'getSessionStats',
          'captureExportIntent',
          'captureCompactIntent',
        ]) {
          controller[name] = () => {
            effects++;
            throw new Error('stale dispatch');
          };
        }
        const replacement = Object.create(compiled.SessionController.prototype);
        replacement.supervisor = { currentGeneration: 2, currentClient: {} };
        replacement.state = {
          state: { sessionId: 'replacement', sessionFile: '/owned/replacement' },
          queue: {},
        };
        let active = controller;
        let target = { sessionId: 'original', sessionFile: '/owned/original' };
        const state = createEmptyComposerState();
        state.draft = command;
        state.commandRevision = 3;
        state.pendingContextItems = [{ itemId: 'chip' } as any];
        state.pendingImages = [{ itemId: 'image' } as any];
        let release!: () => void;
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        let entered!: () => void;
        const started = new Promise<void>((resolve) => {
          entered = resolve;
        });
        let reads = 0;
        const get = async () => {
          if (++reads === 1) {
            entered();
            await held;
          }
          return structuredClone(state);
        };
        const instance = Object.create(compiled['ChatTabManager'].prototype);
        instance.registry = { getActive: () => active };
        instance.uiState = {
          captureIdentity: () => ({ ...target }),
          getComposerState: get,
          getComposerStateForIdentity: get,
          setComposerStateForIdentity: async (_c: unknown, _i: unknown, next: unknown) => {
            effects++;
            Object.assign(state, next);
          },
        };
        instance.contextForResource = () => ({ controller: active, target });
        instance.renderResource = instance.postSnapshot = async () => {};
        const beforeEffects = effects;
        const sending = instance.handleRequestSend({}, 'prompt', 'ack');
        await started;
        if (change === 'generation') controller.supervisor.currentGeneration++;
        if (change === 'session') controller.state.state.sessionId = 'replacement';
        if (change === 'file') controller.state.state.sessionFile = '/owned/replacement';
        if (change === 'client') controller.supervisor.currentClient = {};
        if (change === 'controller') active = replacement;
        if (change === 'focus') {
          target = { sessionId: 'other', sessionFile: '/owned/other' };
          active = controller;
        }
        // Preserve newer/retyped draft revision and current chips, not a stale clone.
        state.commandRevision++;
        const snapshot = structuredClone(state);
        release();
        await sending;
        assert.equal(
          effects,
          beforeEffects,
          `editor ${change} ${command}: no stale dispatch/effect`
        );
        assert.deepEqual(state, snapshot, `editor ${change} ${command}: preserve draft/chips/ACK`);
      }
    }
  });
}
