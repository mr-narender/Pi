import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

test('actual diagnostics menu registrations share exact safe preview and captured origin; cancel/save failure', async () => {
  const source = await readFile('src/extension.ts', 'utf8');
  const start = source.indexOf("  registrations.set('piRpcInternal.showHealth',");
  const end = source.indexOf("  registrations.set('piRpcInternal.openWorktree',", start);
  const result = await build({
    stdin: {
      contents: `import * as vscode from 'vscode'; import {previewDiagnostics} from './src/commands/debugCommand'; import {createRedactedDiagnosticsExport} from './src/diagnostics/export'; export function register(registrations, registry, logger, getSettings, getSharedPiHost, asRecord, asString, ensureTrustedForMutation) { ${source.slice(start, end)} }`,
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    external: ['vscode'],
  });
  let choice: string | undefined;
  let target: any = { fsPath: '/owned/test.json' };
  let fail = false;
  let mutate: (() => void) | undefined;
  const previews: string[] = [],
    copies: string[] = [],
    files: string[] = [];
  const vscode = {
    workspace: {
      isTrusted: true,
      fs: {
        writeFile: async (_t: any, b: Uint8Array) => {
          if (fail) throw new Error('SECRET-CANARY');
          files.push(Buffer.from(b).toString());
        },
      },
    },
    env: {
      clipboard: {
        writeText: async (s: string) => {
          copies.push(s);
        },
      },
    },
    window: {
      showInformationMessage: async (_s: string, o: any) => {
        previews.push(o?.detail ?? '');
        mutate?.();
        return choice;
      },
      showSaveDialog: async () => target,
    },
  };
  const module = { exports: {} as any };
  new Function('require', 'module', 'exports', result.outputFiles[0]!.text)(
    (id: string) => (id === 'vscode' ? vscode : createRequire(`${process.cwd()}/package.json`)(id)),
    module,
    module.exports
  );
  const c = {
    generation: 1,
    folder: { name: 'SECRET-CANARY', uri: { fsPath: '/owned/SECRET-CANARY' } },
    snapshot: {
      state: { sessionId: 'SECRET-CANARY', sessionName: 'SECRET-CANARY' },
      queue: { steering: [], followUp: [] },
      messages: [],
      eventHistory: [],
      uiHistory: [],
      diagnostics: [],
      lastSessionStats: { cost: 1 },
    },
  };
  const registrations = new Map();
  module.exports.register(
    registrations,
    { getActive: () => c },
    { health: (e: any) => ({ recentLogLines: ['SECRET-CANARY'], ...e }) },
    () => ({ executable: 'SECRET-CANARY' }),
    () => undefined,
    (v: any) => v,
    (v: any) => (typeof v === 'string' ? v : undefined),
    () => {}
  );
  for (const name of ['piRpcInternal.showHealth', 'piRpcInternal.exportDiagnostics']) {
    // Each registration starts with clean effect counters; previous accepted
    // actions must not be mistaken for effects of this registration's cancel.
    copies.length = 0;
    files.length = 0;
    choice = undefined;
    assert.equal(await registrations.get(name)(), false);
    assert.equal(copies.length, 0);
    assert.equal(files.length, 0);
    choice = 'Copy JSON';
    assert.equal(await registrations.get(name)(), true);
    assert.equal(copies.at(-1), previews.at(-1));
    assert.doesNotMatch(copies.at(-1)!, /SECRET-CANARY/);
    choice = 'Save JSON';
    target = undefined;
    assert.equal(await registrations.get(name)(), false);
    target = { fsPath: '/owned/test.json' };
    assert.equal(await registrations.get(name)(), true);
    assert.equal(files.at(-1), previews.at(-1));
    fail = true;
    await assert.rejects(registrations.get(name)(), (e: Error) => {
      assert.doesNotMatch(e.message, /SECRET-CANARY/);
      return true;
    });
    fail = false;
    const before = copies.length;
    choice = 'Copy JSON';
    mutate = () => {
      c.generation++;
    };
    await assert.rejects(registrations.get(name)(), /originating chat changed/);
    assert.equal(copies.length, before);
    mutate = undefined;
  }
});
