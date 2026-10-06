import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { PassThrough } from 'node:stream';

test('scopes controller and supervisor: shared/dedicated startup carry argv/env before first session; correlated controller mutation', async () => {
  const liveSettings: Record<string, unknown> = {};
  const opens: any[] = [];
  const handle = {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    onError() {},
    onExit() {},
    stop: async () => {},
  };
  const host = {
    openSession: async (info: any) => {
      opens.push(info);
      return handle;
    },
  };
  const vscode = {
    workspace: {
      isTrusted: false,
      getConfiguration: () => ({
        get: (key: string, fallback: unknown) => liveSettings[key] ?? fallback,
      }),
    },
  };
  const built = await build({
    stdin: {
      contents:
        "export { PiProcessSupervisor } from './src/process/supervisor'; export { SessionController } from './src/sessions/sessionController';",
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    external: ['vscode', 'fixture-sdk-host'],
    plugins: [
      {
        name: 'owned-no-spawn-startup',
        setup(b) {
          // This startup test owns a fake host; no executable or SDK discovery authority.
          b.onLoad({ filter: /piLauncher\.ts$/ }, () => ({
            contents: `export function isSupportedPiSdkVersion() { return true; }
            export function resolvePiLaunch(settings, env, cwd) {
              return Object.freeze({ command: settings.executable, prefixArgs: [],
                mode: 'subprocess', usingBundled: false, label: 'owned stub',
                sdkRoot: settings.executable === 'unexecuted-owned-stub'
                  ? '/owned/sdk-metadata' : settings.executable,
                env: Object.freeze({...env}), cwd });
            }`,
            loader: 'ts',
          }));
          b.onLoad({ filter: /sharedPiHost\.ts$/ }, () => ({
            contents: "export { getSharedPiHost } from 'fixture-sdk-host';",
            loader: 'ts',
          }));
        },
      },
    ],
  });
  const mod = { exports: {} as any };
  new Function('require', 'module', 'exports', built.outputFiles[0]!.text)(
    (name: string) =>
      name === 'vscode'
        ? vscode
        : name === 'fixture-sdk-host'
          ? { getSharedPiHost: () => host }
          : require(name),
    mod,
    mod.exports
  );
  const logger = { info() {}, warn() {}, error() {} };
  for (const sharedRuntime of [true, false]) {
    const supervisor = new mod.exports.PiProcessSupervisor(
      { name: 'Owned', uri: { fsPath: '/owned/workspace' } },
      logger,
      {
        sharedRuntime,
        piSource: 'external',
        executable: 'unexecuted-owned-stub',
        additionalArgs: [
          '--models',
          'a/*',
          '--session-dir',
          '/owned/sessions',
          '--no-skills',
          '--system-prompt',
          'Owned',
        ],
        offline: false,
        launchShell: '/owned/shell',
        maxRecordBytes: 1000000,
        maxPendingRequests: 10,
        maxQueuedWrites: 10,
      }
    );
    await supervisor.start('/owned/session.jsonl', { offline: true, noExtensions: true });
    const open = opens.at(-1);
    assert.equal(open.sdkRoot, '/owned/sdk-metadata');
    assert.equal(open.cwd, '/owned/workspace');
    assert.equal(open.sessionFile, '/owned/session.jsonl');
    assert.equal(open.dedicated, !sharedRuntime);
    assert.deepEqual(open.args, [
      '--mode',
      'rpc',
      '--offline',
      '--no-approve',
      '--no-extensions',
      '--session',
      '/owned/session.jsonl',
      '--models',
      'a/*',
      '--session-dir',
      '/owned/sessions',
      '--no-skills',
      '--system-prompt',
      'Owned',
    ]);
    assert.equal(open.env.PI_OFFLINE, '1');
    assert.equal(open.env.PI_LAUNCH_SHELL, '/owned/shell');
    assert.equal(open.env.PI_TELEMETRY, '0');
    assert.equal(open.env.PI_SKIP_VERSION_CHECK, '1');
    await supervisor.stop();
  }

  Object.assign(liveSettings, {
    piSource: 'external',
    executable: '/old/pi',
    sharedRuntime: true,
    additionalArgs: [],
    offline: false,
    launchShell: '',
  });
  const liveSupervisor = new mod.exports.PiProcessSupervisor(
    { name: 'Owned', uri: { fsPath: '/owned/workspace' } },
    logger
  );
  liveSettings.executable = '/configured/pi-1.0.4';
  await liveSupervisor.start();
  assert.equal(opens.at(-1).sdkRoot, '/configured/pi-1.0.4');
  await liveSupervisor.stop();
  const controller = Object.create(mod.exports.SessionController.prototype);
  const calls: any[] = [];
  let release: (() => void) | undefined;
  const client = {
    getScopedModels: async () => ({ revision: 'r' }),
    setScopedModels: (...args: any[]) => {
      calls.push(args);
      return new Promise<void>((r) => {
        release = r;
      });
    },
  };
  controller.requireClient = () => client;
  controller.supervisor = { currentClient: client };
  controller.state = { state: { sessionId: 'origin' } };
  assert.deepEqual(await controller.getScopedModels(), { revision: 'r' });
  const refs = [{ provider: 'a', id: 'one', thinkingLevel: 'high' }];
  const applying = controller.applyScopedModels(refs, 'r', true, true);
  assert.deepEqual(calls[0], [refs, 'r', true, true]);
  release!();
  await applying;
  const stale = controller.applyScopedModels([], 'r2', false, false);
  controller.supervisor.currentClient = {};
  release!();
  await assert.rejects(stale, /originating chat changed/);
});
