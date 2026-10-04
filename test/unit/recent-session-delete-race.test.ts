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
