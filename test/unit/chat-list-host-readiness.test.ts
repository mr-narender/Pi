import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { build } from 'esbuild';

test('explicit list snapshot request recovers a snapshot sent before webview readiness', async () => {
  const compiled = await build({
    entryPoints: ['src/ui/sidebar/agenticChatListHost.ts'],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    external: ['vscode'],
    define: { __PI_BUILD__: '"test"' },
  });
  const require = createRequire(`${process.cwd()}/package.json`);
  const module = { exports: {} as Record<string, any> };
  new Function('require', 'module', 'exports', compiled.outputFiles[0]!.text)(
    (id: string) => (id === 'vscode' ? {} : require(id)),
    module,
    module.exports
  );
  const disposable = { dispose() {} };
  const host = new module.exports.AgenticChatListHost(
    {},
    { onDidChangeOpenChats: () => disposable, listOpenChats: () => [] },
    { onDidChange: () => disposable },
    {},
    { get: () => [] }
  );
  const delivered: unknown[] = [];
  let ready = false;
  host.view = {
    webview: {
      postMessage: async (message: unknown) => {
        if (ready) delivered.push(message);
        return ready;
      },
    },
  };
  host.buildModel = () => ({ rows: [], loading: false });
  await host.pushSnapshot();
  assert.equal(delivered.length, 0);
  ready = true;
  await host.onMessage({ type: 'requestListSnapshot' });
  assert.equal(delivered.length, 1, 'the ready renderer receives the unchanged current model');
  await host.pushSnapshot();
  assert.equal(delivered.length, 1, 'passive unchanged updates remain deduplicated');
  await host.onMessage({ type: 'requestListSnapshot' });
  assert.equal(delivered.length, 2, 'a reloaded renderer can request the same model again');
  await host.pushSnapshot();
  assert.equal(delivered.length, 2, 'reload recovery preserves passive deduplication');
  host.buildModel = () => ({ rows: [], loading: true });
  await host.onMessage({ type: 'requestListSnapshot' });
  assert.equal(delivered.length, 2, 'resync during refresh does not flash loading');
  host.buildModel = () => ({ rows: [], loading: false });
  await host.pushSnapshot();
  assert.equal(delivered.length, 3, 'refresh completion answers the deferred resync');
  host.snapshotState = { hasShownRealData: false };
  host.buildModel = () => ({ rows: [], loading: true });
  await host.pushSnapshot();
  host.buildModel = () => ({ rows: [], loading: false });
  await host.pushSnapshot();
  assert.equal(delivered.length, 5, 'first empty ready state replaces initial loading');
});

