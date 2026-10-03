import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { createEmptyComposerState } from '../../src/webview/composer';

async function compiled() {
  const output = await build({
    entryPoints: ['src/commands/localCommand.ts'],
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
            window: { showQuickPick: async (items: any[]) => items[0] },
            workspace: { isTrusted: true },
          }
        : require(id),
    module,
    module.exports
  );
  return module.exports;
}
for (const name of ['new', 'clone', 'fork', 'resume', 'quit']) {
  test(`compiled /${name} lifecycle ACK preserves attachments and captured resource`, async () => {
    const { handleLocalCommand } = await compiled();
    const state = createEmptyComposerState();
    state.draft = `/${name}`;
    if (name !== 'quit')
      state.pendingImages = [
        {
          itemId: 'owned',
          name: 'x.png',
          mimeType: 'image/png',
          sizeBytes: 1,
          inMemoryBase64: 'AA==',
        },
      ];
    let ran = 0;
    let moved = 0;
    let acknowledged = false;
    const controller = {
      generation: 1,
      snapshot: { state: { sessionId: 'old' }, queue: { steering: [], followUp: [] } },
      captureLifecycleIntent: () => ({
        valid: () => true,
        forkMessages: async () => [{ entryId: 'user', text: 'original' }],
        run: async () => {
          ran++;
          return {
            cancelled: false,
            replacementIdentity: { sessionId: 'next' },
            valid: () => true,
          };
        },
      }),
    };
    await handleLocalCommand(
      controller,
      state,
      async () => state,
      async (next: any) => {
        Object.assign(state, next);
        acknowledged = next.localCommandAck === 'submit';
      },
      async () => {},
      'submit',
      () => true,
      {
        valid: () => true,
        replace: async () => {
          moved++;
        },
        close: async () => {
          moved++;
        },
        resume: async () => 'owned.jsonl',
      }
    );
    assert.equal(ran, 1);
    assert.equal(moved, 1);
    assert.equal(acknowledged, true);
    assert.equal(state.pendingImages.length, name === 'quit' ? 0 : 1);
  });
}
