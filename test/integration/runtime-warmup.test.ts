import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { piLaunchEnvironment } from '../../src/process/piLauncher';
import { SharedPiHost } from '../../src/process/sharedPiHost';
import type { PiProcessHandle } from '../../src/process/piProcess';
import { RpcClient } from '../../src/rpc/client';
import { RpcTransport } from '../../src/rpc/transport';
import { createNativeFixture, nativeSdkHostPlan } from '../helpers/nativeFixture';

test('activation passes the workspace launch snapshot to runtime-only warmup', async () => {
  const built = await build({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    plugins: [
      {
        name: 'activation-boundary',
        setup(builder) {
          builder.onResolve({ filter: /^\./ }, (args) =>
            args.importer ? { path: args.path, external: true } : undefined
          );
        },
      },
    ],
    external: ['vscode'],
  });
  const require = createRequire(`${process.cwd()}/package.json`);
  const settings = {
    executable: '/owned/pi',
    piSource: 'managed',
    sharedRuntime: true,
    runtimeWorkers: 1,
    launchShell: '/owned/shell',
    offline: true,
  };
  let launch: any;
  let ideExtension: string | undefined;
  let warmArgs: any[] | undefined;
  const sentinel = new Error('activation characterization boundary');
  const mocks: Record<string, any> = {
    './ide/query': {
      setIdeExtensionPath: (value: string) => {
        ideExtension = value;
      },
    },
    './config/settings': { getSettings: () => settings },
    './process/piLauncher': {
      setBundledPiCliPath() {},
      setManagedPiCliPath() {},
      detectPathPi: () => ({ binPath: '/owned/pi', packageRoot: '/owned/sdk', version: '1.1.0' }),
      selectedSdkRoot: () => '/owned/sdk',
      usablePathPiRoot: () => '/owned/sdk',
      isSupportedPiSdkVersion: () => true,
      piLaunchEnvironment,
      resolvePiLaunch: (_settings: unknown, env: any, cwd: string) =>
        (launch = { sdkRoot: '/owned/sdk', env, cwd }),
    },
    './process/piManaged': {
      managedPiCliPath: () => '/owned/managed/pi',
      installedManagedVersion: () => '1.1.0',
    },
    './diagnostics/logger': {
      DiagnosticsLogger: class {
        info() {}
        warn() {}
      },
    },
    './process/sharedPiHost': {
      initSharedPiHost: () => ({
        warmPool: (...args: any[]) => {
          warmArgs = args;
        },
      }),
    },
    './sessions/sessionIndexService': { SessionIndexService: class {} },
    './sessions/sessionRegistry': {
      SessionRegistry: class {
        constructor() {
          throw sentinel;
        }
      },
    },
  };
  const module = { exports: {} as any };
  new Function('require', 'module', 'exports', built.outputFiles[0]!.text)(
    (id: string) =>
      id === 'vscode'
        ? {
            Uri: {
              joinPath: (uri: any, ...parts: string[]) => ({ fsPath: join(uri.fsPath, ...parts) }),
            },
            workspace: { workspaceFolders: [{ uri: { fsPath: '/owned/workspace' } }] },
          }
        : (mocks[id] ?? (id.startsWith('.') ? {} : require(id))),
    module,
    module.exports
  );
  await assert.rejects(
    module.exports.activate({
      extensionUri: { fsPath: '/owned/extension' },
      extensionPath: '/owned/extension',
      globalStorageUri: { fsPath: '/owned/storage' },
      extension: { packageJSON: { version: '0.2.29' } },
      subscriptions: [],
    }),
    (error) => error === sentinel
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(ideExtension, join('/owned/extension', 'resources', 'pi-vscode-ide.mjs'));
  assert.ok(
    warmArgs && warmArgs[1] === launch,
    'activation must pass the exact resolved launch snapshot'
  );
  assert.equal(warmArgs[0], undefined, 'activation does not create a parked draft');
  assert.equal(launch.cwd, '/owned/workspace');
  assert.equal(launch.env.PI_TELEMETRY, '0');
  assert.equal(launch.env.PI_OFFLINE, '1');
  assert.equal(launch.env.PI_LAUNCH_SHELL, '/owned/shell');
});

test(
  'activation warmup and live-session switching reuse the same offline SDK worker',
  { timeout: 30000 },
  async (t) => {
    const fixture = await createNativeFixture();
    const handles: PiProcessHandle[] = [];
    const transports: RpcTransport[] = [];
    let host: SharedPiHost | undefined;
    try {
      const plan = await nativeSdkHostPlan(fixture, 'shared');
      const env = {
        ...plan.env,
        NODE_OPTIONS: plan.args
          .slice(0, -1)
          .map((arg) => JSON.stringify(arg))
          .join(' '),
      };
      let warmed!: () => void;
      const warm = new Promise<void>((resolve) => {
        warmed = resolve;
      });
      const warnings: string[] = [];
      host = new SharedPiHost(
        plan.args.at(-1)!,
        { ...env, PI_OFFLINE: '0' },
        {
          info(message) {
            if (message.includes('runtime pool warm')) warmed();
          },
          warn(message) {
            warnings.push(message);
          },
          error(message) {
            warnings.push(message);
          },
        },
        async () => plan.env.PI_HOST_PI_ROOT!,
        1
      );
      const started = performance.now();
      host.warmPool(undefined, { cwd: fixture.cwd, env, sdkRoot: plan.env.PI_HOST_PI_ROOT });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          warm,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`Warmup did not complete: ${warnings.join('\n')}`)),
              10000
            );
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      const warmMs = performance.now() - started;
      const warmedPool = host.poolStatus();
      assert.equal(warmedPool.length, 1);
      assert.equal(warmedPool[0]!.sessions, 0, 'activation warms a runtime, not a draft');

      async function open() {
        const handle = await host!.openSession({
          cwd: fixture.cwd,
          args: [...plan.open.args],
          env,
          sdkRoot: plan.env.PI_HOST_PI_ROOT,
        });
        handles.push(handle);
        const transport = new RpcTransport(handle.stdin, handle.stdout, handle.stderr, {
          maxRecordBytes: 1000000,
          maxBufferBytes: 1000000,
          maxPendingRequests: 64,
          maxQueuedWrites: 64,
        });
        transports.push(transport);
        return new RpcClient(handles.length, transport, {
          shortTimeoutMs: 10000,
          longTimeoutMs: 10000,
        });
      }
      const openedAt = performance.now();
      const a = await open();
      const firstOpenMs = performance.now() - openedAt;
      assert.deepEqual(
        host.poolStatus().map(({ id }) => id),
        warmedPool.map(({ id }) => id),
        'first chat must use the activation-warmed worker'
      );
      const b = await open();
      assert.equal(
        host.poolStatus().length,
        1,
        'parallel chat reuses resident pool at configured limit'
      );
      const files = ['a', 'b'].map((id) => join(fixture.cwd, `${id}.jsonl`));
      for (const [i, file] of files.entries()) {
        await writeFile(
          file,
          [
            {
              type: 'session',
              version: 3,
              id: `owned-${i}`,
              timestamp: '2024-01-01T00:00:00.000Z',
              cwd: fixture.cwd,
            },
            {
              type: 'message',
              id: `message-${i}`,
              parentId: null,
              timestamp: '2024-01-01T00:00:00.000Z',
              message: {
                role: 'user',
                content: [{ type: 'text', text: `history-${i}` }],
                timestamp: 1704067200000,
              },
            },
          ]
            .map((record) => JSON.stringify(record))
            .join('\n') + '\n'
        );
      }
      await a.switchSession(files[0]!);
      await b.switchSession(files[1]!);
      const identities = [(await a.getState())!.sessionId, (await b.getState())!.sessionId];
      assert.notEqual(identities[0], identities[1]);
      for (let i = 0; i < 3; i++) {
        assert.equal((await a.getState())!.sessionId, identities[0]);
        assert.equal((await b.getState())!.sessionId, identities[1]);
        assert.deepEqual(
          host.poolStatus().map(({ id }) => id),
          warmedPool.map(({ id }) => id)
        );
      }
      const aHistory = await a.getMessages();
      const bHistory = await b.getMessages();
      assert.match(JSON.stringify(aHistory), /history-0/);
      assert.doesNotMatch(JSON.stringify(aHistory), /history-1/);
      assert.match(JSON.stringify(bHistory), /history-1/);
      await a.newSession();
      assert.notEqual((await a.getState())!.sessionId, identities[0]);
      assert.equal((await b.getState())!.sessionId, identities[1]);
      assert.equal(host.poolStatus().length, 1);
      const changedEnvironment = await host.openSession({
        cwd: fixture.cwd,
        args: [...plan.open.args],
        env: { ...env, PI_LAUNCH_SHELL: 'owned-other-shell' },
        sdkRoot: plan.env.PI_HOST_PI_ROOT,
      });
      handles.push(changedEnvironment);
      assert.equal(host.poolStatus().length, 2, 'different launch environments remain isolated');
      const otherWorkspace = join(fixture.cwd, 'other-workspace');
      await mkdir(otherWorkspace);
      const changedWorkspace = await host.openSession({
        cwd: otherWorkspace,
        args: [...plan.open.args],
        env,
        sdkRoot: plan.env.PI_HOST_PI_ROOT,
      });
      handles.push(changedWorkspace);
      assert.equal(host.poolStatus().length, 3, 'different OS working directories remain isolated');
      assert.equal(
        (await b.getState())!.sessionId,
        identities[1],
        'isolated workers do not change live session identity'
      );
      assert.equal(fixture.requests, 0);
      t.diagnostic(
        `Observed runtime warmup ${warmMs.toFixed(1)} ms; first warm open ${firstOpenMs.toFixed(1)} ms (no timing assertions).`
      );
    } finally {
      for (const transport of transports) transport.disconnect(new Error('test shutdown'));
      for (const handle of handles) await handle.stop();
      const children = ((host as any)?.conns ?? []).map((conn: any) => conn.child);
      host?.dispose();
      await Promise.all(
        children.map((child: any) => {
          if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
          return new Promise<void>((resolve) => {
            const timer = setTimeout(() => child.kill('SIGKILL'), 1000);
            child.once('exit', () => {
              clearTimeout(timer);
              resolve();
            });
          });
        })
      );
      const attempts = await readFile(fixture.networkLog, 'utf8');
      await fixture.dispose();
      assert.equal(attempts.trim(), '', 'no forbidden network access');
    }
  }
);
