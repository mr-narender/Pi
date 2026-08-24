import { Worker } from 'node:worker_threads';
import { PassThrough, Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { cpus } from 'node:os';
import type { Readable } from 'node:stream';
import type { DiagnosticsLogger } from '../diagnostics/logger';
import type { PiProcessHandle } from './piProcess';

// One channel = one open chat session multiplexed over its worker's stdio.
interface HostChannel {
  stdout: PassThrough; // host -> session (JSONL, exactly what RpcTransport expects)
  onExit?: (code: number | null, signal: string | null) => void;
  onOpen?: (ok: boolean, error?: string) => void;
  opened: boolean;
}

interface LoggerLike {
  info(message: string): void;
  warn(message: string): void;
  error(message: string, error?: unknown): void;
}

/**
 * One pool member: a worker thread running host/pi-multi-host.mjs with its own
 * ModelRuntime, hosting the sessions ASSIGNED to it (sticky). A crash faults
 * only this member's sessions — the pool spawns a replacement on the next open.
 */
class HostWorkerConn {
  private worker: Worker | undefined;
  private buffer = '';
  public readonly channels = new Map<string, HostChannel>();
  public fault: Error | undefined;
  /** True once the worker has ANSWERED its first open — i.e. Pi's module graph
   * is imported and the runtime is live. Cold boots are expensive (seconds);
   * the pool must never boot a second worker while one is still cold. */
  public warm = false;
  private startedAt = 0;
  private pingSeq = 0;
  private readonly pendingPings = new Map<string, () => void>();

  public constructor(
    public readonly id: number,
    private readonly hostScript: string,
    private readonly baseEnv: NodeJS.ProcessEnv,
    private readonly piRoot: string,
    private readonly logger: LoggerLike,
    private readonly onDead: (conn: HostWorkerConn) => void
  ) {}

  public get sessionCount(): number {
    return this.channels.size;
  }

  public start(): void {
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
      workerData: { hostPath: this.hostScript, piRoot: this.piRoot },
      env: { ...this.baseEnv, PI_TELEMETRY: '0', PI_SKIP_VERSION_CHECK: '1' },
      stdin: true,
      stdout: true,
      stderr: true,
    });
    worker.on('error', (error) => {
      this.logger.error(`Pi runtime worker #${this.id} error`, error);
      this.failAll(error instanceof Error ? error : new Error(String(error)));
    });
    worker.on('exit', (code) => {
      if (!this.fault) {
        this.logger.warn(`Pi runtime worker #${this.id} exited code=${String(code)}`);
        this.failAll(new Error(`Pi runtime worker exited code=${String(code)}`), code);
      }
    });
    (worker.stderr as Readable).on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trimEnd();
      if (text) {
        this.logger.warn(`[pi-host#${this.id}] ${text}`);
      }
    });
    (worker.stdout as Readable).on('data', (chunk: Buffer) => this.onStdout(chunk));
    this.worker = worker;
    this.startedAt = Date.now();
  }

  private onStdout(chunk: Buffer): void {
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
    // Ping acks use throwaway keys (no channel) — intercept before the lookup.
    if (payload.command === 'ping' && payload.type === 'response') {
      this.markWarm();
      const resolve = this.pendingPings.get(key);
      if (resolve) {
        this.pendingPings.delete(key);
        resolve();
      }
      return;
    }
    const channel = this.channels.get(key);
    if (!channel) {
      return;
    }
    // The host's open/close acks are for US, not the RpcClient — intercept them.
    if (payload.command === 'open' && payload.type === 'response') {
      if (payload.success === true) {
        this.markWarm();
      }
      channel.opened = payload.success === true;
      channel.onOpen?.(payload.success === true, payload.error as string | undefined);
      channel.onOpen = undefined;
      return;
    }
    if (payload.type === 'session_closed') {
      channel.onExit?.(0, null);
      return;
    }
    channel.stdout.push(`${JSON.stringify(payload)}\n`);
  }

  private markWarm(): void {
    if (!this.warm) {
      this.warm = true;
      this.logger.info(
        `Pi runtime worker #${this.id} warm in ${((Date.now() - this.startedAt) / 1000).toFixed(1)}s`
      );
    }
  }

  /** Resolves once the worker answers — i.e. Pi's module graph is imported. */
  public ping(timeoutMs = 90_000): Promise<void> {
    const key = `__ping_${++this.pingSeq}`;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingPings.delete(key);
        reject(new Error(`worker #${this.id} ping timed out`));
      }, timeoutMs);
      this.pendingPings.set(key, () => {
        clearTimeout(timer);
        resolve();
      });
      this.writeEnvelope(key, { type: 'ping' });
    });
  }

  public writeEnvelope(key: string, payload: Record<string, unknown>): void {
    const worker = this.worker;
    if (!worker) {
      return;
    }
    (worker.stdin as Writable).write(`${JSON.stringify({ k: key, d: payload })}\n`);
  }

  private failAll(error: Error, code: number | null = null): void {
    this.fault = error;
    for (const channel of this.channels.values()) {
      channel.onOpen?.(false, error.message);
      channel.onOpen = undefined;
      channel.onExit?.(code, null);
      channel.stdout.push(null);
    }
    this.channels.clear();
    this.worker = undefined;
    this.buffer = '';
    this.onDead(this);
  }

  public terminate(): void {
    const worker = this.worker;
    this.worker = undefined;
    this.fault = this.fault ?? new Error('terminated');
    for (const channel of this.channels.values()) {
      channel.stdout.push(null);
    }
    this.channels.clear();
    void worker?.terminate();
    this.onDead(this);
  }
}

