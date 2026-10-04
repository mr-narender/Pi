import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { createEmptyComposerState } from '../../src/webview/composer';
test(`compiled final five editor all send modes preserve chips and intercept before preparation`, async () => {
  const output = await build({
    stdin: {
      contents: "export {ChatTabManager} from './src/editorTabs/tabManager'; ",
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
  let veto = false;
  new Function('require', 'module', 'exports', output.outputFiles[0]!.text)(
    (id: string) =>
      id === 'vscode'
        ? {
            workspace: { isTrusted: true },
            window: {
              showQuickPick: async (items: any[]) => (veto ? undefined : items[0]),
              showWarningMessage: async (_text: string, _opts: any, action: string) =>
                veto ? undefined : action,
              showInformationMessage: async () => undefined,
              withProgress: async (_options: any, callback: any) =>
                callback(
                  {},
                  {
                    isCancellationRequested: false,
                    onCancellationRequested: () => ({ dispose: () => {} }),
                  }
                ),
            },
            ProgressLocation: { Notification: 1 },
            authentication: { getSession: async () => ({ accessToken: 'owned-dummy' }) },
          }
        : require(id),
    module,
    module.exports
  );
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        html_url: 'https://gist.github.com/owned/abc123',
        ok: true,
        bug_report: { id: 'owned' },
      }),
      { status: 201 }
    )) as typeof fetch;
  try {
    const state = createEmptyComposerState();
    state.pendingImages = [
      { itemId: 'owned-image', name: 'owned', mimeType: 'image/png', sizeBytes: 1 },
    ];
    const order: string[] = [];
    let generation = 1;
    const controller = {
      generation: 1,
      folder: { uri: { scheme: 'file', fsPath: '/owned', toString: () => 'file:///owned' } },
      snapshot: { state: { sessionId: 'owned', sessionFile: '/owned/session' } },
      captureEngineIntent: () => {
        order.push('capture');
        const g = generation;
        return { valid: () => g === generation };
      },
      captureDeliveryIntent: () => ({
        valid: () => true,
        payload: async () => ({ jsonl: '{"type":"session"}\n' }),
      }),
      captureAuthIntent: () => ({
        valid: () => true,
        providers: async () => [
          { providerId: 'owned', name: 'Owned', stored: true, types: ['api_key'] },
        ],
        run: async () => true,
      }),
      captureLifecycleIntent: () => ({
        valid: () => true,
        prepareImport: async () => ({ nonce: 'owned', version: 3, entries: 1, cwd: '/owned' }),
        run: async () => ({
          cancelled: false,
          valid: () => true,
          replacementIdentity: { sessionId: 'owned' },
        }),
      }),
    };
    const instance = Object.create(module.exports['ChatTabManager'].prototype);
    const resource = { toString: () => 'owned-resource' };
    instance.uiState = {
      captureIdentity: () => ({}),
      getComposerStateForIdentity: async () => {
        order.push('read');
        return structuredClone(state);
      },
      setComposerStateForIdentity: async (_c: any, _i: any, next: any) =>
        Object.assign(state, next),
    };
    instance.contextForResource = () => ({ controller, target: {}, resource });
    instance.renderResource = instance.postSnapshot = async () => {};
    instance.follow = {
      armOnce: () => {
        throw new Error('No follow effects');
      },
    };
    instance.preparePromptContext = () => {
      throw new Error('No prompt/image/context effects');
    };
    const send = (mode: string) => instance.handleRequestSend(resource, mode, true, 'owned-ack');
    for (const name of ['login', 'logout', 'share', 'bug', 'import'])
      for (const mode of ['prompt', 'steer', 'follow_up']) {
        order.length = 0;
        state.draft = name === 'import' ? '/import owned.jsonl' : `/${name}`;
        state.localCommandAck = undefined;
        await send(mode);
        assert.deepEqual(order.slice(0, 2), ['capture', 'read']);
        assert.equal(state.localCommandAck, 'owned-ack', `${name} ${state.recovery?.detail}`);
        assert.equal(state.pendingImages[0]?.itemId, 'owned-image');
        veto = true;
        state.draft = name === 'import' ? '/import owned.jsonl' : `/${name}`;
        state.localCommandAck = undefined;
        await send(mode);
        assert.equal(state.localCommandAck, undefined);
        assert.equal(state.draft, name === 'import' ? '/import owned.jsonl' : '');
        if (name !== 'import') assert.equal(state.localCommandConsumed, 'owned-ack');
        veto = false;
      }
    generation++;
  } finally {
    globalThis.fetch = previousFetch;
  }
});
