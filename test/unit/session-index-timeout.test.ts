import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { transform } from 'esbuild';
import { build } from 'esbuild';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { SessionIndexService } from '../../src/sessions/sessionIndexService';
import type { DiagnosticsLogger } from '../../src/diagnostics/logger';
import { createTestDirectory } from '../helpers/temp';

test('timed-out indexing terminates original work before rejection and old exits cannot reject replacement requests', async () => {
  const source = readFileSync('src/sessions/sessionIndexService.ts', 'utf8');
  const compiled = await transform(
    source
      .slice(
        source.indexOf('export class SessionIndexTimeoutError') >= 0
          ? source.indexOf('export class SessionIndexTimeoutError')
          : source.indexOf('export class SessionIndexService')
      )
      .replaceAll('export class', 'class') + '\nreturn SessionIndexService;',
    { loader: 'ts' }
  );
  const workers: FakeWorker[] = [];
  const timers: (() => void)[] = [];
  let finishTermination!: () => void;
  class FakeWorker {
    listeners = new Map<string, (message?: unknown) => void>();
    sent: { id: number }[] = [];
    terminated = false;
    constructor() {
      workers.push(this);
    }
    on(name: string, callback: (message?: unknown) => void) {
      this.listeners.set(name, callback);
    }
    unref() {}
    postMessage(message: { id: number }) {
      this.sent.push(message);
    }
    terminate() {
      this.terminated = true;
      return new Promise<void>((done) => {
        finishTermination = done;
      });
    }
  }
  const Service = new Function(
    'Worker',
    'path',
    'existsSync',
    'setTimeout',
    'clearTimeout',
    compiled.code
  )(
    FakeWorker,
    { join: () => '/fixture/worker.js' },
    () => true,
    (callback: () => void) => {
      timers.push(callback);
      return timers.length;
    },
    () => {}
  ) as new (path: string, logger: unknown) => { scanAll(paths: string[]): Promise<unknown> };
  const service = new Service('/fixture', { warn() {} });
  let rejected = false;
  const first = service.scanAll([]).catch((error: Error) => {
    rejected = true;
    assert.equal(error.name, 'SessionIndexTimeoutError');
  });
  timers[0]!();
  await Promise.resolve();
  assert.equal(workers[0]?.terminated, true);
  assert.equal(rejected, false, 'rejection must wait for terminated original work');
  const second = service.scanAll([]);
  workers[0]?.listeners.get('exit')?.();
  const replacement = workers[1]!;
  replacement.listeners.get('message')?.({ id: replacement.sent[0]!.id, ok: true, records: [] });
  assert.deepEqual(await second, []);
  finishTermination();
  await first;
});

test('a short list timeout preserves pending history and resumes cleanup after history completes', async () => {
  const source = readFileSync('src/sessions/sessionIndexService.ts', 'utf8');
  const compiled = await transform(
    source
      .slice(source.indexOf('export class SessionIndexTimeoutError'))
      .replaceAll('export class', 'class') + '\nreturn SessionIndexService;',
    { loader: 'ts' }
  );
  const timers: { callback: () => void; delay: number }[] = [];
  let finishTermination!: () => void;
  const sent: { id: number; op: string }[] = [];
  const listeners = new Map<string, (message?: unknown) => void>();
  let terminated = false;
  class FakeWorker {
    on(name: string, callback: (message?: unknown) => void) {
      listeners.set(name, callback);
    }
    unref() {}
    postMessage(message: { id: number; op: string }) {
      sent.push(message);
    }
    terminate() {
      terminated = true;
      return new Promise<void>((done) => {
        finishTermination = done;
      });
    }
  }
  const Service = new Function(
    'Worker',
    'path',
    'existsSync',
    'setTimeout',
    'clearTimeout',
    compiled.code
  )(
    FakeWorker,
    { join: () => '/fixture/worker.js' },
    () => true,
    (callback: () => void, delay: number) => {
      timers.push({ callback, delay });
      return timers.length;
    },
    () => {}
  ) as new (
    path: string,
    logger: unknown
  ) => { scanAll(paths: string[]): Promise<unknown>; readHistory(file: string): Promise<unknown> };
  const service = new Service('/fixture', { warn() {} });
  let scanRejected = false;
  const scan = service.scanAll([]).catch((error: Error) => {
    scanRejected = true;
    assert.equal(error.name, 'SessionIndexTimeoutError');
  });
  const history = service.readHistory('/fixture/history.jsonl');
  assert.equal(timers[0]?.delay, 10_000);
  assert.equal(timers[1]?.delay, 60_000);
  timers[0]!.callback();
  await Promise.resolve();
  assert.equal(terminated, false);
  assert.equal(scanRejected, false);
  assert.equal(sent.length, 2, 'deferral must not start a replacement scan');
  listeners.get('message')?.({
    id: sent[1]!.id,
    ok: true,
    messages: [{ role: 'assistant', content: 'history' }],
  });
  assert.deepEqual(await history, [{ role: 'assistant', content: 'history' }]);
  timers[2]!.callback();
  assert.equal(
    terminated,
    true,
    'stalled list work must eventually terminate after history settles'
  );
  assert.equal(scanRejected, false);
  finishTermination();
  await scan;
});