/**
 * SharedPiHost runs a CPU-sized POOL of runtime workers (host/pi-multi-host.mjs
 * each, with their own ModelRuntime). Sessions are assigned sticky to the
 * least-loaded worker, so several busy chats execute on different cores instead
 * of contending on one thread. The per-session protocol and PiProcessHandle
 * contract are identical to the single-worker design.
 */
export class SharedPiHost {
  private readonly conns: HostWorkerConn[] = [];
  private nextConnId = 1;
  private piRootPromise: Promise<string> | undefined;
  private readonly maxWorkers: number;
  // Prewarmed draft sessions parked per cwd: "New Chat" adopts one instantly.
  private readonly parked = new Map<string, { handle: PiProcessHandle; conn: HostWorkerConn }>();
  private prewarmTimer: ReturnType<typeof setTimeout> | undefined;

  public constructor(
    private readonly hostScript: string,
    private readonly baseEnv: NodeJS.ProcessEnv,
    private readonly logger: LoggerLike,
    // Where the Pi package lives (PATH install / managed / vendor). Async: on a
    // fresh client the FIRST chat awaits the managed bootstrap.
    private readonly resolvePiRoot: () => Promise<string>,
    maxWorkers?: number
  ) {
    this.maxWorkers = Math.min(8, Math.max(1, maxWorkers ?? SharedPiHost.autoWorkerCount()));
  }

  /** Conservative CPU sizing: floor(cores/4) clamped to 1..4 (14 cores -> 3). */
  public static autoWorkerCount(): number {
    return Math.min(4, Math.max(1, Math.floor(cpus().length / 4)));
  }

  /** Absolute path to the shipped host script (host/pi-multi-host.mjs). */
  public static scriptPath(extensionPath: string): string {
    return path.join(extensionPath, 'host', 'pi-multi-host.mjs');
  }

  /** Live pool snapshot (for health/logs). */
  public poolStatus(): Array<{ id: number; sessions: number }> {
    return this.conns.map((conn) => ({ id: conn.id, sessions: conn.sessionCount }));
  }

