import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

test('name menu: cancel/blank never writes; dialog replacement cannot retarget; native normalized title', async () => {
  let answer: string | undefined;
  let input: (() => Promise<string | undefined>) | undefined;
  const notices: string[] = [];
  const result = await build({
    entryPoints: ['src/commands/nameCommand.ts'],
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
        showInputBox: async () => (input ? input() : answer),
        showInformationMessage: (text: string) => notices.push(text),
      },
    }),
    module,
    module.exports
  );
  const writes: string[] = [];
  let onChange!: () => void;
  const recentFolders: unknown[] = [];
  const titles: string[] = [];
  const controller = {
    generation: 1,
    folder: { name: 'origin folder' },
    onDidChangeState: (listener: () => void) => {
      onChange = listener;
      return { dispose() {} };
    },
    snapshot: { state: { sessionId: 'origin', sessionFile: '/owned/file', sessionName: 'old' } },
    renameSession: async (name: string) => {
      writes.push(name);
      controller.snapshot.state.sessionName = 'native normalized';
      onChange();
    },
  };
  module.exports.trackSessionName(
    controller,
    async (folder: unknown) => {
      recentFolders.push(folder);
    },
    () => {
      titles.push(controller.snapshot.state.sessionName);
    }
  );
  for (answer of [undefined, '', '   ']) {
    assert.equal(await module.exports.promptChatName(controller), false);
    assert.equal(writes.length, 0);
  }
  answer = '  two  words  ';
  assert.equal(await module.exports.promptChatName(controller), true);
  assert.deepEqual(writes, ['two  words']);
  assert.equal(notices.at(-1), 'Session name set: native normalized');
  assert.deepEqual(recentFolders, [controller.folder]);
  assert.equal(titles.at(-1), 'native normalized');
  onChange();
  assert.equal(recentFolders.length, 1, 'unchanged streaming events must not rescan recents');
  for (const change of ['session', 'generation']) {
    let finish!: (text: string) => void;
    input = () =>
      new Promise((r) => {
        finish = r;
      });
    const pending = module.exports.promptChatName(controller);
    for (let i = 0; i < 20 && !finish; i++) await new Promise((r) => setTimeout(r, 0));
    assert.ok(finish);
    if (change === 'session') controller.snapshot.state.sessionId = 'replacement';
    else controller.generation++;
    finish('must not rename replacement');
    await assert.rejects(pending, /originating chat changed/);
    assert.deepEqual(writes, ['two  words']);
  }
});