test('workspace roots and other projects remain visible and open in their indexed folder', async () => {
  const folder = (name: string) => ({
    name,
    uri: { fsPath: `/projects/${name}`, toString: () => name },
  });
  const a = folder('a');
  const b = folder('b');
  const session = (name: string, cwd: string, modifiedAt: number) => ({
    id: name,
    path: `/sessions/${name}.jsonl`,
    cwd,
    displayName: name,
    workspaceLabel: '',
    modifiedAt,
    createdAt: 1,
    messageCount: 1,
  });
  const parent = session('parent', '/projects', 3);
  const stateA = {
    loading: false,
    filterText: '',
    items: [session('a', a.uri.fsPath, 1)],
    others: [] as (typeof parent)[],
  };
  const stateB = { loading: true, filterText: '', items: [] as (typeof parent)[] };
  let changed: (() => void) | undefined;
  let refreshes = 0;
  const legacyFilters = new Map<string, string>();
  const commands: unknown[][] = [];
  const disposable = { dispose() {} };
  const vscode = {
    workspace: {
      workspaceFolders: [a, b],
      onDidChangeWorkspaceFolders: (cb: () => void) => {
        changed = cb;
        return disposable;
      },
    },
    commands: {
      executeCommand: async (...args: unknown[]) => {
        commands.push(args);
      },
    },
  };
  const compiled = await build({
    entryPoints: ['src/ui/sidebar/agenticChatListHost.ts'],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    external: ['vscode'],
    define: { __PI_BUILD__: '"test"' },
  });
  const require = createRequire(`${process.cwd()}/package.json`);
  const module = { exports: {} as Record<string, any> };
  new Function('require', 'module', 'exports', compiled.outputFiles[0]!.text)(
    (id: string) => (id === 'vscode' ? vscode : require(id)),
    module,
    module.exports
  );
  const host = new module.exports.AgenticChatListHost(
    {},
    { onDidChangeOpenChats: () => disposable, listOpenChats: () => [] },
    {
      onDidChange: () => disposable,
      getState: (f: typeof a) => {
        const state = f === a ? stateA : stateB;
        const filter = legacyFilters.get(f.name);
        return filter
          ? { ...state, items: state.items.filter((item) => item.displayName.includes(filter)) }
          : state;
      },
      clearFilter: (f: typeof a) => legacyFilters.delete(f.name),
      refresh: async () => {
        refreshes += 1;
      },
    },
    a,
    { get: () => [] }
  );
  assert.deepEqual(
    host.buildModel().rows.map((row: any) => row.title),
    ['a'],
    'loading second root does not hide available chats'
  );
  stateA.loading = true;
  const initialItems = stateA.items;
  stateA.items = [];
  assert.equal(host.buildModel().loading, true, 'initial all-root scan shows loading');
  stateA.items = initialItems;
  stateA.loading = false;
  stateB.loading = false;
  stateB.items = [session('b', b.uri.fsPath, 2)];
  stateA.others = [parent];
  assert.deepEqual(
    host.buildModel().rows.map((row: any) => row.title),
    ['parent', 'b', 'a']
  );
  vscode.workspace.workspaceFolders.reverse();
  assert.deepEqual(
    host.buildModel().rows.map((row: any) => row.title),
    ['parent', 'b', 'a'],
    'root order does not change history'
  );
  await host.onMessage({ type: 'filterChatFolder', path: b.uri.fsPath });
  assert.deepEqual(
    host.buildModel().rows.map((row: any) => row.title),
    ['b']
  );
  assert.equal(commands.length, 0, 'folder filtering never activates another chat or controller');
  await host.onMessage({ type: 'filterChatFolder', path: '/spoofed' });
  assert.equal(host.buildModel().selectedFolder, b.uri.fsPath, 'unknown choices are rejected');
  await host.onMessage({ type: 'filterChats', text: 'parent' });
  assert.equal(host.buildModel().rows.length, 0, 'search combines with the selected owner');
  assert.equal(host.buildModel().folders.length, 3, 'empty search results retain every choice');
  await host.onMessage({ type: 'filterChats', text: '' });
  changed?.();
  assert.equal(host.buildModel().selectedFolder, b.uri.fsPath, 'refresh retains selection');
  host.detach();
  assert.equal(
    host.buildModel().selectedFolder,
    b.uri.fsPath,
    'reattachment retains host selection'
  );
  await host.onMessage({ type: 'filterChatFolder', path: '' });
  await host.onMessage({ type: 'openChat', sessionPath: '/sessions/b.jsonl', cwd: '/spoofed' });
  assert.deepEqual(commands, [
    ['piRpcInternal.openOtherChat', { sessionPath: '/sessions/b.jsonl', cwd: b.uri.fsPath }],
  ]);
  await host.onMessage({
    type: 'openChat',
    sessionPath: '/sessions/not-indexed.jsonl',
    cwd: '/spoofed',
  });
  assert.equal(commands.length, 1, 'unindexed paths are rejected');
  legacyFilters.set(a.name, 'not found');
  legacyFilters.set(b.name, 'not found');
  await host.onMessage({ type: 'filterChats', text: '' });
  assert.deepEqual(
    host.buildModel().rows.map((row: any) => row.title),
    ['parent', 'b', 'a'],
    'clearing the UI filter also clears prior per-root command filters'
  );
  await host.onMessage({ type: 'filterChats', text: 'parent' });
  assert.deepEqual(
    host.buildModel().rows.map((row: any) => row.title),
    ['parent']
  );
  changed?.();
  assert.equal(refreshes, 2);
  await host.onMessage({ type: 'filterChatFolder', path: b.uri.fsPath });
  vscode.workspace.workspaceFolders = [a];
  assert.equal(host.buildModel().selectedFolder, '', 'removed owner falls back to All folders');
  await host.onMessage({ type: 'filterChats', text: '' });
  assert.deepEqual(
    host.buildModel().rows.map((row: any) => row.title),
    ['parent', 'a'],
    'removed roots do not leak their previous workspace-only rows'
  );
  host.dispose();
});
