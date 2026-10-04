import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const command = 'piRpcInternal.setWorkingAnimation';
test('Working Animation is registered in native Configure and editor menus', () => {
  const manifest = JSON.parse(readFileSync('package.json', 'utf8')).contributes;
  assert.equal(
    manifest.commands.find((item: any) => item.command === command)?.title,
    'Working Animation'
  );
  assert.deepEqual(
    manifest.menus['piRpc.agenticActions'].find((item: any) => item.command === command),
    { command, group: '2_configure@5' }
  );
  assert.ok(manifest.menus['piRpc.chatActions'].some((item: any) => item.command === command));
  assert.deepEqual(manifest.configuration.properties['piRpc.workingAnimation'].enum, [
    'braille',
    'dots',
    'bars',
    'earth',
    'moon',
    'dolphin',
  ]);
  assert.equal(manifest.configuration.properties['piRpc.workingAnimation'].default, 'braille');
});

test('Working Animation native command uses the existing six-choice picker', async () => {
  const source = readFileSync('src/extension.ts', 'utf8');
  const start = source.indexOf('  const pickSetting = async');
  const end = source.indexOf("  registrations.set('piRpcInternal.setTypewriterSpeed',", start);
  const result = await build({
    stdin: {
      contents: `import * as vscode from 'vscode'; export function register(registrations: any) { ${source.slice(start, end)} }`,
      resolveDir: process.cwd(),
      loader: 'ts',
    },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    external: ['vscode'],
  });
  const registrations = new Map();
  const updates: any[] = [];
  const picks: any[] = [];
  let selection: string | undefined;
  const vscode = {
    ConfigurationTarget: { Global: 1 },
    window: {
      showQuickPick: async (items: any[], options: any) => {
        picks.push({ items, options });
        return items.find((item) => item.label === selection);
      },
    },
    workspace: {
      getConfiguration: (section: string) => {
        assert.equal(section, 'piRpc');
        return {
          get: (key: string) => {
            assert.equal(key, 'workingAnimation');
            return 'moon';
          },
          update: async (...args: any[]) => {
            updates.push(args);
          },
        };
      },
    },
  };
  const module = { exports: {} as any };
  new Function('require', 'module', 'exports', result.outputFiles[0]!.text)(
    (id: string) => (id === 'vscode' ? vscode : createRequire(`${process.cwd()}/package.json`)(id)),
    module,
    module.exports
  );
  module.exports.register(registrations);
  await registrations.get(command)!();
  assert.deepEqual(picks, [
    {
      items: ['braille', 'dots', 'bars', 'earth', 'moon', 'dolphin'].map((label) => ({
        label,
        description: label === 'moon' ? 'current' : '',
      })),
      options: { title: 'Working animation' },
    },
  ]);
  assert.deepEqual(updates, [], 'cancellation leaves settings unchanged');
  selection = 'dolphin';
  await registrations.get(command)!();
  assert.deepEqual(updates, [['workingAnimation', 'dolphin', vscode.ConfigurationTarget.Global]]);
});