  private async pickConn(): Promise<HostWorkerConn> {
    this.piRootPromise ??= this.resolvePiRoot().catch((error: unknown) => {
      this.piRootPromise = undefined;
      throw error;
    });
    const piRoot = await this.piRootPromise;
    const live = this.conns.filter((conn) => !conn.fault);
    // NEVER boot a second worker while one is still cold: parallel cold boots
    // contend on CPU (both importing Pi's whole module graph) and can push past
    // the open timeout — exactly the activation stampede that made 0.0.200 feel
    // slow. Pile onto the booting worker; its queued opens are fast once warm.
    const cold = live
      .filter((conn) => !conn.warm)
      .sort((a, b) => a.sessionCount - b.sessionCount)[0];
    if (cold) {
      return cold;
    }
    const empty = live.find((conn) => conn.sessionCount === 0);
    if (empty) {
      return empty;
    }
    const least = [...live].sort((a, b) => a.sessionCount - b.sessionCount)[0];
    if (least && live.length >= this.maxWorkers) {
      return least;
    }
    return this.spawnConn(piRoot);
  }

  private spawnConn(piRoot: string): HostWorkerConn {
    const conn = new HostWorkerConn(
      this.nextConnId++,
      this.hostScript,
      this.baseEnv,
      piRoot,
      this.logger,
      (dead) => {
        const index = this.conns.indexOf(dead);
        if (index >= 0) {
          this.conns.splice(index, 1);
        }
        for (const [cwd, parked] of this.parked) {
          if (parked.conn === dead) {
            this.parked.delete(cwd);
          }
        }
      }
    );
    conn.start();
    this.conns.push(conn);
    this.logger.info(
      `Pi runtime worker #${conn.id} started (pool ${this.conns.length}/${this.maxWorkers})`
    );
    return conn;
  }

  private warmingPool = false;

  /**
   * Boot the WHOLE pool at startup — serially (parallel cold boots contend on
   * CPU), each worker confirmed warm via ping before the next starts. Ends by
   * parking the prewarmed draft session, so the first New Chat AND the first
   * parallel burst are both instant. Safe to call once per activation; user
   * opens arriving mid-warmup simply ride the currently-booting worker.
   */
  public warmPool(prewarmCwd?: string): void {
    if (this.warmingPool) {
      return;
    }
    this.warmingPool = true;
    void (async () => {
      try {
        this.piRootPromise ??= this.resolvePiRoot().catch((error: unknown) => {
          this.piRootPromise = undefined;
          throw error;
        });
        const piRoot = await this.piRootPromise;
        for (;;) {
          const live = this.conns.filter((conn) => !conn.fault);
          const cold = live.find((conn) => !conn.warm);
          if (cold) {
            await cold.ping();
            continue;
          }
          if (live.length >= this.maxWorkers) {
            break;
          }
          await this.spawnConn(piRoot).ping();
        }
        this.logger.info(`Pi runtime pool warm (${this.maxWorkers} workers ready)`);
        if (prewarmCwd) {
          this.schedulePrewarm(prewarmCwd, 500);
        }
      } catch (error) {
        this.logger.warn(
          `Pool warmup stopped: ${error instanceof Error ? error.message : String(error)}`
        );
      } finally {
        this.warmingPool = false;
      }
    })();
  }

  /** Park a ready draft session for this cwd so the next New Chat is instant. */
  public schedulePrewarm(cwd: string, delayMs = 3000): void {
    if (this.prewarmTimer || this.parked.has(cwd)) {
      return;
    }
    this.prewarmTimer = setTimeout(() => {
      this.prewarmTimer = undefined;
      void this.prewarm(cwd);
    }, delayMs);
    this.prewarmTimer.unref?.();
  }

