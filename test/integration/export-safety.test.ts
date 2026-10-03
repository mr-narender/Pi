import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { build } from 'esbuild';

async function load(contents: string, vscode: any) {
  const result = await build({
    stdin: { contents, resolveDir: process.cwd(), loader: 'ts' },
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

test('export actual menu: Save Cancel has no default export or success; origin-relative paths, focus, validation and consent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-export-safety-'));
  try {
    let selected: any;
    let choice: string | undefined = 'Export locally';
    let mutate: () => void | Promise<void> = () => {};
    const notices: string[] = [];
    const writes: string[] = [];
    let generation = 1;
    const origin = {
      folder: { uri: { scheme: 'file', fsPath: root } },
      snapshot: {
        state: { isStreaming: false, sessionFile: join(root, 'native.jsonl') },
        leafId: 'leaf',
      },
      captureExportIntent() {
        const captured = generation;
        return {
          valid: () => generation === captured,
          write: async (path: string) => {
            writes.push(path);
            await writeFile(path, 'owned export');
          },
        };
      },
      exportHtml() {
        throw new Error('Menu must not call default export.');
      },
    };
    let active = origin;
    const vscode = {
      Uri: { file: (fsPath: string) => ({ scheme: 'file', fsPath }) },
      workspace: { isTrusted: true },
      window: {
        showSaveDialog: async () => {
          await mutate();
          return selected;
        },
        showWarningMessage: async () => {
          await mutate();
          return choice;
        },
        showInformationMessage: (text: string) => notices.push(text),
      },
      env: {
        clipboard: {
          writeText() {
            throw new Error('Clipboard forbidden');
          },
        },
        openExternal() {
          throw new Error('Open forbidden');
        },
      },
    };
    const source = await readFile('src/extension.ts', 'utf8');
    const start = source.indexOf("  registrations.set('piRpc.exportHtml',");
    const end = source.indexOf('  // Open Chat List', start);
    assert.ok(start > 0 && end > start);
    const api = await load(
      `import * as vscode from 'vscode'; import {exportCommand} from './src/commands/exportCommand'; export {exportCommand}; export function register(registrations: any, withController: any) { ${source.slice(start, end)} }`,
      vscode
    );
    const registrations = new Map();
    api.register(registrations, (run: any) => run(active));
    await registrations.get('piRpc.exportHtml')();
    assert.deepEqual(writes, []);
    assert.deepEqual(notices, []);
    selected = { scheme: 'file', fsPath: join(root, 'menu.html') };
    choice = undefined;
    await registrations.get('piRpc.exportHtml')();
    assert.deepEqual(writes, []);
    assert.deepEqual(notices, []);
    choice = 'Export locally';
    mutate = () => {
      active = { ...origin, folder: { uri: { scheme: 'file', fsPath: join(root, 'other') } } };
    };
    assert.equal(await api.exportCommand(origin, 'relative.html'), true);
    assert.equal(
      writes.at(-1),
      join(root, 'relative.html'),
      'focus must not change relative origin'
    );
    assert.equal(await readFile(join(root, 'relative.html'), 'utf8'), 'owned export');
    mutate = () => {
      generation++;
    };
    await assert.rejects(api.exportCommand(origin, 'stale.html'), /originating/);
    assert.equal(writes.length, 1);
    mutate = () => {};
    for (const path of [root, join(root, 'missing', 'file.html'), 'nul\0.html']) {
      await assert.rejects(api.exportCommand(origin, path));
      assert.equal(writes.length, 1);
    }
    const target = join(root, 'untouched.html');
    await writeFile(target, 'original');
    const link = join(root, 'link.html');
    await symlink(target, link);
    await assert.rejects(api.exportCommand(origin, link), /symlink/);
    assert.equal(await readFile(target, 'utf8'), 'original');
    await writeFile(origin.snapshot.state.sessionFile, 'native history');
    await assert.rejects(
      api.exportCommand(origin, origin.snapshot.state.sessionFile),
      /native session/
    );
    assert.equal(await readFile(origin.snapshot.state.sessionFile, 'utf8'), 'native history');
    const appeared = join(root, 'appeared.html');
    mutate = () => writeFile(appeared, 'unconsented');
    await assert.rejects(api.exportCommand(origin, appeared), /overwrite consent/);
    assert.equal(await readFile(appeared, 'utf8'), 'unconsented');
    assert.equal(writes.length, 1);
    mutate = () => {};
    selected = { scheme: 'vscode-remote', fsPath: target };
    await assert.rejects(api.exportCommand(origin, ''), /local file/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('export real controller/client: immutable client and branch, capability wait cancellation, stock JSONL unsupported', async () => {
  const { SessionController, RpcClient } = await load(
    "export {SessionController} from './src/sessions/sessionController'; export {RpcClient} from './src/rpc/client';",
    {}
  );
  const controller = Object.create(SessionController.prototype);
  Object.defineProperty(controller, 'generation', { value: 1, writable: true });
  controller.state = {
    state: { sessionId: 'origin', sessionFile: '/owned/session' },
    leafId: 'leaf',
  };
  const writes: any[] = [];
  const rpc = Object.create(RpcClient.prototype);
  let change = () => {};
  rpc.command = async (type: string, args: any) => {
    if (type === 'get_capabilities') {
      change();
      return { protocol: 1, sdkVersion: '0.99.1', exports: { jsonl: true } };
    }
    writes.push({ type, args });
    return { path: args.outputPath };
  };
  rpc.getState = async () => ({ ...controller.state.state });
  rpc.getEntries = async () => ({ leafId: controller.state.leafId });
  let current = rpc;
  controller.supervisor = {
    get currentClient() {
      return current;
    },
  };
  controller.requireClient = () => current;
  controller.fire = () => {};
  await controller.captureExportIntent().write('/owned/export.jsonl', true);
  assert.equal(writes[0].type, 'export_jsonl');
  assert.deepEqual(writes[0].args.origin, {
    sessionId: 'origin',
    sessionFile: '/owned/session',
    leafId: 'leaf',
  });
  const captured = controller.captureExportIntent();
  current = {};
  assert.equal(captured.valid(), false);
  current = rpc;
  for (const update of [
    () => {
      controller.generation++;
    },
    () => {
      controller.state.leafId += 'new';
    },
  ]) {
    change = update;
    await assert.rejects(
      controller.captureExportIntent().write('/owned/stale.jsonl', true),
      /originating/
    );
    assert.equal(writes.length, 1, 'capability await must not write a replaced origin');
  }
  rpc.command = async () => {
    throw new Error('Unknown command: get_capabilities');
  };
  await assert.rejects(rpc.exportJsonl('/owned/unsupported.jsonl'), /HTML export only/);
});
