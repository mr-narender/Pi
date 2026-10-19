import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeApprovalGateSetting } from '../../src/review/approvalGateSettings';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { posix, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';

async function syncHarness() {
  const files = new Map<string, Uint8Array>([
    ['/extension/resources/pi-approval-gate.ts', Buffer.from('managed hook')],
  ]);
  const operations: string[] = [];
  let blockRename: (() => Promise<void>) | undefined;
  const api = {
    Uri: {
      joinPath: (uri: { path: string }, ...parts: string[]) => ({
        path: posix.join(uri.path, ...parts),
      }),
    },
    workspace: {
      isTrusted: true,
      workspaceFolders: [{ uri: { path: '/project', fsPath: '/project' } }],
      fs: {
        createDirectory: async () => undefined,
        readFile: async (uri: { path: string }) => {
          if (!files.has(uri.path))
            throw Object.assign(new Error('missing'), { code: 'FileNotFound' });
          return files.get(uri.path)!;
        },
        writeFile: async (uri: { path: string }, value: Uint8Array) => {
          operations.push(`write ${uri.path}`);
          files.set(uri.path, value);
        },
        rename: async (from: { path: string }, to: { path: string }) => {
          await blockRename?.();
          operations.push(`rename ${to.path}`);
          files.set(to.path, files.get(from.path)!);
          files.delete(from.path);
        },
      },
    },
  };
  const output = await build({
    entryPoints: ['src/review/approvalGate.ts'],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    external: ['vscode'],
  });
  const module = { exports: {} as any };
  const require = createRequire(resolve('package.json'));
  new Function('require', 'module', 'exports', output.outputFiles[0]!.text)(
    (name: string) => (name === 'vscode' ? api : require(name)),
    module,
    module.exports
  );
  return {
    module: module.exports,
    files,
    api,
    operations,
    setRename: (next: typeof blockRename) => {
      blockRename = next;
    },
  };
}

test('Manual Mode sync is atomic, serializes toggles and blocks prompt admission until mode settles', async () => {
  const h = await syncHarness();
  const uri = { path: '/extension' };
  await h.module.syncApprovalGateForWorkspace(uri, false);
  const marker = '/project/.pi/pi-vscode-manual-mode.json';
  assert.deepEqual(JSON.parse(Buffer.from(h.files.get(marker)!).toString()), { enabled: false });
  let release!: () => void;
  h.setRename(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      })
  );
  const enabling = h.module.syncApprovalGateForWorkspace(uri, true);
  let admitted = false;
  const admission = h.module.waitForApprovalGateSync().then(() => {
    admitted = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(admitted, false);
  assert.deepEqual(
    JSON.parse(Buffer.from(h.files.get(marker)!).toString()),
    { enabled: false },
    'partial write never replaces effective policy'
  );
  h.setRename(undefined);
  release();
  await Promise.all([enabling, admission]);
  assert.equal(admitted, true);
  const disable = h.module.syncApprovalGateForWorkspace(uri, false);
  const enable = h.module.syncApprovalGateForWorkspace(uri, true);
  await Promise.all([disable, enable, h.module.waitForApprovalGateSync()]);
  assert.deepEqual(JSON.parse(Buffer.from(h.files.get(marker)!).toString()), { enabled: true });
  assert.match(
    Buffer.from(h.files.get('/project/.pi/settings.json')!).toString(),
    /pi-approval-gate\.ts/
  );
  assert.equal(h.files.has('/project/.pi/pi-vscode-manual-mode.json.pending'), false);
});

test('failed mode sync stays visible and blocks admission until a successful recovery', async () => {
  const h = await syncHarness();
  h.setRename(async () => {
    throw new Error('write denied');
  });
  await assert.rejects(
    h.module.syncApprovalGateForWorkspace({ path: '/extension' }, true),
    /write denied/
  );
  await assert.rejects(h.module.waitForApprovalGateSync(), /write denied/);
  assert.equal(h.module.approvalGateSyncError(), 'write denied');
  h.setRename(undefined);
  await h.module.syncApprovalGateForWorkspace({ path: '/extension' }, false);
  await h.module.waitForApprovalGateSync();
  assert.equal(h.module.approvalGateSyncError(), undefined);
});

test('default automatic mode tolerates read-only projects without blocking prompts or clearing the setup error', async () => {
  const h = await syncHarness();
  h.setRename(async () => {
    throw new Error('read-only project');
  });
  await assert.rejects(
    h.module.syncApprovalGateForWorkspace({ path: '/extension' }, false),
    /read-only/
  );
  await h.module.waitForApprovalGateSync();
  assert.equal(h.module.approvalGateSyncError(), 'read-only project');
  await assert.rejects(
    h.module.syncApprovalGateForWorkspace({ path: '/extension' }, true),
    /read-only/
  );
  await assert.rejects(h.module.waitForApprovalGateSync(), /read-only/);
});

test('failed configuration persistence never changes an enabled policy marker', async () => {
  const h = await syncHarness();
  const extension = { path: '/extension' };
  await h.module.syncApprovalGateForWorkspace(extension, true);
  const marker = '/project/.pi/pi-vscode-manual-mode.json';
  const before = Buffer.from(h.files.get(marker)!).toString();
  await assert.rejects(
    h.module.toggleApprovalGateMode(
      extension,
      () => true,
      async () => {
        throw new Error('configuration denied');
      }
    ),
    /configuration denied/
  );
  assert.equal(Buffer.from(h.files.get(marker)!).toString(), before);
  await h.module.waitForApprovalGateSync();
});

test('Manual Mode rejects explicit extension-disabled arguments including an already running automatic session', async () => {
  const h = await syncHarness();
  const extension = { path: '/extension' };
  await h.module.syncApprovalGateForWorkspace(extension, false);
  for (const args of [['--no-extensions'], ['-ne'], ['--offline', '-ne']]) {
    h.module.assertManualModeExtensionsEnabled(args);
    assert.throws(
      () => h.module.assertManualModeExtensionsEnabled(args, true),
      /Manual Mode requires Pi extensions/
    );
  }
  await h.module.syncApprovalGateForWorkspace(extension, true);
  for (const args of [['--no-extensions'], ['-ne'], ['--offline', '-ne']]) {
    assert.throws(
      () => h.module.assertManualModeExtensionsEnabled(args),
      /Manual Mode requires Pi extensions/
    );
  }
  h.module.assertManualModeExtensionsEnabled(['--offline', '--tools', 'read']);
});

test('a controller that cannot approve prevents enabling before configuration or marker changes', async () => {
  const h = await syncHarness();
  const extension = { path: '/extension' };
  await h.module.syncApprovalGateForWorkspace(extension, false);
  let configured = false;
  await assert.rejects(
    h.module.toggleApprovalGateMode(
      extension,
      () => configured,
      async (enabled: boolean) => {
        h.module.assertManualModeExtensionsEnabled(['--no-extensions'], enabled);
        configured = enabled;
      }
    ),
    /Manual Mode requires Pi extensions/
  );
  assert.equal(configured, false);
  assert.deepEqual(
    JSON.parse(Buffer.from(h.files.get('/project/.pi/pi-vscode-manual-mode.json')!).toString()),
    { enabled: false }
  );
  await h.module.waitForApprovalGateSync();
});

test('rapid toggle clicks read freshly persisted configuration and settle to the final mode', async () => {
  const h = await syncHarness();
  const extension = { path: '/extension' };
  let configured = false;
  const writes: boolean[] = [];
  const persist = async (enabled: boolean) => {
    configured = enabled;
    writes.push(enabled);
  };
  const first = h.module.toggleApprovalGateMode(extension, () => configured, persist);
  const second = h.module.toggleApprovalGateMode(extension, () => configured, persist);
  await Promise.all([first, second, h.module.waitForApprovalGateSync()]);
  assert.deepEqual(writes, [true, false]);
  assert.equal(configured, false);
  assert.deepEqual(
    JSON.parse(Buffer.from(h.files.get('/project/.pi/pi-vscode-manual-mode.json')!).toString()),
    { enabled: false }
  );
});

test('a failed folder sync waits for sibling writes before the next toggle or prompt admission', async () => {
  const h = await syncHarness();
  const extension = { path: '/extension' };
  h.api.workspace.workspaceFolders.push({ uri: { path: '/other', fsPath: '/other' } });
  let release!: () => void;
  let renames = 0;
  h.setRename(async () => {
    renames += 1;
    if (renames === 1) throw new Error('first project failed');
    if (renames === 2)
      await new Promise<void>((resolve) => {
        release = resolve;
      });
  });
  const first = assert.rejects(
    h.module.syncApprovalGateForWorkspace(extension, true),
    /first project failed/
  );
  const second = h.module.syncApprovalGateForWorkspace(extension, false);
  let admitted = false;
  const admission = h.module.waitForApprovalGateSync().then(() => {
    admitted = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(renames, 2, 'next toggle cannot begin while the sibling is still writing');
  assert.equal(admitted, false);
  release();
  await Promise.all([first, second, admission]);
  assert.equal(admitted, true);
  for (const path of ['/project', '/other']) {
    assert.deepEqual(
      JSON.parse(Buffer.from(h.files.get(`${path}/.pi/pi-vscode-manual-mode.json`)!).toString()),
      { enabled: false }
    );
  }
});

test('exact nested and outside session folders are prepared before launch and receive later toggles', async () => {
  const h = await syncHarness();
  const extension = { path: '/extension' };
  await h.module.syncApprovalGateForWorkspace(extension, false);
  for (const path of ['/project/nested/another', '/other/project']) {
    await h.module.prepareApprovalGateForFolder({ uri: { path, fsPath: path } });
    assert.match(
      Buffer.from(h.files.get(`${path}/.pi/settings.json`)!).toString(),
      /pi-approval-gate/
    );
    assert.deepEqual(
      JSON.parse(Buffer.from(h.files.get(`${path}/.pi/pi-vscode-manual-mode.json`)!).toString()),
      { enabled: false }
    );
  }
  await h.module.syncApprovalGateForWorkspace(extension, true);
  for (const path of ['/project', '/project/nested/another', '/other/project']) {
    assert.deepEqual(
      JSON.parse(Buffer.from(h.files.get(`${path}/.pi/pi-vscode-manual-mode.json`)!).toString()),
      { enabled: true }
    );
  }
  const source = await readFile('src/sessions/sessionController.ts', 'utf8');
  assert.ok(
    source.indexOf('await prepareApprovalGateForFolder(this.folder)') <
      source.indexOf('await this.launchOnce(sessionFile, attempt)')
  );
});

test('gate setup precedes runtime warmup and untrusted workspaces do not write policy', async () => {
  const source = await readFile('src/extension.ts', 'utf8');
  assert.ok(
    source.indexOf('await syncApprovalGateForWorkspace(') <
      source.indexOf('const sharedHost = initSharedPiHost(')
  );
  const h = await syncHarness();
  h.api.workspace.isTrusted = false;
  await assert.rejects(
    h.module.syncApprovalGateForWorkspace({ path: '/extension' }, true),
    /trusted workspace/
  );
  assert.deepEqual(h.operations, []);
});

test('enabling on an empty/missing settings file creates a minimal file', () => {
  const result = mergeApprovalGateSetting(undefined);
  assert.ok(result);
  const parsed = JSON.parse(result!);
  assert.deepEqual(parsed.extensions, ['./extensions/pi-approval-gate.ts']);
});

test('enabling preserves other settings and other extensions', () => {
  const existing = JSON.stringify({
    sessionDir: '/tmp/sessions',
    extensions: ['./extensions/something-else.ts'],
  });
  const result = mergeApprovalGateSetting(existing);
  const parsed = JSON.parse(result!);
  assert.equal(parsed.sessionDir, '/tmp/sessions');
  assert.deepEqual(parsed.extensions.sort(), [
    './extensions/pi-approval-gate.ts',
    './extensions/something-else.ts',
  ]);
});

test('enabling twice does not duplicate the entry', () => {
  const once = mergeApprovalGateSetting(undefined);
  const twice = mergeApprovalGateSetting(once);
  const parsed = JSON.parse(twice!);
  assert.deepEqual(parsed.extensions, ['./extensions/pi-approval-gate.ts']);
});

test('gate stays registered in both modes and preserves other settings', () => {
  const existing = JSON.stringify({
    sessionDir: '/tmp/sessions',
    extensions: ['./extensions/pi-approval-gate.ts', './extensions/something-else.ts'],
  });
  const result = mergeApprovalGateSetting(existing);
  const parsed = JSON.parse(result!);
  assert.equal(parsed.sessionDir, '/tmp/sessions');
  assert.deepEqual(parsed.extensions, [
    './extensions/something-else.ts',
    './extensions/pi-approval-gate.ts',
  ]);
});

test('existing gate registration stays intact', () => {
  const existing = JSON.stringify({ extensions: ['./extensions/pi-approval-gate.ts'] });
  assert.deepEqual(JSON.parse(mergeApprovalGateSetting(existing)), JSON.parse(existing));
});

test('automatic mode keeps hook available for a later toggle', () => {
  const existing = JSON.stringify({ sessionDir: '/tmp/sessions' });
  const result = mergeApprovalGateSetting(existing);
  const parsed = JSON.parse(result!);
  assert.deepEqual(parsed, {
    sessionDir: '/tmp/sessions',
    extensions: ['./extensions/pi-approval-gate.ts'],
  });
});

test('malformed or nonobject project settings are rejected without replacing user data', () => {
  for (const existing of ['{ not valid json', '', 'null', '[]', 'true', '{"extensions":false}']) {
    assert.throws(() => mergeApprovalGateSetting(existing));
  }
});

test('invalid or unreadable project settings fail before writing any policy files', async () => {
  const h = await syncHarness();
  const path = '/project/.pi/settings.json';
  h.files.set(path, Buffer.from('{ invalid existing settings'));
  await assert.rejects(h.module.syncApprovalGateForWorkspace({ path: '/extension' }, true));
  assert.equal(Buffer.from(h.files.get(path)!).toString(), '{ invalid existing settings');
  assert.deepEqual(h.operations, []);
  h.api.workspace.fs.readFile = async () => {
    throw Object.assign(new Error('permission denied'), { code: 'NoPermissions' });
  };
  await assert.rejects(
    h.module.syncApprovalGateForWorkspace({ path: '/extension' }, true),
    /permission denied/
  );
  assert.deepEqual(h.operations, []);
});
