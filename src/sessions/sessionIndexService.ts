import { Worker } from 'node:worker_threads';
import * as path from 'node:path';
import { existsSync } from 'node:fs';
import type { DiagnosticsLogger } from '../diagnostics/logger';
import type {
  RecentSessionRecord,
  RecentSessionsIndex,
  SessionWorkspaceContext,
} from './recentSessions';
import type { JsonObject } from '../rpc/protocol';

export interface ContentMatch {
  path: string;
  name: string;
  preview: string;
  cwd: string;
  other: boolean;
  count: number;
}

interface Pending {
  op: unknown;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class SessionIndexTimeoutError extends Error {
  public constructor() {
    super('index worker timed out');
    this.name = 'SessionIndexTimeoutError';
  }
}

/**
 * Off-main-thread session indexing + full-text search. Runs ONE resident worker
 * (dist/sessionIndexWorker.js) with an mtime-validated blob cache, so sidebar
 * scans and content searches avoid parsing on the extension host. Unavailable
 * workers permit inline fallback; timeouts stop original work and are reported
 * without launching another expensive scan on the extension host.
 */
export class SessionIndexService {
  private worker: Worker | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();

  public constructor(
    private readonly extensionPath: string,
    private readonly logger: DiagnosticsLogger
  ) {}

  private scriptPath(): string {
    return path.join(this.extensionPath, 'dist', 'sessionIndexWorker.js');
  }

  public get available(): boolean {
    return existsSync(this.scriptPath());
  }

  private ensureWorker(): Worker | undefined {
    if (this.worker) {
      return this.worker;
    }
    if (!this.available) {
      return undefined;
    }
    try {
      const worker = new Worker(this.scriptPath());
      worker.on('message', (message: { id?: number; ok?: boolean; error?: string }) => {
        const id = message?.id;
        if (typeof id !== 'number') {
          return;
        }
        const entry = this.pending.get(id);
        if (!entry) {
          return;
        }
        this.pending.delete(id);
        clearTimeout(entry.timer);
        if (message.ok) {
          entry.resolve(message);
        } else {
          entry.reject(new Error(message.error ?? 'index worker failed'));
        }
      });
      worker.on('error', (error) => {
        this.logger.warn(`Session index worker error: ${error.message}`);
        if (this.worker === worker) this.failAll(error);
      });
      worker.on('exit', () => {
        if (this.worker === worker) this.failAll(new Error('index worker exited'));
      });
      worker.unref?.();
      this.worker = worker;
      return worker;
    } catch (error) {
      this.logger.warn(
        `Session index worker failed to start: ${error instanceof Error ? error.message : String(error)}`
      );
      return undefined;
    }
  }

  private failAll(error: Error): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
    this.worker = undefined;
  }

  private request<T>(payload: Record<string, unknown>, timeoutMs = 10_000): Promise<T> {
    const worker = this.ensureWorker();
    if (!worker) {
      return Promise.reject(new Error('index worker unavailable'));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const onTimeout = (): void => {
        // Stop the original work before callers handle failure; a timeout must
        // not leave a scan running beside its replacement on the extension host.
        const current = this.pending.get(id);
        if (this.worker !== worker || !current) return;
        // A short background scan must not cancel a longer-budget chat load.
        // Keep the same in-flight operation; its timeout resumes after history.
        if (
          payload.op !== 'readHistory' &&
          [...this.pending.values()].some((entry) => entry.op === 'readHistory')
        ) {
          current.timer = setTimeout(onTimeout, timeoutMs);
          return;
        }
        this.worker = undefined;
        const pending = [...this.pending.values()];
        this.pending.clear();
        for (const entry of pending) clearTimeout(entry.timer);
        const error = new SessionIndexTimeoutError();
        void worker
          .terminate()
          .catch(() => undefined)
          .then(() => {
            for (const entry of pending) entry.reject(error);
          });
      };
      const timer = setTimeout(onTimeout, timeoutMs);
      this.pending.set(id, {
        op: payload.op,
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      worker.postMessage({ id, ...payload });
    });
  }

  public async scanWorkspace(context: SessionWorkspaceContext): Promise<RecentSessionsIndex> {
    const response = await this.request<{ index: RecentSessionsIndex }>({
      op: 'scanWorkspace',
      context,
    });
    return response.index;
  }

  public async readHistory(
    sessionFile: string,
    activeLeafId?: string | null
  ): Promise<JsonObject[]> {
    const response = await this.request<{ messages: JsonObject[] }>(
      { op: 'readHistory', sessionFile, activeLeafId },
      60_000
    );
    return response.messages;
  }

  /** All-projects session scan, off-thread. Inline fallback excludes timeouts. */
  public async scanAll(excludeCwds: string[]): Promise<RecentSessionRecord[]> {
    const response = await this.request<{ records: RecentSessionRecord[] }>({
      op: 'scanAll',
      excludeCwds,
    });
    return response.records;
  }

  /** Full-text content search, off-thread. Throws on failure (caller falls back). */
  public async search(
    query: string,
    candidates: Array<{ path: string; name: string; cwd: string; other: boolean }>
  ): Promise<ContentMatch[]> {
    const response = await this.request<{ matches: ContentMatch[] }>({
      op: 'search',
      query,
      candidates,
    });
    return response.matches;
  }

  public dispose(): void {
    const worker = this.worker;
    this.worker = undefined;
    this.failAll(new Error('disposed'));
    void worker?.terminate();
  }
}
