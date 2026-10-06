import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { build } from 'esbuild';

test('Follow Agent off cancels in-flight opens and cannot be force-enabled per send', async () => {
  let mode = 'open';
  let releaseRead!: (value: Uint8Array) => void;
  let signalReadStarted!: () => void;
  const readStarted = new Promise<void>((resolve) => {
    signalReadStarted = resolve;
  });
  const opened: unknown[] = [];
  const shown: unknown[] = [];
  let revealed = 0;
  let holdRead = true;
  const group = { activeTab: undefined, tabs: [], viewColumn: 1 };
  const document = {
    uri: { fsPath: '/workspace/file.ts', scheme: 'file' },
    languageId: 'typescript',
    getText: () => 'content',
    positionAt: () => ({ line: 0 }),
  };
  const vscode = {
    StatusBarAlignment: { Right: 1 },
    OverviewRulerLane: { Full: 1, Center: 2 },
    ViewColumn: { Active: 1 },
    TextEditorRevealType: { InCenterIfOutsideViewport: 1 },
    Range: class {
      public constructor(..._args: unknown[]) {}
    },
    Uri: { file: (fsPath: string) => ({ fsPath, scheme: 'file' }) },
    TabInputCustom: class {},
    TabInputText: class {},
    MarkdownString: class {
      public constructor(public readonly value: string) {}
    },
    workspace: {
      getConfiguration: () => ({
        get: (key: string, fallback: unknown) =>
          key === 'followAgent' ? mode : key === 'predictivePreload' ? false : fallback,
      }),
      fs: {
        readFile: async () => {
          if (!holdRead) return new TextEncoder().encode('content');
          signalReadStarted();
          return new Promise<Uint8Array>((resolve) => {
            releaseRead = resolve;
          });
        },
      },
      openTextDocument: async (uri: unknown) => {
        opened.push(uri);
        return document;
      },
    },
    window: {
      createTextEditorDecorationType: () => ({ dispose() {} }),
      createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }),
      tabGroups: { activeTabGroup: group, all: [group], close: async () => true },
      visibleTextEditors: [
        {
          document,
          revealRange: () => {
            revealed++;
          },
          setDecorations() {},
        },
      ],
      showTextDocument: async (...args: unknown[]) => {
        shown.push(args);
        return {};
      },
    },
    commands: { executeCommand: async () => undefined },
  };
  const compiled = await build({
    entryPoints: ['src/live/agentFollow.ts'],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    external: ['vscode'],
  });
  const require = createRequire(`${process.cwd()}/package.json`);
  const module = { exports: {} as Record<string, any> };
  new Function('require', 'module', 'exports', compiled.outputFiles[0]!.text)(
    (id: string) => (id === 'vscode' ? vscode : require(id)),
    module,
    module.exports
  );
  const service = new module.exports.AgentFollowService();
  const pending = service.showInSidePane('editing', '/workspace/file.ts', 'chat', undefined);
  await readStarted;
  mode = 'off';
  releaseRead(new TextEncoder().encode('content'));
  await pending;
  assert.equal(opened.length, 0);
  assert.equal(shown.length, 0);
  holdRead = false;
  await service.showInSidePane('editing', '/workspace/file.ts', 'chat', undefined, undefined, true);
  assert.equal(opened.length, 0);
  assert.equal(shown.length, 0);
  await service.glowEdit('/workspace/file.ts', 'content', 'chat');
  assert.equal(revealed, 0, 'turning follow off must cancel deferred editor reveals');
  service.dispose();
});
