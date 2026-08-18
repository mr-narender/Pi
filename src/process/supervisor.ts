import { spawn } from 'node:child_process';
import { resolvePiLaunch } from './piLauncher';
import { spawnSubprocessPi, spawnWorkerPi, type PiProcessHandle } from './piProcess';
import { getSharedPiHost } from './sharedPiHost';

// On Windows the npm-installed `pi` is a `pi.cmd` shim, which Node's spawn cannot
// execute directly (ENOENT / EINVAL). A shell is required there; on POSIX we keep
// shell:false so arguments are passed verbatim without shell interpretation.
const SPAWN_WITH_SHELL = process.platform === 'win32';
import { EventEmitter } from 'node:events';
import * as vscode from 'vscode';
import { DiagnosticsLogger } from '../diagnostics/logger';
import { getSettings, validateAdditionalArgs } from '../config/settings';
import type { PiRpcSettings } from '../config/settings';
import { RpcClient } from '../rpc/client';
import { RpcTransport } from '../rpc/transport';
import { checkPiVersion } from './version';

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
  private piProcess: PiProcessHandle | undefined;
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

  public async start(
    existingSessionPath?: string,
    options?: { noExtensions?: boolean; offline?: boolean }
  ): Promise<RpcClient> {
    if (this.client) {
      return this.client;
    }
    validateAdditionalArgs(this.settings.additionalArgs);
    // Shared-runtime fast path: one host worker hosts THIS session (and every
    // other open chat) on a single ModelRuntime — no version probe (vendored Pi)
    // and no CLI args. Falls back to a per-chat process if the host can't open.
    const sharedHost = this.settings.sharedRuntime ? getSharedPiHost() : undefined;
    if (sharedHost) {
      try {
        this.generation += 1;
        const handle = await sharedHost.openSession({
          cwd: this.folder.uri.fsPath,
          sessionFile: existingSessionPath,
        });
        this.logger.info(
          `Starting Pi for ${this.folder.name} (generation=${this.generation}) via shared host ` +
            `[cwd=${this.folder.uri.fsPath}, session=${existingSessionPath ?? '(new)'}]`
        );
        return this.attachClient(handle, 'shared host');
      } catch (error) {
        this.logger.warn(
          `Shared Pi host unavailable (${error instanceof Error ? error.message : String(error)}); ` +
            `falling back to a per-chat process`
        );
      }
    }
    await this.assertVersion();
    this.generation += 1;
    const offline = options?.offline ?? this.settings.offline;
    const args = this.buildArgs(existingSessionPath, {
      noExtensions: options?.noExtensions,
      offline,
    });
    const launch = resolvePiLaunch(this.settings);
    const useShell = launch.usingBundled ? false : SPAWN_WITH_SHELL;
    // Pi's shell-inheritance extension needs a known launch shell. When Pi is
    // spawned non-interactively (here) it can't determine one on Windows and
    // exits code=1 unless PI_LAUNCH_SHELL is set. Honor the setting, then an
    // existing env value, else a sane per-platform default.
    const launchShell =
      this.settings.launchShell.trim() ||
      process.env.PI_LAUNCH_SHELL ||
      (process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : process.env.SHELL || '');
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...launch.extraEnv,
      PI_TELEMETRY: '0',
      PI_SKIP_VERSION_CHECK: '1',
      ...(offline ? { PI_OFFLINE: '1' } : {}),
      ...(launchShell ? { PI_LAUNCH_SHELL: launchShell } : {}),
    };
    const cwd = this.folder.uri.fsPath;
    this.logger.info(
      `Starting Pi for ${this.folder.name} (generation=${this.generation}) via ${launch.label} ` +
        `[mode=${launch.mode}, args=${args.join(' ')}, cwd=${cwd}]`
    );
    const piProcess =
      launch.mode === 'worker' && launch.cliPath
        ? spawnWorkerPi({ cliPath: launch.cliPath, args, cwd, env })
        : spawnSubprocessPi({
            command: launch.command,
            args: [...launch.prefixArgs, ...args],
            cwd,
            env,
            useShell,
          });
    return this.attachClient(piProcess, launch.label);
  }

  // Wire a spawned process OR a shared-host session handle into transport+client.
  // Both paths are identical from here down — the handle just exposes stdio.
  private attachClient(piProcess: PiProcessHandle, label: string): RpcClient {
    this.piProcess = piProcess;
    piProcess.onError((error) => {
      this.logger.error(`Failed to launch Pi via ${label}. ${this.spawnHint(error)}`, error);
      this.transport?.disconnect(error instanceof Error ? error : new Error(String(error)));
    });
    const transport = new RpcTransport(piProcess.stdin, piProcess.stdout, piProcess.stderr, {
      maxRecordBytes: this.settings.maxRecordBytes,
      // The residual buffer only ever holds one partial record, so it needs at
      // least maxRecordBytes; give generous headroom so resuming a large session
      // (a big stdout replay burst) never trips the limit.
      maxBufferBytes: Math.max(this.settings.maxRecordBytes * 2, 16 * 1024 * 1024),
      maxPendingRequests: this.settings.maxPendingRequests,
      maxQueuedWrites: this.settings.maxQueuedWrites,
    });
    transport.on('stderr', (text) => this.logger.warn(text));
    transport.on('protocolFault', (error) => this.logger.error(`Protocol fault: ${error.message}`));
    transport.on('disconnected', (error) =>
      this.logger.warn(`Transport disconnected: ${error.message}`)
    );
    piProcess.onExit((code, signal) => {
      this.logger.warn(`Pi exited code=${String(code)} signal=${String(signal)}`);
      this.transport?.disconnect(
        new Error(`Pi exited code=${String(code)} signal=${String(signal)}`)
      );
      this.transport = undefined;
      this.client = undefined;
      this.piProcess = undefined;
      this.emit('exit', code, signal as NodeJS.Signals | null);
    });
    this.transport = transport;
    this.client = new RpcClient(this.generation, transport, {
      shortTimeoutMs: this.settings.responseTimeoutMs,
      longTimeoutMs: this.settings.longRunningTimeoutMs,
    });
    return this.client;
  }

  public async stop(): Promise<void> {
    const piProcess = this.piProcess;
    this.transport = undefined;
    this.client = undefined;
    this.piProcess = undefined;
    if (!piProcess) {
      return;
    }
    await piProcess.stop();
  }

  public dispose(): void {
    void this.stop();
  }

  /** Human-readable remediation for a spawn failure. */
  private spawnHint(error: unknown): string {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT') {
      return (
        `Pi CLI was not found. Install it with 'npm install -g @earendil-works/pi-coding-agent', ` +
        `or set the 'Pi: Executable Path' setting to the full path of the pi binary.`
      );
    }
    if (code === 'EACCES') {
      return `Pi CLI is not executable (permission denied). Check the 'Pi: Executable Path' setting.`;
    }
    return `See the Pi output channel for details.`;
  }

  private probeVersion(): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const launch = resolvePiLaunch(this.settings);
      const child = spawn(launch.command, [...launch.prefixArgs, '--version'], {
        cwd: this.folder.uri.fsPath,
        shell: launch.usingBundled ? false : SPAWN_WITH_SHELL,
        windowsHide: true,
        env: { ...process.env, ...launch.extraEnv, PI_OFFLINE: '1' },
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
      // A spawn error (ENOENT/EACCES) means the binary isn't runnable at all
      // — that IS fatal; surface it with remediation.
      child.once('error', reject);
      child.once('exit', (code) => resolve({ code, stdout, stderr }));
    });
  }

  private async assertVersion(): Promise<void> {
    // The version probe is a COURTESY check, not a hard gate. It must not block
    // startup just because `pi --version` behaves unusually (e.g. writes to
    // stderr, exits non-zero, or is wrapped by a .cmd shim on Windows). Only two
    // things should stop us: the binary genuinely not existing, or a version we
    // can parse that is clearly older than the minimum.
    let probe: { code: number | null; stdout: string; stderr: string };
    try {
      probe = await this.probeVersion();
    } catch (error) {
      throw new Error(
        `Could not run '${this.settings.executable} --version'. ${this.spawnHint(error)}`
      );
    }

    const output = `${probe.stdout}\n${probe.stderr}`.trim();
    if (probe.code !== 0) {
      this.logger.warn(
        `'${this.settings.executable} --version' exited with code ${String(probe.code)}; ` +
          `proceeding anyway. Output: ${output || '(none)'}`
      );
      return;
    }
    const check = checkPiVersion(output);
    if (!check.ok) {
      throw new Error(check.reason);
    }
    if (check.note) {
      this.logger.warn(check.note);
    } else {
      this.logger.info(`Pi version detected: ${check.version ?? 'unknown'}`);
    }
  }

  private buildArgs(
    existingSessionPath?: string,
    options?: { noExtensions?: boolean; offline?: boolean }
  ): string[] {
    const args = ['--mode', 'rpc'];
    if (options?.offline ?? this.settings.offline) {
      args.push('--offline');
    }
    if (!vscode.workspace.isTrusted || !this.settings.allowApproveInTrustedWorkspace) {
      args.push('--no-approve');
    }
    if (options?.noExtensions) {
      // Recovery path: a crashing Pi extension can make session load exit code=1.
      args.push('--no-extensions');
    }
    if (existingSessionPath) {
      args.push('--session', existingSessionPath);
    }
    return [...args, ...this.settings.additionalArgs];
  }
}
