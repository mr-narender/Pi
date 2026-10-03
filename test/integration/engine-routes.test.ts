import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { createEmptyComposerState } from '../../src/webview/composer';

for (const route of ['editor', 'sidebar']) {
  test(`compiled engine ${route}: every mode captures before composer read, no prompt/follow/image preparation, no stale ACK`, async () => {
    const output = await build({
      stdin: {
        contents:
          "export {ChatTabManager} from './src/editorTabs/tabManager'; export {ChatPanelProvider} from './src/webview/provider';",
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
    new Function('require', 'module', 'exports', output.outputFiles[0]!.text)(
      (id: string) =>
        id === 'vscode'
          ? {
              workspace: { isTrusted: true },
              window: {
                showQuickPick: async (items: any[]) => items[0],
                showWarningMessage: async (_text: string, _options: any, action: string) => action,
              },
            }
          : require(id),
      module,
      module.exports
    );
    const state = createEmptyComposerState();
    state.pendingImages = [{ itemId: 'image', name: 'owned', mimeType: 'image/png', sizeBytes: 1 }];
    const other = createEmptyComposerState();
    other.draft = 'other draft';
    let generation = 1;
    let gate: (() => void) | undefined;
    let calls = 0;
    const order: string[] = [];
    const controller = {
      generation: 1,
      folder: { uri: { toString: () => 'file:///owned' } },
      snapshot: { state: { sessionId: 'owned', sessionFile: '/owned/session' } },
      captureEngineIntent: () => {
        order.push('capture');
        const captured = generation;
        return {
          valid: () => captured === generation,
          tree: async () => ({
            tree: [
              {
                entry: {
                  id: 'user',
                  type: 'message',
                  message: { role: 'user', content: 'original' },
                },
                children: [],
              },
            ],
          }),
          trust: async () => ({ cwd: '/owned', loaded: false }),
          run: async () => {
            calls++;
            gate?.();
            return {
              cancelled: false,
              editorText: state.draft.startsWith('/tree') ? 'returned user text' : undefined,
              valid: () => captured === generation,
            };
          },
        };
      },
    };
    const instance = Object.create(
      module.exports[route === 'editor' ? 'ChatTabManager' : 'ChatPanelProvider'].prototype
    );
    const resource = { toString: () => 'owned-resource' };
    instance.uiState = {
      captureIdentity: () => ({}),
      getComposerStateForIdentity: async () => {
        order.push('read');
        return structuredClone(state);
      },
      setComposerStateForIdentity: async (_controller: any, _identity: any, next: any) =>
        Object.assign(state, next),
    };
    instance.contextForResource = () => ({ controller, target: {}, resource });
    instance.renderResource = instance.postSnapshot = async () => {};
    instance.follow = {
      armOnce: () => {
        throw new Error('No local follow');
      },
    };
    instance.preparePromptContext = () => {
      throw new Error('No local prompt/context/images');
    };
    const send = (mode: string) =>
      route === 'editor'
        ? instance.handleRequestSend(resource, mode, true, 'ack')
        : instance.handleRequestSend(controller, mode, 'ack');
    for (const command of ['tree', 'trust', 'reload'])
      for (const mode of ['prompt', 'steer', 'follow_up']) {
        order.length = 0;
        state.draft = `/${command} native trailing args ignored`;
        state.localCommandAck = undefined;
        await send(mode);
        assert.deepEqual(order.slice(0, 2), ['capture', 'read']);
        assert.equal(state.localCommandAck, 'ack');
        assert.equal(state.draft, command === 'tree' ? 'returned user text' : '');
        assert.equal(state.pendingImages[0]?.itemId, 'image');
        assert.equal(other.draft, 'other draft');
      }
    for (const outcome of ['retype', 'generation', 'surface']) {
      state.draft = '/tree';
      state.localCommandAck = undefined;
      gate = () => {
        if (outcome === 'retype') state.commandRevision = (state.commandRevision ?? 0) + 1;
        if (outcome === 'generation') generation++;
        if (outcome === 'surface') {
          if (route === 'editor') instance.hosts = new Map([['owned-resource', {}]]);
          else instance.panel = {};
        }
      };
      await send('follow_up');
      assert.equal(state.draft, '', 'consumption precedes stale/retype outcome');
      assert.equal(state.localCommandAck, undefined);
      assert.equal(state.pendingImages[0]?.itemId, 'image');
      assert.equal(other.draft, 'other draft');
    }
    assert.equal(calls, 12);
  });
}
