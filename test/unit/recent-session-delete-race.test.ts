import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { transform } from 'esbuild';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('a scan started before deletion cannot resurrect the deleted chat', async () => {
  const source = readFileSync('src/sessions/recentSessionService.ts', 'utf8');
  const start = source.indexOf('export class RecentSessionService');
  assert.ok(start >= 0);
  const compiled = await transform(
    source.slice(start).replace('export class', 'class') + '\nreturn RecentSessionService;',
    { loader: 'ts' }
  );
  const older = deferred<{ sessionDir: string; sessions: Array<{ path: string }> }>();
  const newer = deferred<{ sessionDir: string; sessions: Array<{ path: string }> }>();
  let scans = 0;
  const folder = {
    name: 'project',
    uri: { toString: () => 'file:///project', fsPath: '/project' },
  };
  const vscode = {
    EventEmitter: class {
      event = () => ({ dispose() {} });
      fire() {}
      dispose() {}
    },
    workspace: { workspaceFolders: [folder] },
  };
  const RecentSessionService = new Function(
    'vscode',
    'getSettings',
    'filterRecentSessions',
    'readRecentSessionsIndex',
    'readAllProjectsSessions',
    compiled.code
  )(
    vscode,
    () => ({ additionalArgs: [] }),
    (items: unknown[]) => items,
    () => (++scans === 1 ? older.promise : newer.promise),
    async () => []
  ) as new (indexService: unknown) => {
    getState(folder: unknown): { items: Array<{ path: string }> };
    removePath(path: string): void;
    refresh(folder: unknown): Promise<void>;
  };
  const service = new RecentSessionService({ scanAll: async () => [] });
  const oldRefresh = service.refresh(folder);
  service.removePath('/s/a.jsonl');
  const newRefresh = service.refresh(folder);
  newer.resolve({ sessionDir: '/s', sessions: [] });
  await newRefresh;
  older.resolve({ sessionDir: '/s', sessions: [{ path: '/s/a.jsonl' }] });
  await oldRefresh;
  assert.deepEqual(service.getState(folder).items, []);
});

test('current-workspace chats publish before the all-project scan finishes', async () => {
  const source = readFileSync('src/sessions/recentSessionService.ts', 'utf8');
  const start = source.indexOf('export class RecentSessionService');
  assert.ok(start >= 0);
  const compiled = await transform(
    source.slice(start).replace('export class', 'class') + '\nreturn RecentSessionService;',
    { loader: 'ts' }
  );
  const own = deferred<{ sessionDir: string; sessions: Array<{ path: string }> }>();
  const other = deferred<Array<{ path: string }>>();
  const folder = {
    name: 'project',
    uri: { toString: () => 'file:///project', fsPath: '/project' },
  };
  const vscode = {
    EventEmitter: class {
      event = () => ({ dispose() {} });
      fire() {}
      dispose() {}
    },
    workspace: { workspaceFolders: [folder] },
  };
  const RecentSessionService = new Function(
    'vscode',
    'getSettings',
    'filterRecentSessions',
    'readRecentSessionsIndex',
    'readAllProjectsSessions',
    compiled.code
  )(
    vscode,
    () => ({ additionalArgs: [] }),
    (items: unknown[]) => items,
    () => own.promise,
    async () => []
  ) as new (indexService: unknown) => {
    getState(folder: unknown): {
      loading: boolean;
      items: Array<{ path: string }>;
      others?: Array<{ path: string }>;
    };
    refresh(folder: unknown): Promise<void>;
  };
  const service = new RecentSessionService({ scanAll: () => other.promise });

  const refresh = service.refresh(folder);
  own.resolve({ sessionDir: '/s', sessions: [{ path: '/s/current.jsonl' }] });
  await refresh;

  const state = service.getState(folder);
  assert.equal(state.loading, false);
  assert.deepEqual(state.items, [{ path: '/s/current.jsonl' }]);
  assert.equal(state.others, undefined);

  other.resolve([{ path: '/s/other.jsonl' }]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(service.getState(folder).others, [{ path: '/s/other.jsonl' }]);
});

test('deletion invalidates a shared all-project scan before the next refresh', async () => {
  const source = readFileSync('src/sessions/recentSessionService.ts', 'utf8');
  const start = source.indexOf('export class RecentSessionService');
  const compiled = await transform(
    source.slice(start).replace('export class', 'class') + '\nreturn RecentSessionService;',
    { loader: 'ts' }
  );
  const stale = deferred<Array<{ path: string }>>();
  const fresh = deferred<Array<{ path: string }>>();
  let projectScans = 0;
  const folder = {
    name: 'project',
    uri: { toString: () => 'file:///project', fsPath: '/project' },
  };
  const vscode = {
    EventEmitter: class {
      event = () => ({ dispose() {} });
      fire() {}
      dispose() {}
    },
    workspace: { workspaceFolders: [folder] },
  };
  const RecentSessionService = new Function(
    'vscode',
    'getSettings',
    'filterRecentSessions',
    'readRecentSessionsIndex',
    'readAllProjectsSessions',
    compiled.code
  )(
    vscode,
    () => ({ additionalArgs: [] }),
    (items: unknown[]) => items,
    async () => ({ sessionDir: '/s', sessions: [] }),
    async () => []
  ) as new (indexService: unknown) => {
    getState(folder: unknown): { others?: Array<{ path: string }> };
    removePath(path: string): void;
    refresh(folder: unknown): Promise<void>;
  };
  const service = new RecentSessionService({
    scanAll: () => (++projectScans === 1 ? stale.promise : fresh.promise),
  });

  await service.refresh(folder);
  service.removePath('/s/deleted.jsonl');
  await service.refresh(folder);
  assert.equal(projectScans, 2);
  fresh.resolve([]);
  stale.resolve([{ path: '/s/deleted.jsonl' }]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(service.getState(folder).others, []);
});

test('concurrent refresh calls share the same workspace scan', async () => {
  const source = readFileSync('src/sessions/recentSessionService.ts', 'utf8');
  const start = source.indexOf('export class RecentSessionService');
  assert.ok(start >= 0);
  const compiled = await transform(
    source.slice(start).replace('export class', 'class') + '\nreturn RecentSessionService;',
    { loader: 'ts' }
  );
  const own = deferred<{ sessionDir: string; sessions: Array<{ path: string }> }>();
  let scans = 0;
  const folder = {
    name: 'project',
    uri: { toString: () => 'file:///project', fsPath: '/project' },
  };
  const vscode = {
    EventEmitter: class {
      event = () => ({ dispose() {} });
      fire() {}
      dispose() {}
    },
    workspace: { workspaceFolders: [folder] },
  };
  const RecentSessionService = new Function(
    'vscode',
    'getSettings',
    'filterRecentSessions',
    'readRecentSessionsIndex',
    'readAllProjectsSessions',
    compiled.code
  )(
    vscode,
    () => ({ additionalArgs: [] }),
    (items: unknown[]) => items,
    () => {
      scans += 1;
      return own.promise;
    },
    async () => []
  ) as new (indexService: unknown) => {
    refresh(folder: unknown): Promise<void>;
  };
  const service = new RecentSessionService({ scanAll: async () => [] });

  const first = service.refresh(folder);
  const second = service.refresh(folder);
  assert.equal(scans, 1);
  own.resolve({ sessionDir: '/s', sessions: [] });
  await Promise.all([first, second]);
  assert.equal(scans, 1);
});
