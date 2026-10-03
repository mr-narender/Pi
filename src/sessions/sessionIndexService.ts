import { Worker } from 'node:worker_threads';
import * as path from 'node:path';
import { existsSync } from 'node:fs';
import type { DiagnosticsLogger } from '../diagnostics/logger';
import type { RecentSessionRecord } from './recentSessions';

export interface ContentMatch {
  path: string;
  name: string;
  preview: string;
  cwd: string;
  other: boolean;
  count: number;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Off-main-thread session indexing + full-text search. Runs ONE resident worker
 * (dist/sessionIndexWorker.js) with an mtime-validated blob cache, so sidebar
 * scans and content searches never block the extension host. Callers must treat
 * failures as "use the inline fallback" — this service is an accelerator, never
 * a single point of failure.
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
        this.failAll(error);
      });
      worker.on('exit', () => {
        this.failAll(new Error('index worker exited'));
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
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('index worker timed out'));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      worker.postMessage({ id, ...payload });
    });
  }

  /** All-projects session scan, off-thread. Throws on failure (caller falls back). */
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
