import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { PassThrough } from 'node:stream';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SharedPiHost } from '../../src/process/sharedPiHost';

test('supervisor keeps probe and subprocess bound despite async PATH/settings drift; shared/dedicated use captured roots', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pi-supervisor-metadata-')));
  const originalPath = process.env.PATH;
  const sdk = (name: string) => {
    const root = join(dir, name);
    mkdirSync(join(root, 'dist'), { recursive: true });
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        name: '@earendil-works/pi-coding-agent',
        version: '0.99.1',
        bin: { pi: 'dist/cli.js' },
      }),
      { mode: 0o444 }
    );
    writeFileSync(join(root, 'dist/cli.js'), '', { mode: 0o555 });
    return root;
  };
  try {
    const a = sdk('a');
    const b = sdk('b');
    const spawned: any[] = [];
    const handle = (sdkRoot: string) => ({
      sdkRoot,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      onError() {},
      onExit() {},
      async stop() {},
    });
    const result = await build({
      entryPoints: ['src/process/supervisor.ts'],
      bundle: true,
      write: false,
      platform: 'node',
      format: 'cjs',
      external: ['vscode'],
      plugins: [
        {
          name: 'no-child-authority',
          setup(builder) {
            builder.onResolve({ filter: /^(\.\/piProcess|\.\/sharedPiHost)$/ }, (args) => ({
              path: args.path,
              external: true,
            }));
          },
        },
      ],
    });
    const mod = { exports: {} as any };
    new Function('require', 'module', 'exports', result.outputFiles[0]!.text)(
      (id: string) => {
        if (id === 'vscode') return { workspace: { isTrusted: false } };
        if (id === './sharedPiHost') return { getSharedPiHost: () => undefined };
        if (id === './piProcess')
          return {
            spawnSubprocessPi: (opts: any) => {
              spawned.push(opts);
              return handle(opts.sdkRoot);
            },
            spawnWorkerPi: () => {
              throw new Error('unexpected worker');
            },
          };
        return createRequire(`${process.cwd()}/package.json`)(id);
      },
      mod,
      mod.exports
    );
    const settings: any = {
      piSource: 'external',
      executable: join(b, 'dist/cli.js'),
      additionalArgs: [],
      launchShell: '',
      offline: true,
      sharedRuntime: false,
      maxRecordBytes: 1024,
      maxPendingRequests: 8,
      maxQueuedWrites: 8,
    };
    process.env.PATH = join(b, 'dist');
    const supervisor = new mod.exports.PiProcessSupervisor(
      { name: 'owned', uri: { fsPath: dir } },
      { info() {}, warn() {}, error() {} },
      settings
    );
    let probed: any;
    supervisor.probeVersion = async (plan: any) => {
      probed = plan;
      await Promise.resolve();
      process.env.PATH = join(a, 'dist');
      settings.executable = join(a, 'dist/cli.js');
      settings.piSource = 'managed';
      return { code: 0, stdout: '0.99.1', stderr: '' };
    };
    await supervisor.start();
    assert.equal(spawned.length, 1);
    assert.equal(spawned[0].command, join(b, 'dist/cli.js'));
    assert.equal(spawned[0].command, probed.command);
    assert.equal(spawned[0].env, probed.env);
    assert.equal(spawned[0].cwd, probed.cwd);
    assert.equal(supervisor.sdkRoot, b);
    await supervisor.stop();
    // Exercise real pool selection, replacing only spawnConn: metadata is never executable authority.
    const host: any = new SharedPiHost(
      'unused',
      {},
      { info() {}, warn() {}, error() {} },
      async () => {
        throw new Error('must not rediscover');
      },
      1
    );
    host.spawnConn = (root: string, env: any, cwd: string, reusable = true) => ({
      piRoot: root,
      env,
      cwd,
      reusable,
    });
    for (const dedicated of [false, true]) {
      const selected = await host.pickConn({ cwd: dir, env: probed.env, sdkRoot: b, dedicated });
      assert.equal(selected.piRoot, b);
      assert.equal(selected.env, probed.env);
      assert.equal(selected.reusable, !dedicated);
    }
    host.conns.push({
      piRoot: a,
      fault: undefined,
      matchesEnvironment: () => true,
      warm: true,
      sessionCount: 0,
    });
    assert.equal((await host.pickConn({ cwd: dir, env: probed.env, sdkRoot: b })).piRoot, b);
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    rmSync(dir, { recursive: true, force: true });
  }
});
