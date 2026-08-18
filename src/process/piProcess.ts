import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Worker } from 'node:worker_threads';
import type { Readable, Writable } from 'node:stream';

// A running Pi instance, whether an OS subprocess or an in-process worker thread.
// Both expose the same JSONL stdio the RpcTransport speaks, so the rest of the
// stack is identical.
export interface PiProcessHandle {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  onError(cb: (err: Error) => void): void;
  onExit(cb: (code: number | null, signal: string | null) => void): void;
  stop(): Promise<void>;
}

export interface SubprocessOptions {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  useShell: boolean;
}

export function spawnSubprocessPi(opts: SubprocessOptions): PiProcessHandle {
  const child = spawn(opts.command, opts.args, {
    cwd: opts.cwd,
    shell: opts.useShell,
    windowsHide: true,
    env: opts.env,
    stdio: 'pipe',
  });
  return {
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    onError: (cb) => child.once('error', cb),
    onExit: (cb) => child.once('exit', (code, signal) => cb(code, signal)),
    stop: async () => {
      try {
        child.stdin.end();
      } catch {
        /* ignore */
      }
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
      try {
        await once(child, 'exit');
      } catch {
        /* ignore */
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export interface WorkerOptions {
  cliPath: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

// Runs Pi's cli.js IN-PROCESS on a worker thread with its own piped stdio.
// Worker threads can't set a cwd, and a global process.chdir() would move the VS
// Code host's cwd — so the bootstrap overrides the worker-LOCAL process.cwd()
// (each worker has its own process object) which Pi reads at startup. cli.js is
// ESM; we load it via dynamic import() from a small CommonJS eval bootstrap.
export function spawnWorkerPi(opts: WorkerOptions): PiProcessHandle {
  const bootstrap = `
    const { workerData } = require('node:worker_threads');
    // Worker-local cwd override (does NOT touch the host process cwd).
    process.cwd = () => workerData.cwd;
    process.argv = [process.argv[0], workerData.cliPath, ...workerData.args];
    process.title = 'pi';
    import(require('node:url').pathToFileURL(workerData.cliPath).href).catch((err) => {
      console.error('pi worker failed to load: ' + (err && err.stack ? err.stack : err));
      process.exit(1);
    });
  `;
  const worker = new Worker(bootstrap, {
    eval: true,
    workerData: { cliPath: opts.cliPath, args: opts.args, cwd: opts.cwd },
    env: opts.env,
    stdin: true,
    stdout: true,
    stderr: true,
  });
  const stdin = worker.stdin as Writable;
  return {
    stdin,
    stdout: worker.stdout,
    stderr: worker.stderr,
    onError: (cb) => worker.on('error', cb),
    // Worker 'exit' gives an exit code only (no signal).
    onExit: (cb) => worker.on('exit', (code) => cb(code, null)),
    stop: async () => {
      try {
        stdin.end();
      } catch {
        /* ignore */
      }
      await worker.terminate();
    },
  };
}