  private async prewarm(cwd: string): Promise<void> {
    if (this.parked.has(cwd)) {
      return;
    }
    try {
      const opened = await this.openSessionRaw({ cwd });
      if (this.parked.has(cwd)) {
        await opened.handle.stop();
        return;
      }
      this.parked.set(cwd, opened);
      this.logger.info(`Prewarmed a draft Pi session for ${cwd} (worker #${opened.conn.id})`);
    } catch (error) {
      this.logger.warn(
        `Prewarm failed for ${cwd}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Open a new multiplexed session and return a PiProcessHandle whose virtual
   * streams the supervisor wires into RpcTransport exactly like a real process.
   * Resolves only once the host has created the AgentSession.
   */
  public async openSession(
    info: { cwd: string; sessionFile?: string },
    openTimeoutMs = 20_000
  ): Promise<PiProcessHandle> {
    if (!info.sessionFile) {
      const parked = this.parked.get(info.cwd);
      if (parked && !parked.conn.fault) {
        this.parked.delete(info.cwd);
        this.schedulePrewarm(info.cwd);
        this.logger.info(`Adopted prewarmed Pi session for ${info.cwd}`);
        return parked.handle;
      }
    }
    return (await this.openSessionRaw(info, openTimeoutMs)).handle;
  }

  private async openSessionRaw(
    info: { cwd: string; sessionFile?: string },
    openTimeoutMs = 20_000
  ): Promise<{ handle: PiProcessHandle; conn: HostWorkerConn }> {
    const conn = await this.pickConn();
    if (conn.fault) {
      throw conn.fault;
    }
    // A COLD worker is importing Pi's module graph — give its first opens real
    // headroom instead of tripping into the (much slower) per-chat fallback.
    const effectiveTimeoutMs = conn.warm ? openTimeoutMs : Math.max(openTimeoutMs, 60_000);
    const key = randomUUID();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const channel: HostChannel = { stdout, opened: false };
    conn.channels.set(key, channel);

    const stdin = new Writable({
      write: (chunk: Buffer | string, _enc, cb) => {
        const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        for (const raw of text.split('\n')) {
          const trimmed = raw.trim();
          if (!trimmed) {
            continue;
          }
          try {
            conn.writeEnvelope(key, JSON.parse(trimmed) as Record<string, unknown>);
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
      }, effectiveTimeoutMs);
      channel.onOpen = (ok, error) => {
        clearTimeout(timer);
        if (ok) {
          resolve();
        } else {
          reject(new Error(error ?? 'Shared Pi host failed to open session'));
        }
      };
    });

    conn.writeEnvelope(key, {
      type: 'open',
      cwd: info.cwd,
      sessionFile: info.sessionFile,
    });

    try {
      await opened;
    } catch (error) {
      conn.channels.delete(key);
      // The worker may still complete this open later — tell it to tear the
      // orphan session down instead of leaking it.
      conn.writeEnvelope(key, { type: 'close' });
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
        conn.writeEnvelope(key, { type: 'close' });
        conn.channels.delete(key);
        stdout.push(null);
      },
    };
    return { handle, conn };
  }

  public dispose(): void {
    if (this.prewarmTimer) {
      clearTimeout(this.prewarmTimer);
      this.prewarmTimer = undefined;
    }
    this.parked.clear();
    for (const conn of [...this.conns]) {
      conn.terminate();
    }
    this.conns.length = 0;
  }
}

// Module singleton: one pool per extension host process.
let singleton: SharedPiHost | undefined;

export function initSharedPiHost(
  extensionPath: string,
  env: NodeJS.ProcessEnv,
  logger: DiagnosticsLogger,
  resolvePiRoot: () => Promise<string>,
  maxWorkers?: number
): SharedPiHost {
  singleton?.dispose();
  singleton = new SharedPiHost(
    SharedPiHost.scriptPath(extensionPath),
    env,
    logger,
    resolvePiRoot,
    maxWorkers
  );
  return singleton;
}

export function getSharedPiHost(): SharedPiHost | undefined {
  return singleton;
}

export function disposeSharedPiHost(): void {
  singleton?.dispose();
  singleton = undefined;
}
