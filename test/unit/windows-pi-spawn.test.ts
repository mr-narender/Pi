import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

async function load(platform: 'win32' | 'linux') {
  const output = await build({
    stdin: {
      contents:
        "export { spawnSubprocessPi } from './src/process/piProcess'; export { PiProcessSupervisor } from './src/process/supervisor';",
      resolveDir: process.cwd(),
      loader: 'ts',
    },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    external: ['vscode', 'which'],
    define: { 'process.platform': JSON.stringify(platform) },
  });
  const calls: Array<{ command: string; args: string[]; options: any }> = [];
  const fakeSpawn = (command: string, args: string[], options: any) => {
    calls.push({ command, args, options });
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: () => true,
    });
    queueMicrotask(() => child.emit('exit', 0));
    return child;
  };
  const require = createRequire(`${process.cwd()}/package.json`);
  const module = { exports: {} as any };
  new Function('require', 'module', 'exports', output.outputFiles[0]!.text)(
    (name: string) => {
      if (name === 'node:child_process' || name === 'child_process') return { spawn: fakeSpawn };
      if (name === 'which') return Object.assign(() => {}, { sync: (command: string) => command });
      if (name === 'vscode') return {};
      return require(name);
    },
    module,
    module.exports
  );
  return { calls, ...module.exports };
}

test('Windows external Pi quotes configured command and extension paths with spaces and shell metacharacters', async () => {
  const { calls, spawnSubprocessPi, PiProcessSupervisor } = await load('win32');
  const command = 'C:\\Users\\First Last\\bin\\pi.cmd';
  const resource = 'C:\\Users\\First Last\\A&B!%\\pi-vscode-ide.mjs';
  const args = ['--extension', resource, '--tools', 'read'];
  spawnSubprocessPi({ command, args, cwd: 'C:\\work', env: {}, useShell: true });
  assert.match(calls[0].command, /(?:^|[\\/])cmd\.exe$/i);
  assert.deepEqual(calls[0].args.slice(0, 3), ['/d', '/s', '/c']);
  assert.match(calls[0].args[3], /First\^ Last/);
  assert.match(calls[0].args[3], /A\^&B\^!\^%/);
  assert.equal(calls[0].options.windowsVerbatimArguments, true);
  assert.notEqual(calls[0].options.shell, true, 'shell:true would disable cross-spawn escaping');
  assert.deepEqual(
    args,
    ['--extension', resource, '--tools', 'read'],
    'shared/worker argument arrays stay literal'
  );
  const supervisor = Object.create(PiProcessSupervisor.prototype);
  await supervisor.probeVersion({
    command,
    prefixArgs: [],
    cwd: 'C:\\work',
    env: {},
    usingBundled: false,
  });
  assert.match(calls[1].command, /(?:^|[\\/])cmd\.exe$/i);
  assert.match(calls[1].args[3], /First\^ Last/);
});

test('POSIX and direct Node SDK launches preserve literal executable and argument values', async () => {
  for (const platform of ['linux', 'win32'] as const) {
    const { calls, spawnSubprocessPi } = await load(platform);
    const args = ['--extension', '/Users/First Last/A&B/pi-vscode-ide.mjs'];
    spawnSubprocessPi({ command: 'node', args, cwd: '/work', env: {}, useShell: false });
    assert.equal(calls[0].command, 'node');
    assert.deepEqual(calls[0].args, args);
    assert.equal(calls[0].options.shell, false);
  }
});
