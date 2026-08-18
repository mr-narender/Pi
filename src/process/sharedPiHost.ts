import { Worker } from 'node:worker_threads';
import { PassThrough, Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import type { Readable } from 'node:stream';
import { DiagnosticsLogger } from '../diagnostics/logger';
import type { PiProcessHandle } from './piProcess';

// One channel = one open chat session multiplexed over the shared host's stdio.
interface HostChannel {
  stdout: PassThrough; // host -> session (JSONL, exactly what RpcTransport expects)
  onExit?: (code: number | null, signal: string | null) => void;
  onOpen?: (ok: boolean, error?: string) => void;
  opened: boolean;
}

/**
 * SharedPiHost runs ONE worker (host/pi-multi-host.mjs) that hosts MANY Pi
 * `AgentSession`s on a SINGLE shared `ModelRuntime`. Each open chat gets a
 * virtual stdio pair wired to that worker via `{k, d}` envelopes, so the rest of
 * the stack (RpcTransport/RpcClient/reducer) is unchanged — it just talks to a
 * PiProcessHandle whose streams happen to be multiplexed. This replaces the old
 * one-OS-process-per-chat model: N chats now cost ~1 runtime instead of N.
 */
export class SharedPiHost {
  private worker: Worker | undefined;
  private buffer = '';
  private readonly channels = new Map<string, HostChannel>();
  private startFault: Error | undefined;

  public constructor(
    private readonly hostScript: string,
    private readonly baseEnv: NodeJS.ProcessEnv,
    private readonly logger: DiagnosticsLogger
  ) {}

  /** Absolute path to the shipped host script (host/pi-multi-host.mjs). */
  public static scriptPath(extensionPath: string): string {
    return path.join(extensionPath, 'host', 'pi-multi-host.mjs');
  }

  private ensureWorker(): void {
    if (this.worker) {
      return;
    }
    this.startFault = undefined;
    // CJS bootstrap that dynamic-imports the ESM host (same trick as spawnWorkerPi).
    const bootstrap = `
      const { workerData } = require('node:worker_threads');
      import(require('node:url').pathToFileURL(workerData.hostPath).href).catch((err) => {
        console.error('pi shared host failed to load: ' + (err && err.stack ? err.stack : err));
        process.exit(1);
      });
    `;
    const worker = new Worker(bootstrap, {
      eval: true,
      workerData: { hostPath: this.hostScript },
      env: { ...this.baseEnv, PI_TELEMETRY: '0', PI_SKIP_VERSION_CHECK: '1' },
      stdin: true,
      stdout: true,
      stderr: true,
    });
    worker.on('error', (error) => {
      this.logger.error('Shared Pi host worker error', error);
      this.failAll(error);
    });
    worker.on('exit', (code) => {
      this.logger.warn(`Shared Pi host worker exited code=${String(code)}`);
      this.failAll(new Error(`Shared Pi host exited code=${String(code)}`), code);
    });
    (worker.stderr as Readable).on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trimEnd();
      if (text) {
        this.logger.warn(`[pi-host] ${text}`);
      }
    });
    (worker.stdout as Readable).on('data', (chunk: Buffer) => this.onHostStdout(chunk));
    this.worker = worker;
  }

  private onHostStdout(chunk: Buffer): void {
    this.buffer += chunk.toString('utf8');
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      newline = this.buffer.indexOf('\n');
      if (line.trim()) {
        this.routeLine(line);
      }
    }
  }

  private routeLine(line: string): void {
    let env: { k?: string; d?: Record<string, unknown> };
    try {
      env = JSON.parse(line) as { k?: string; d?: Record<string, unknown> };
    } catch {
      return;
    }
    const key = env.k;
    const payload = env.d;
    if (!key || !payload) {
      return;
    }
    const channel = this.channels.get(key);
    if (!channel) {
      return;
    }
    // The host's open/close acks are for US, not the RpcClient — intercept them.
    if (payload.command === 'open' && payload.type === 'response') {
      channel.opened = payload.success === true;
      channel.onOpen?.(payload.success === true, payload.error as string | undefined);
      channel.onOpen = undefined;
      return;
    }
    if (payload.type === 'session_closed') {
      channel.onExit?.(0, null);
      return;
    }
    // Everything else is normal Pi protocol (responses w/ id + events): hand it
    // to this session's virtual stdout as one JSONL record.
    channel.stdout.push(`${JSON.stringify(payload)}\n`);
  }

  private writeEnvelope(key: string, payload: Record<string, unknown>): void {
    const worker = this.worker;
    if (!worker) {
      return;
    }
    (worker.stdin as Writable).write(`${JSON.stringify({ k: key, d: payload })}\n`);
  }

  private failAll(error: Error, code: number | null = null): void {
    for (const channel of this.channels.values()) {
      channel.onOpen?.(false, error.message);
      channel.onOpen = undefined;
      channel.onExit?.(code, null);
      channel.stdout.push(null);
    }
    this.channels.clear();
    this.worker = undefined;
    this.buffer = '';
    this.startFault = error;
  }

  /**
   * Open a new multiplexed session and return a PiProcessHandle whose virtual
   * streams the supervisor wires into RpcTransport exactly like a real process.
   * Resolves only once the host has created the AgentSession (so no command
   * races an unopened session).
   */
  public async openSession(
    info: { cwd: string; sessionFile?: string },
    openTimeoutMs = 20_000
  ): Promise<PiProcessHandle> {
    this.ensureWorker();
    if (this.startFault) {
      throw this.startFault;
    }
    const key = randomUUID();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const channel: HostChannel = { stdout, opened: false };
    this.channels.set(key, channel);

    // Virtual stdin: unwrap each JSONL command the transport writes, tag with the
    // session key, forward to the shared worker.
    const stdin = new Writable({
      write: (chunk: Buffer | string, _enc, cb) => {
        const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        for (const raw of text.split('\n')) {
          const trimmed = raw.trim();
          if (!trimmed) {
            continue;
          }
          try {
            this.writeEnvelope(key, JSON.parse(trimmed) as Record<string, unknown>);
          } catch {
            /* skip malformed line */
          }
        }
        cb();
      },
    });

    const opened = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Timed out opening shared Pi session'));
      }, openTimeoutMs);
      channel.onOpen = (ok, error) => {
        clearTimeout(timer);
        if (ok) {
          resolve();
        } else {
          reject(new Error(error ?? 'Shared Pi host failed to open session'));
        }
      };
    });

    this.writeEnvelope(key, {
      type: 'open',
      cwd: info.cwd,
      sessionFile: info.sessionFile,
    });

    try {
      await opened;
    } catch (error) {
      this.channels.delete(key);
      stdout.push(null);
      throw error;
    }

    const handle: PiProcessHandle = {
      stdin,
      stdout,
      stderr,
      onError: () => {
        /* worker-level errors surface via onExit */
      },
      onExit: (cb) => {
        channel.onExit = cb;
      },
      stop: async () => {
        this.writeEnvelope(key, { type: 'close' });
        this.channels.delete(key);
        stdout.push(null);
      },
    };
    return handle;
  }

  public dispose(): void {
    const worker = this.worker;
    this.worker = undefined;
    for (const channel of this.channels.values()) {
      channel.stdout.push(null);
    }
    this.channels.clear();
    void worker?.terminate();
  }
}

// Module singleton: one host per extension host process.
let singleton: SharedPiHost | undefined;

export function initSharedPiHost(
  extensionPath: string,
  env: NodeJS.ProcessEnv,
  logger: DiagnosticsLogger
): SharedPiHost {
  singleton?.dispose();
  singleton = new SharedPiHost(SharedPiHost.scriptPath(extensionPath), env, logger);
  return singleton;
}

export function getSharedPiHost(): SharedPiHost | undefined {
  return singleton;
}

export function disposeSharedPiHost(): void {
  singleton?.dispose();
  singleton = undefined;
}
