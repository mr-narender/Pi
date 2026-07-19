import { EventEmitter } from 'node:events';
import type { Readable, Writable } from 'node:stream';
import { redactText } from '../diagnostics/redaction';
import { createDeferred, type Deferred } from '../utils/deferred';
import { JsonlDecoder, JsonlProtocolError } from './jsonlDecoder';
import {
  parseEnvelope,
  type ExtensionUiRequest,
  type RpcCommand,
  type RpcEvent,
  type RpcResponse,
} from './protocol';

export interface RpcTransportOptions {
  maxRecordBytes: number;
  maxBufferBytes: number;
  maxPendingRequests: number;
  maxQueuedWrites: number;
}

export interface RpcTransportEvents {
  event: [RpcEvent];
  extensionUi: [ExtensionUiRequest];
  responseFailure: [RpcResponse];
  protocolFault: [Error];
  stderr: [string];
  disconnected: [Error];
}

interface PendingRequest {
  command: string;
  deferred: Deferred<RpcResponse>;
}

class TypedEmitter extends EventEmitter {
  public override on<K extends keyof RpcTransportEvents>(
    eventName: K,
    listener: (...args: RpcTransportEvents[K]) => void
  ): this {
    return super.on(eventName, listener);
  }

  public override emit<K extends keyof RpcTransportEvents>(
    eventName: K,
    ...args: RpcTransportEvents[K]
  ): boolean {
    return super.emit(eventName, ...args);
  }
}

export class RpcTransport extends TypedEmitter {
  private readonly decoder: JsonlDecoder;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly ignoredResponseIds = new Set<string>();
  private readonly writeQueue: string[] = [];
  private disconnected = false;
  private flushing = false;

  public constructor(
    private readonly stdin: Writable,
    stdout: Readable,
    stderr: Readable | null,
    private readonly options: RpcTransportOptions
  ) {
    super();
    this.decoder = new JsonlDecoder({
      maxRecordBytes: options.maxRecordBytes,
      maxBufferBytes: options.maxRecordBytes * 2 + options.maxBufferBytes,
    });

    stdout.on('data', (chunk: Buffer | string) => {
      try {
        const bytes =
          typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : new Uint8Array(chunk);
        for (const line of this.decoder.push(bytes)) {
          this.handleLine(line);
        }
      } catch (error) {
        this.fault(error instanceof Error ? error : new Error(String(error)));
      }
    });
    stdout.on('end', () => {
      try {
        for (const line of this.decoder.end()) {
          this.handleLine(line);
        }
      } catch (error) {
        this.fault(error instanceof Error ? error : new Error(String(error)));
      }
    });
    stdout.on('error', (error) => this.fault(error));

    if (stderr) {
      stderr.on('data', (chunk: Buffer | string) => {
        const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        this.emit('stderr', redactText(text));
      });
    }

    this.stdin.on('error', (error) => this.disconnect(error));
    this.stdin.on('close', () => this.disconnect(new Error('stdin closed')));
  }

  public async request(command: RpcCommand): Promise<RpcResponse> {
    const id = typeof command.id === 'string' ? command.id : undefined;
    if (!id) {
      throw new Error('Correlated rpc request requires an id');
    }
    if (this.pending.size >= this.options.maxPendingRequests) {
      throw new Error('Too many pending rpc requests');
    }
    const deferred = createDeferred<RpcResponse>();
    this.pending.set(id, { command: String(command.type), deferred });
    try {
      await this.send(command);
    } catch (error) {
      this.pending.delete(id);
      throw error;
    }
    return deferred.promise;
  }

  public cancelPending(id: string, error: Error): boolean {
    const pending = this.pending.get(id);
    if (!pending) {
      return false;
    }
    this.pending.delete(id);
    this.ignoredResponseIds.add(id);
    pending.deferred.reject(error);
    return true;
  }

  public async notify(command: RpcCommand): Promise<void> {
    await this.send(command);
  }

  public disconnect(error: Error): void {
    if (this.disconnected) {
      return;
    }
    this.disconnected = true;
    for (const [id, pending] of this.pending.entries()) {
      this.pending.delete(id);
      pending.deferred.reject(error);
    }
    this.emit('disconnected', error);
  }

  private fault(error: Error): void {
    const wrapped =
      error instanceof JsonlProtocolError ? error : new JsonlProtocolError(error.message);
    this.emit('protocolFault', wrapped);
    this.disconnect(wrapped);
  }

  private async send(command: RpcCommand): Promise<void> {
    if (this.disconnected) {
      throw new Error('RPC transport disconnected');
    }
    if (this.writeQueue.length >= this.options.maxQueuedWrites) {
      throw new Error('Too many queued rpc writes');
    }
    this.writeQueue.push(`${JSON.stringify(command)}\n`);
    await this.flush();
  }

  private async flush(): Promise<void> {
    if (this.flushing || this.disconnected) {
      return;
    }
    this.flushing = true;
    try {
      while (this.writeQueue.length > 0 && !this.disconnected) {
        const next = this.writeQueue[0];
        const drained = this.stdin.write(next, 'utf8');
        this.writeQueue.shift();
        if (!drained) {
          await new Promise<void>((resolve, reject) => {
            const onDrain = (): void => {
              cleanup();
              resolve();
            };
            const onError = (error: Error): void => {
              cleanup();
              reject(error);
            };
            const cleanup = (): void => {
              this.stdin.off('drain', onDrain);
              this.stdin.off('error', onError);
            };
            this.stdin.once('drain', onDrain);
            this.stdin.once('error', onError);
          });
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  private handleLine(line: string): void {
    let raw: unknown;
    try {
      raw = JSON.parse(line) as unknown;
    } catch (error) {
      throw new JsonlProtocolError(`Invalid JSON: ${String(error)}`);
    }
    const envelope = parseEnvelope(raw);
    const compatibilityId =
      'compatibility' in envelope &&
      envelope.compatibility === true &&
      typeof envelope.id === 'string'
        ? envelope.id
        : undefined;
    if (
      compatibilityId &&
      (this.pending.has(compatibilityId) || this.ignoredResponseIds.has(compatibilityId))
    ) {
      throw new JsonlProtocolError(
        `Unexpected compatibility envelope for pending id: ${compatibilityId}`
      );
    }
    if ('success' in envelope && 'command' in envelope) {
      this.handleResponse(envelope as RpcResponse);
      return;
    }
    if (envelope.type === 'extension_ui_request' && 'method' in envelope) {
      this.emit('extensionUi', envelope as ExtensionUiRequest);
      return;
    }
    this.emit('event', envelope);
  }

  private handleResponse(response: RpcResponse): void {
    if (!response.success) {
      this.emit('responseFailure', response);
    }
    if (!response.id) {
      if (response.command === 'parse') {
        return;
      }
      throw new JsonlProtocolError(`Response for ${response.command} missing id`);
    }
    if (this.ignoredResponseIds.delete(response.id)) {
      return;
    }
    const pending = this.pending.get(response.id);
    if (!pending) {
      throw new JsonlProtocolError(`Orphan response id: ${response.id}`);
    }
    if (pending.command !== response.command) {
      throw new JsonlProtocolError(
        `Mismatched response command for ${response.id}: ${response.command}`
      );
    }
    this.pending.delete(response.id);
    pending.deferred.resolve(response);
  }
}

export function createRequestId(generation: number, counter: number): string {
  return `g${generation}-r${counter}`;
}

export function createUiId(generation: number, counter: number): string {
  return `g${generation}-ui${counter}`;
}
