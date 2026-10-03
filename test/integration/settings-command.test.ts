import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { createEmptyComposerState } from '../../src/webview/composer';

async function load(vscode: any) {
  const result = await build({
    stdin: {
      contents: "export {handleLocalCommand} from './src/commands/localCommand';",
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
for (const stop of [0, 1, 2, 3, 4, 5]) {
  test(`settings staged native UI: cancellation step ${stop}; save only after explicit default consent`, async () => {
    let step = 0,
      saves = 0,
      notices = 0;
    const m = await load({
      window: {
        showQuickPick: async (items: any[]) => (step++ === stop ? undefined : items[0]),
        showInformationMessage: () => {
          notices++;
          if (stop === 5) throw new Error('Owned notification failure after successful save');
          return Promise.resolve(undefined);
        },
      },
    });
    const state = createEmptyComposerState();
    state.draft = '/settings';
    state.pendingImages = [
      { itemId: 'keep', name: 'dummy.png', mimeType: 'image/png', sizeBytes: 1 },
    ];
    const row = {
      key: 'retry',
      label: 'Retry',
      choices: [false, true],
      global: true,
      project: null,
      effective: true,
      active: true,
      effect: 'live',
      source: 'global',
    };
    const controller = {
      generation: 1,
      snapshot: {
        state: { sessionId: 'owned', sessionFile: 'owned', isStreaming: true },
        queue: { steering: [], followUp: [] },
      },
      getPreferences: async () => ({ revision: 'a'.repeat(64), rows: [row] }),
      savePreference: async (key: string, value: unknown, revision: string, paid: boolean) => {
        saves++;
        assert.equal(key, 'retry');
        assert.equal(value, false);
        assert.equal(revision, 'a'.repeat(64));
        assert.equal(paid, false);
        return { rows: [{ ...row, global: false, active: false, effective: false }] };
      },
    };
    await m.handleLocalCommand(
      controller,
      structuredClone(state),
      async () => structuredClone(state),
      async (s: any) => Object.assign(state, s),
      async () => {},
      'ack'
    );
    assert.equal(saves, stop >= 4 ? 1 : 0);
    assert.equal(state.localCommandAck, stop >= 4 ? 'ack' : undefined);
    assert.equal(state.draft, '', 'picker cancellation does not restore consumed text');
    assert.equal(state.localCommandConsumed, 'ack');
    assert.equal(state.pendingImages.length, 1);
    assert.equal(notices, stop >= 4 ? 1 : 0);
  });
}
for (const change of ['origin', 'retype', 'newer'] as const) {
  test(`settings native UI preserves ${change} during asynchronous selection`, async () => {
    let state = createEmptyComposerState();
    state.draft = '/settings';
    let valid = true,
      step = 0,
      saves = 0;
    const m = await load({
      window: {
        showQuickPick: async (items: any[]) => {
          if (step++ === 1) {
            if (change === 'origin') valid = false;
            else if (change === 'retype') state.commandRevision = 1;
            else state.draft = 'newer';
          }
          return items[0];
        },
        showInformationMessage: async () => undefined,
      },
    });
    const row = {
      key: 'retry',
      label: 'Retry',
      choices: [false, true],
      global: true,
      project: null,
      effective: true,
      active: true,
      effect: 'live',
      source: 'global',
    };
    const controller = {
      generation: 1,
      snapshot: { state: { sessionId: 'owned', sessionFile: 'owned' } },
      getPreferences: async () => ({ revision: 'a'.repeat(64), rows: [row] }),
      savePreference: async () => {
        saves++;
        return { rows: [row] };
      },
    };
    await m.handleLocalCommand(
      controller,
      structuredClone(state),
      async () => structuredClone(state),
      async (s: any) => {
        state = s;
      },
      async () => {},
      'ack',
      () => valid
    );
    assert.equal(saves, change === 'origin' ? 0 : 1);
    assert.equal(state.localCommandAck, undefined);
    assert.equal(state.draft, change === 'newer' ? 'newer' : '');
    assert.equal(state.localCommandConsumed, 'ack');
  });
}
