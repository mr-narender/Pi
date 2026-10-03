import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { createEmptyComposerState } from '../../src/webview/composer';

test('thinking actual local route sets supported argument and opens native-only picker', async () => {
  let offered: any[] = [];
  let choice: string | undefined = 'low';
  const result = await build({
    stdin: {
      contents:
        "export { handleLocalCommand, mergeLocalCommands } from './src/commands/localCommand';",
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
    () => ({
      window: {
        showQuickPick: async (items: any[]) => {
          offered = items;
          return items.find((i) => i.level === choice);
        },
      },
    }),
    module,
    module.exports
  );
  const state = createEmptyComposerState();
  const applied: string[] = [];
  const controller = {
    modelEpoch: 0,
    snapshot: { state: { sessionId: 'one', model: { provider: 'a', id: 'b' } } },
    getThinkingCapabilities: async () => ({ levels: ['off', 'low'], revision: 'v1' }),
    setThinkingLevel: async (level: string) => {
      applied.push(level);
    },
  };
  const send = async (draft: string) => {
    state.draft = draft;
    await module.exports.handleLocalCommand(
      controller,
      structuredClone(state),
      async () => structuredClone(state),
      async (s: any) => Object.assign(state, s),
      async () => {}
    );
  };
  await send('/thinking LOW');
  assert.deepEqual(applied, ['low']);
  assert.equal(state.draft, '');
  await send('/thinking');
  assert.deepEqual(
    offered.map((i) => i.level),
    ['off', 'low']
  );
  assert.deepEqual(applied, ['low', 'low']);
  for (const arg of ['high', 'low high', 'model:low']) {
    await send(`/thinking ${arg}`);
    assert.equal(state.draft, `/thinking ${arg}`);
  }
  assert.equal(applied.length, 2);
  choice = undefined;
  await send('/thinking');
  assert.equal(state.draft, '', 'Cancel does not restore consumed menu text');
  assert.ok(module.exports.mergeLocalCommands([]).some((c: any) => c.name === 'thinking'));
  let release!: () => void;
  controller.getThinkingCapabilities = () =>
    new Promise((resolve) => {
      release = () => resolve({ levels: ['off', 'low'], revision: 'v2' });
    });
  const pending = send('/thinking low');
  for (let i = 0; i < 30 && !release; i++) await new Promise((r) => setTimeout(r, 0));
  assert.equal(typeof release, 'function', 'hold the actual capability wait before ABA');
  controller.modelEpoch += 2; // A -> B -> A while capability discovery is pending.
  release();
  await pending;
  assert.equal(applied.length, 2, 'epoch was captured before capability wait, not after');
  assert.equal(state.draft, '/thinking low');
  assert.match(state.recovery!.detail, /originating model changed/);
});
