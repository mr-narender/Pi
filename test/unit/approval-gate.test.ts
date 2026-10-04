import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { mergeApprovalGateSetting } from '../../src/review/approvalGateSettings';

test('enabling on an empty/missing settings file creates a minimal file', () => {
  const result = mergeApprovalGateSetting(undefined, true);
  assert.ok(result);
  const parsed = JSON.parse(result!);
  assert.deepEqual(parsed.extensions, ['./extensions/pi-approval-gate.ts']);
});

test('enabling preserves other settings and other extensions', () => {
  const existing = JSON.stringify({
    sessionDir: '/tmp/sessions',
    extensions: ['./extensions/something-else.ts'],
  });
  const result = mergeApprovalGateSetting(existing, true);
  const parsed = JSON.parse(result!);
  assert.equal(parsed.sessionDir, '/tmp/sessions');
  assert.deepEqual(parsed.extensions.sort(), [
    './extensions/pi-approval-gate.ts',
    './extensions/something-else.ts',
  ]);
});

test('enabling twice does not duplicate the entry', () => {
  const once = mergeApprovalGateSetting(undefined, true);
  const twice = mergeApprovalGateSetting(once, true);
  const parsed = JSON.parse(twice!);
  assert.deepEqual(parsed.extensions, ['./extensions/pi-approval-gate.ts']);
});

test('disabling removes only our entry, keeps others, keeps other settings', () => {
  const existing = JSON.stringify({
    sessionDir: '/tmp/sessions',
    extensions: ['./extensions/pi-approval-gate.ts', './extensions/something-else.ts'],
  });
  const result = mergeApprovalGateSetting(existing, false);
  const parsed = JSON.parse(result!);
  assert.equal(parsed.sessionDir, '/tmp/sessions');
  assert.deepEqual(parsed.extensions, ['./extensions/something-else.ts']);
});

test('disabling the only entry with nothing else present deletes the file entirely', () => {
  const existing = JSON.stringify({ extensions: ['./extensions/pi-approval-gate.ts'] });
  assert.equal(mergeApprovalGateSetting(existing, false), undefined);
});

test('disabling when it was never enabled is a no-op that keeps other settings', () => {
  const existing = JSON.stringify({ sessionDir: '/tmp/sessions' });
  const result = mergeApprovalGateSetting(existing, false);
  const parsed = JSON.parse(result!);
  assert.deepEqual(parsed, { sessionDir: '/tmp/sessions' });
});

test('existing empty/scalar/array configuration is preserved by rejecting its shape', () => {
  for (const source of ['', 'null', '[]', '42'])
    for (const enabled of [true, false])
      assert.throws(() => mergeApprovalGateSetting(source, enabled), /valid JSON object/);
});

for (const enabled of [true, false]) {
  test(`malformed settings are rejected before approval ${enabled ? 'activation' : 'deactivation'}`, async () => {
    const settings = '/project/.pi/settings.json';
    const gate = '/project/.pi/extensions/pi-approval-gate.ts';
    const malformed = Buffer.from('{ "defaultProvider": "openai-codex", broken\n');
    const originalGate = Buffer.from('existing approval policy');
    const files = new Map<string, Buffer>([
      [settings, malformed],
      [gate, originalGate],
      ['/extension/resources/pi-approval-gate.ts', Buffer.from('new approval policy')],
    ]);
    const mutations: string[] = [];
    const errors: string[] = [];
    const vscode = {
      Uri: { joinPath: (root: string, ...parts: string[]) => [root, ...parts].join('/') },
      workspace: {
        isTrusted: true,
        workspaceFolders: [{ uri: '/project' }],
        fs: {
          readFile: async (path: string) => files.get(path),
          createDirectory: async (path: string) => mutations.push(path),
          writeFile: async (path: string, value: Buffer) => {
            mutations.push(path);
            files.set(path, value);
          },
          delete: async (path: string) => {
            mutations.push(path);
            files.delete(path);
          },
        },
      },
      window: { showErrorMessage: async (message: string) => errors.push(message) },
    };
    const bundle = await build({
      entryPoints: ['src/review/approvalGate.ts'],
      bundle: true,
      write: false,
      platform: 'node',
      format: 'cjs',
      external: ['vscode'],
    });
    const module = { exports: {} as any };
    new Function('require', 'module', 'exports', bundle.outputFiles[0]!.text)(
      () => vscode,
      module,
      module.exports
    );
    await module.exports.syncApprovalGateForWorkspace('/extension', enabled);
    assert.deepEqual(files.get(settings), malformed);
    assert.deepEqual(files.get(gate), originalGate);
    assert.deepEqual(mutations, []);
    assert.equal(errors.length, 1);
    assert.match(errors[0]!, /settings\.json/);
    assert.match(errors[0]!, /fix|repair/i);
  });
}
