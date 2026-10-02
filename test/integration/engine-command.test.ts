import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { createEmptyComposerState } from '../../src/webview/composer';

async function compiled(cancel = false) {
  const output = await build({
    stdin: {
      contents:
        "export * from './src/commands/localCommand'; export {treeItems} from './src/commands/engineCommand';",
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
            window: {
              showQuickPick: async (items: any[]) => (cancel ? undefined : items[0]),
              showWarningMessage: async (_text: string, _options: any, action: string) =>
                cancel ? undefined : action,
            },
          }
        : require(id),
    module,
    module.exports
  );
  return module.exports;
}
test('compiled tree picker retains deep native hierarchy, IDs/current leaf and before/after semantics', async () => {
  const { treeItems } = await compiled();
  let root: any = { entry: { id: 'leaf', type: 'custom_message', parentId: '299' }, children: [] };
  for (let depth = 299; depth >= 0; depth--)
    root = {
      entry: {
        id: String(depth),
        parentId: depth ? String(depth - 1) : null,
        type: 'model_change',
      },
      children: [root],
    };
  const items = treeItems([root], 'leaf');
  assert.equal(items.length, 301);
  assert.equal(items[0].entryId, '0');
  assert.equal(items[300].entryId, 'leaf');
  assert.match(items[300].detail, /Depth 300; parent 299; current leaf; continue BEFORE/);
});

for (const name of ['tree', 'trust', 'reload']) {
  test(`compiled /${name} uses captured native intent, ignores native trailing args, preserves chips`, async () => {
    const { handleLocalCommand } = await compiled();
    const state = createEmptyComposerState();
    state.draft = `/${name} ignored`;
    state.pendingImages = [
      {
        itemId: 'image',
        name: 'x.png',
        mimeType: 'image/png',
        sizeBytes: 1,
        inMemoryBase64: 'AA==',
      },
    ];
    let calls = 0;
    const intent = {
      valid: () => true,
      tree: async () => ({
        tree: [
          {
            entry: { id: 'user', type: 'message', message: { role: 'user', content: 'original' } },
            children: [],
          },
        ],
        leafId: 'user',
      }),
      trust: async () => ({ cwd: '/owned/project', decision: null, loaded: false }),
      run: async () => {
        calls++;
        return { cancelled: false, valid: () => true };
      },
    };
    const controller = {
      generation: 1,
      snapshot: { state: { sessionId: 'old' } },
      captureEngineIntent: () => intent,
    };
    await handleLocalCommand(
      controller,
      state,
      async () => state,
      async () => {},
      async () => {},
      'submit',
      () => true
    );
    assert.equal(calls, 1);
    assert.equal(state.localCommandAck, 'submit');
    assert.equal(state.draft, '');
    assert.equal(state.pendingImages[0]?.itemId, 'image');
  });
  test(`compiled /${name} cancellation retains draft and no ACK`, async () => {
    const { handleLocalCommand } = await compiled(true);
    const state = createEmptyComposerState();
    state.draft = `/${name}`;
    let calls = 0;
    const controller = {
      generation: 1,
      snapshot: { state: { sessionId: 'old' } },
      captureEngineIntent: () => ({
        valid: () => true,
        tree: async () => ({ tree: [] }),
        trust: async () => ({ cwd: '/owned' }),
        run: async () => {
          calls++;
          return { valid: () => true };
        },
      }),
    };
    await handleLocalCommand(
      controller,
      state,
      async () => state,
      async () => {},
      async () => {},
      'submit',
      () => true
    );
    assert.equal(calls, 0);
    assert.equal(state.draft, `/${name}`);
    assert.equal(state.localCommandAck, undefined);
  });
  for (const outcome of ['veto', 'error', 'stale', 'retype']) {
    test(`compiled /${name} ${outcome} retains draft/images and never ACKs`, async () => {
      const { handleLocalCommand } = await compiled();
      const state = createEmptyComposerState();
      state.draft = `/${name}`;
      state.pendingImages = [
        {
          itemId: 'owned',
          name: 'x.png',
          mimeType: 'image/png',
          sizeBytes: 1,
          inMemoryBase64: 'AA==',
        },
      ];
      let currentOrigin = true;
      const intent = {
        valid: () => currentOrigin,
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
        trust: async () => ({ cwd: '/owned' }),
        run: async () => {
          if (outcome === 'error') throw new Error('owned failure');
          if (outcome === 'stale') currentOrigin = false;
          if (outcome === 'retype') state.commandRevision = 1;
          return { cancelled: outcome === 'veto', valid: () => currentOrigin };
        },
      };
      const controller = { captureEngineIntent: () => intent };
      await handleLocalCommand(
        controller,
        state,
        async () => state,
        async (next: any) => {
          Object.assign(state, next);
        },
        async () => {},
        'submit',
        () => currentOrigin
      );
      assert.equal(state.draft, '');
      assert.equal(state.localCommandConsumed, 'submit');
      assert.equal(state.pendingImages[0]?.itemId, 'owned');
      assert.equal(state.localCommandAck, undefined);
      if (outcome === 'error') assert.match(state.recovery!.detail, /owned failure/);
    });
  }
}
