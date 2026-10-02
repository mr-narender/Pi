import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';

async function load(contents: string, vscode: any = {}) {
  const result = await build({
    stdin: { contents, resolveDir: process.cwd() },
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

test('fresh rollback evidence: actual controller busy compact rejects without native send', async () => {
  const { SessionController } = await load(
    "export {SessionController} from './src/sessions/sessionController';"
  );
  const c = Object.create(SessionController.prototype);
  c.state = { state: { sessionId: 'owned', sessionFile: '/owned/file', isStreaming: true } };
  let calls = 0;
  c.supervisor = {
    currentClient: {
      compact: async () => {
        calls++;
        return {};
      },
    },
  };
  await assert.rejects(c.compact(), /idle/i);
  assert.equal(calls, 0);
});

test('fresh rollback evidence: actual menu Cancel sends nothing, accepted empty sends bare', async () => {
  let value: string | undefined;
  const calls: any[] = [];
  const controller = {
    snapshot: { state: {} },
    compact: async (instructions?: string) => {
      calls.push(instructions);
    },
    captureCompactIntent: () => ({
      valid: () => true,
      run: async (instructions?: string) => {
        calls.push(instructions);
      },
    }),
  };
  const source = await readFile('src/extension.ts', 'utf8');
  const start = source.indexOf("  registrations.set('piRpc.compact',");
  const end = source.indexOf("  registrations.set('piRpc.toggleAutoCompaction'", start);
  const api = await load(
    `import * as vscode from 'vscode'; import {compactCommand, compactMenu} from './src/commands/compactCommand'; export function register(registrations, withController) { ${source.slice(start, end)} }`,
    { workspace: { isTrusted: true }, window: { showInputBox: async () => value } }
  );
  const registrations = new Map();
  api.register(registrations, (run: any) => run(controller));
  await registrations.get('piRpc.compact')();
  assert.deepEqual(calls, []);
  value = '';
  await registrations.get('piRpc.compact')();
  assert.deepEqual(calls, [undefined]);
});
