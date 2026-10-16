import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { transform } from 'esbuild';

async function startupFixture(tabs: unknown[], trusted = true, autoStart = true) {
  const source = readFileSync('src/extension.ts', 'utf8');
  const start = source.lastIndexOf('  const firstFolder =');
  const end = source.indexOf('\n}\nexport async function deactivate', start);
  assert.ok(start >= 0 && end > start);
  const compiled = await transform(`async function run() {${source.slice(start, end)}}`, {
    loader: 'ts',
  });
  const calls: string[] = [];
  const firstFolder = { uri: { fsPath: '/different-first-root' } };
  const controller = { start: async () => calls.push('start-new-session') };
  const run = new Function(
    'vscode',
    'settings',
    'registry',
    'broker',
    'statusBar',
    'refreshViews',
    `${compiled.code}; return run;`
  )(
    {
      workspace: { workspaceFolders: [firstFolder], isTrusted: trusted },
      window: { tabGroups: { all: [{ tabs }] } },
    },
    { autoStart },
    {
      getOrCreate: (folder: unknown) => {
        assert.equal(folder, firstFolder);
        calls.push('get-first-controller');
        return controller;
      },
      setActive: () => calls.push('set-active'),
    },
    { track: () => calls.push('track') },
    { bind: () => calls.push('bind') },
    () => calls.push('refresh')
  );
  await run();
  return calls;
}

test('restored Pi chat does not allocate an unrelated first-folder session', async () => {
  const calls = await startupFixture([
    {
      input: {
        viewType: 'piRpc.chatEditor',
        uri: { scheme: 'pi-chat', path: '/chat-original-jsonl.chat' },
      },
    },
  ]);
  assert.deepEqual(calls, []);
});

test('restored draft chat owns startup without another default session', async () => {
  assert.deepEqual(
    await startupFixture([
      { input: { viewType: 'piRpc.chatEditor', uri: { path: '/new-chat-bound.chat' } } },
    ]),
    []
  );
});

test('ordinary workspace still starts its default controller', async () => {
  for (const tabs of [[], [{ input: { viewType: 'other.customEditor' } }]]) {
    assert.deepEqual(await startupFixture(tabs), [
      'get-first-controller',
      'track',
      'set-active',
      'bind',
      'start-new-session',
      'refresh',
    ]);
  }
  assert.deepEqual(await startupFixture([], false), []);
  assert.deepEqual(await startupFixture([], true, false), []);
});