test('slow worker scans do not fall back to another inline scan, while unavailable workers do', async () => {
  const source = readFileSync('src/sessions/recentSessionService.ts', 'utf8');
  const compiled = await transform(
    source
      .slice(source.indexOf('export class RecentSessionService'))
      .replace('export class', 'class') + '\nreturn RecentSessionService;',
    { loader: 'ts' }
  );
  let inlineWorkspace = 0,
    inlineAll = 0;
  const folder = { name: 'fixture', uri: { fsPath: '/fixture', toString: () => '/fixture' } };
  const Service = new Function(
    'vscode',
    'getSettings',
    'filterRecentSessions',
    'readRecentSessionsIndex',
    'readAllProjectsSessions',
    compiled.code
  )(
    {
      EventEmitter: class {
        event = () => {};
        fire() {}
        dispose() {}
      },
      workspace: { workspaceFolders: [folder] },
    },
    () => ({ additionalArgs: [] }),
    (items: unknown[]) => items,
    async () => {
      inlineWorkspace++;
      return { sessionDir: '/fixture', sessions: [] };
    },
    async () => {
      inlineAll++;
      return [];
    }
  ) as new (worker: unknown) => {
    refresh(folder: unknown): Promise<void>;
    getState(folder: unknown): { error?: string };
  };
  const timeout = new Error('slow scan');
  timeout.name = 'SessionIndexTimeoutError';
  const timedOut = new Service({
    scanWorkspace: async () => {
      throw timeout;
    },
    scanAll: async () => {
      throw timeout;
    },
  });
  await timedOut.refresh(folder);
  assert.equal(inlineWorkspace, 0);
  assert.equal(timedOut.getState(folder).error, 'slow scan');
  const broadTimeout = new Service({
    scanWorkspace: async () => ({ sessionDir: '/fixture', sessions: [] }),
    scanAll: async () => {
      throw timeout;
    },
  });
  await broadTimeout.refresh(folder);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(inlineAll, 0);
  const unavailable = new Service({
    scanWorkspace: async () => {
      throw new Error('unavailable');
    },
    scanAll: async () => {
      throw new Error('unavailable');
    },
  });
  await unavailable.refresh(folder);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(inlineWorkspace, 1);
  assert.equal(inlineAll, 1);
});

test('resident worker routes workspace scans and authoritative leaf history without losing image payloads', async () => {
  const root = await createTestDirectory('index-worker-');
  let service: SessionIndexService | undefined;
  try {
    await mkdir(join(root, 'dist'));
    await build({
      entryPoints: ['src/workers/sessionIndexWorker.ts'],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile: join(root, 'dist/sessionIndexWorker.js'),
      logLevel: 'silent',
    });
    const file = join(root, 'fixture.jsonl');
    const entries = [
      { type: 'session', id: 'header', cwd: root },
      {
        type: 'message',
        id: 'first',
        parentId: null,
        message: { role: 'user', content: 'Synthetic prompt' },
      },
      {
        type: 'message',
        id: 'discarded',
        parentId: 'first',
        message: { role: 'assistant', content: 'Other fork' },
      },
      { type: 'compaction', id: 'compaction', parentId: 'first' },
      {
        type: 'message',
        id: 'active',
        parentId: 'compaction',
        message: {
          role: 'assistant',
          content: [{ type: 'image', data: 'a'.repeat(1024), mimeType: 'image/png' }],
        },
      },
    ];
    await writeFile(file, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
    service = new SessionIndexService(root, { warn() {} } as unknown as DiagnosticsLogger);
    const index = await service.scanWorkspace({
      workspaceName: 'fixture',
      workspacePath: root,
      additionalArgs: ['--session-dir', root],
    });
    assert.equal(index.sessions[0]?.displayName, 'Synthetic prompt');
    assert.deepEqual(await service.readHistory(file, 'active'), [
      entries[1]!.message,
      entries[4]!.message,
    ]);
    assert.deepEqual(await service.readHistory(file, 'discarded'), [
      entries[1]!.message,
      entries[2]!.message,
    ]);
    assert.deepEqual(await service.readHistory(file, null), []);
  } finally {
    service?.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
