import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { EventEmitter } from 'node:events';
import * as vscode from 'vscode';
import { DiagnosticsLogger } from '../diagnostics/logger';
import { getSettings, validateAdditionalArgs } from '../config/settings';
import type { PiRpcSettings } from '../config/settings';
import { RpcClient } from '../rpc/client';
import { RpcTransport } from '../rpc/transport';

export interface SupervisorEvents {
  exit: [number | null, NodeJS.Signals | null];
}

class TypedEmitter extends EventEmitter {
  public override on<K extends keyof SupervisorEvents>(
    eventName: K,
    listener: (...args: SupervisorEvents[K]) => void
  ): this {
    return super.on(eventName, listener);
  }

  public override emit<K extends keyof SupervisorEvents>(
    eventName: K,
    ...args: SupervisorEvents[K]
  ): boolean {
    return super.emit(eventName, ...args);
  }
}

export class PiProcessSupervisor extends TypedEmitter implements vscode.Disposable {
  private child: ChildProcessWithoutNullStreams | undefined;
  private transport: RpcTransport | undefined;
  private client: RpcClient | undefined;
  private generation = 0;

  public constructor(
    private readonly folder: vscode.WorkspaceFolder,
    private readonly logger: DiagnosticsLogger,
    private readonly settings: PiRpcSettings = getSettings()
  ) {
    super();
  }

  public get currentClient(): RpcClient | undefined {
    return this.client;
  }

  public get currentGeneration(): number {
    return this.generation;
  }

  public async start(existingSessionPath?: string): Promise<RpcClient> {
    if (this.client) {
      return this.client;
    }
    validateAdditionalArgs(this.settings.additionalArgs);
    await this.assertVersion();
    this.generation += 1;
    const args = this.buildArgs(existingSessionPath);
    this.logger.info(`Starting Pi for ${this.folder.name} generation=${this.generation}`);
    const child = spawn(this.settings.executable, args, {
      cwd: this.folder.uri.fsPath,
      shell: false,
      env: {
        ...process.env,
        PI_TELEMETRY: '0',
        PI_SKIP_VERSION_CHECK: '1',
        ...(this.settings.offline ? { PI_OFFLINE: '1' } : {}),
      },
      stdio: 'pipe',
    });
    this.child = child;
    const transport = new RpcTransport(child.stdin, child.stdout, child.stderr, {
      maxRecordBytes: this.settings.maxRecordBytes,
      maxBufferBytes: this.settings.maxRecordBytes,
      maxPendingRequests: this.settings.maxPendingRequests,
      maxQueuedWrites: this.settings.maxQueuedWrites,
    });
    transport.on('stderr', (text) => this.logger.warn(text));
    transport.on('protocolFault', (error) => this.logger.error(`Protocol fault: ${error.message}`));
    transport.on('disconnected', (error) =>
      this.logger.warn(`Transport disconnected: ${error.message}`)
    );
    child.once('exit', (code, signal) => {
      this.logger.warn(`Pi exited code=${String(code)} signal=${String(signal)}`);
      this.transport?.disconnect(
        new Error(`Pi exited code=${String(code)} signal=${String(signal)}`)
      );
      this.transport = undefined;
      this.client = undefined;
      this.child = undefined;
      this.emit('exit', code, signal);
    });
    this.transport = transport;
    this.client = new RpcClient(this.generation, transport, {
      shortTimeoutMs: this.settings.responseTimeoutMs,
      longTimeoutMs: this.settings.longRunningTimeoutMs,
    });
    return this.client;
  }

  public async stop(): Promise<void> {
    const child = this.child;
    this.transport = undefined;
    this.client = undefined;
    this.child = undefined;
    if (!child) {
      return;
    }
    child.stdin.end();
    child.kill('SIGTERM');
    const timeout = setTimeout(() => child.kill('SIGKILL'), 2000);
    try {
      await once(child, 'exit');
    } catch {
      // ignore
    } finally {
      clearTimeout(timeout);
    }
  }

  public dispose(): void {
    void this.stop();
  }

  private async assertVersion(): Promise<void> {
    const version = await new Promise<string>((resolve, reject) => {
      const child = spawn(this.settings.executable, ['--version'], {
        cwd: this.folder.uri.fsPath,
        shell: false,
        env: { ...process.env, PI_OFFLINE: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      child.once('error', reject);
      child.once('exit', (code) => {
        if (code === 0) {
          resolve(stdout.trim());
        } else {
          reject(new Error(stderr.trim() || `Failed to run ${this.settings.executable} --version`));
        }
      });
    });
    if (version !== '0.80.10') {
      throw new Error(`Unsupported Pi version ${version}; expected 0.80.10`);
    }
  }

  private buildArgs(existingSessionPath?: string): string[] {
    const args = ['--mode', 'rpc'];
    if (this.settings.offline) {
      args.push('--offline');
    }
    if (!vscode.workspace.isTrusted || !this.settings.allowApproveInTrustedWorkspace) {
      args.push('--no-approve');
    }
    if (existingSessionPath) {
      args.push('--session', existingSessionPath);
    }
    return [...args, ...this.settings.additionalArgs];
  }
}
