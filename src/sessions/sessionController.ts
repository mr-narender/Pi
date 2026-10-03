import * as vscode from 'vscode';
import { assertNotCoreSlashPrompt } from '../commands/coreSlash';
import {
  waitForModelOperations,
  cancelModelOperations,
  hasModelOperation,
} from '../commands/modelOperations';
import { mergeLocalCommands } from '../commands/localCommand';
import { projectSessionInfo } from './sessionInfo';
import { getSettings } from '../config/settings';
import type { PiRpcSettings } from '../config/settings';
import { DiagnosticsLogger } from '../diagnostics/logger';
import { redactJsonValue } from '../diagnostics/redaction';
import { PiProcessSupervisor } from '../process/supervisor';
import {
  isKnownEventType,
  type ExtensionUiRequest,
  type JsonObject,
  type RpcEvent,
  type SessionState,
} from '../rpc/protocol';
import {
  mergeSessionState,
  reduceEvent,
  reduceExtensionUiRequest,
  resetControllerProjection,
} from '../state/reducer';
import { createInitialControllerState, type ControllerState } from '../state/types';
import {
  createReadStream,
  watch as fsWatch,
  watchFile,
  unwatchFile,
  type FSWatcher,
} from 'node:fs';
import { createInterface } from 'node:readline';
import { stat } from 'node:fs/promises';
import { canonicalizeSessionPath } from './paths';
import { selectActiveBranchMessages, type SessionRecord } from './activeBranch';

export class SessionController implements vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<ControllerState>();
  private readonly extensionUiEmitter = new vscode.EventEmitter<ExtensionUiRequest>();
  private readonly supervisor: PiProcessSupervisor;
  private readonly settings: PiRpcSettings;
  private state: ControllerState;
  private restartAttempts = 0;
  private startInProgress = false;
  private stopping = false;
  private authDisposed = false;
  private lastLoggedConnectionState?: ControllerState['connectionState'];
  // When this controller last wrote to its own session file (generating,
  // renaming, etc.). Used to ignore filesystem-watcher events caused by our own
  // writes so live-reload only reacts to EXTERNAL (terminal) changes.
  private selfWriteAt = Date.now();

  public constructor(
    public readonly folder: vscode.WorkspaceFolder,
    private readonly logger: DiagnosticsLogger,
    settings = getSettings()
  ) {
    this.settings = settings;
    this.state = createInitialControllerState(folder.name, folder.uri.fsPath);
    this.supervisor = new PiProcessSupervisor(folder, logger, settings);
    this.supervisor.on('exit', () => {
      this.state = { ...this.state, connectionState: this.stopping ? 'stopped' : 'faulted' };
      this.fire();
      if (
        !this.stopping &&
        !this.startInProgress &&
        this.settings.restartOnCrash &&
        this.restartAttempts < this.settings.maxRestartAttempts
      ) {
        this.restartAttempts += 1;
        this.state = { ...this.state, restartCount: this.restartAttempts };
        this.fire();
        void this.restartAfterBackoff();
      }
    });
  }

  public get onDidChangeState(): vscode.Event<ControllerState> {
    return this.changeEmitter.event;
  }

  /**
   * Resolve once the RPC client is usable (ready/busy). If Pi is still starting
   * or handshaking, wait for it to finish rather than failing with "Pi is not
   * started" — the warm-start sets connectionState to 'starting' well before the
   * client exists, and a resume issued in that window would otherwise race.
   */
  public async whenReady(timeoutMs = 30000): Promise<void> {
    const usable = (): boolean =>
      this.state.connectionState === 'ready' || this.state.connectionState === 'busy';
    if (usable()) {
      return;
    }
    if (this.state.connectionState === 'stopped' || this.state.connectionState === 'faulted') {
      throw new Error('Pi is not running for this workspace');
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        subscription.dispose();
        reject(new Error('Timed out waiting for Pi to be ready'));
      }, timeoutMs);
      const subscription = this.onDidChangeState(() => {
        if (usable()) {
          clearTimeout(timer);
          subscription.dispose();
          resolve();
        } else if (
          this.state.connectionState === 'stopped' ||
          this.state.connectionState === 'faulted'
        ) {
          clearTimeout(timer);
          subscription.dispose();
          reject(new Error('Pi failed to start for this workspace'));
        }
      });
    });
  }

  public get snapshot(): ControllerState {
    return this.state;
  }

  public get onDidReceiveExtensionUiRequest(): vscode.Event<ExtensionUiRequest> {
    return this.extensionUiEmitter.event;
  }

  public get sdkRoot(): string | undefined {
    return this.supervisor.sdkRoot;
  }

  public get generation(): number {
    return this.supervisor.currentGeneration;
  }

  /** Capture even offline chats without starting a client or reading native state. */
  public captureLocalCommandOrigin(): () => boolean {
    const client = this.supervisor.currentClient;
    const generation = this.generation;
    const { sessionId, sessionFile } = this.state.state;
    return () =>
      this.supervisor.currentClient === client &&
      this.generation === generation &&
      this.state.state.sessionId === sessionId &&
      this.state.state.sessionFile === sessionFile;
  }

  /** Typed lifecycle capability. Identity changes are admitted only by this result,
   * never by the ordinary command-origin guard. No abort/queue clearing here. */
  public captureLifecycleIntent() {
    const client = this.supervisor.currentClient;
    const generation = this.generation;
    const origin = { ...this.state.state };
    const leaf = this.state.leafId;
    const stableHost = () =>
      this.supervisor.currentClient === client && this.generation === generation;
    const valid = () =>
      typeof origin.sessionId === 'string' &&
      origin.sessionId.length > 0 &&
      (origin.sessionFile === undefined ||
        (typeof origin.sessionFile === 'string' && origin.sessionFile.length > 0)) &&
      (leaf === null || (typeof leaf === 'string' && leaf.length > 0)) &&
      stableHost() &&
      this.state.state.sessionId === origin.sessionId &&
      this.state.state.sessionFile === origin.sessionFile &&
      this.state.leafId === leaf;
    const idle = async () => {
      this.assertNoManualCompaction();
      if (hasModelOperation(this)) throw new Error('Wait for pending preference/model changes.');
      if (!client) throw new Error('Pi is not running for this originating chat.');
      const native = await client.getState();
      if (
        !valid() ||
        !native ||
        native.sessionId !== origin.sessionId ||
        native.sessionFile !== origin.sessionFile
      )
        throw new Error('The originating chat changed; lifecycle command cancelled.');
      if (
        this.state.connectionState !== 'ready' ||
        this.state.retry ||
        this.state.tools.some((t) => !t.endedAt) ||
        this.state.queue.steering.length ||
        this.state.queue.followUp.length ||
        native.isStreaming ||
        native.isCompacting ||
        native.isRetrying ||
        native.isBashRunning ||
        native.hasPendingBashMessages ||
        native.pendingMessageCount ||
        native.isIdle === false
      )
        throw new Error(
          'Wait for this chat and its queued work to finish. Nothing was aborted or discarded.'
        );
    };
    return {
      valid,
      prepareImport: async (path: string) => {
        await idle();
        const preview = await client!.engineCommand(
          'import_prepare',
          { sessionId: origin.sessionId, sessionFile: origin.sessionFile, leafId: leaf },
          { sessionPath: path }
        );
        if (!valid() || !preview)
          throw new Error('Import preview unavailable for the originating chat.');
        return preview;
      },
      forkMessages: () =>
        (client
          ? client.getForkMessages()
          : Promise.reject(new Error('Pi is not running for this originating chat.'))
        ).then((data) => (Array.isArray(data?.messages) ? (data.messages as JsonObject[]) : [])),
      run: async (
        name: 'new' | 'resume' | 'fork' | 'clone' | 'quit' | 'import',
        target: string | undefined,
        surfaceValid: () => boolean
      ) => {
        await idle();
        if (!surfaceValid() || !valid()) throw new Error('The originating chat changed.');
        this.assertNoManualCompaction();
        this.lifecyclePending = true;
        const dispatch = {
          // Unknown implementations remain conservative; RpcClient clears this
          // before negotiation and sets it only at transport dispatch.
          attempted: false,
          valid: () => surfaceValid() && valid(),
        };
        try {
          if (name === 'resume')
            target = await canonicalizeSessionPath(this.folder.uri.fsPath, target!);
          if (!surfaceValid() || !valid()) throw new Error('The originating chat changed.');
          dispatch.attempted = true;
          const capturedIdentity = {
            sessionId: origin.sessionId,
            sessionFile: origin.sessionFile,
            leafId: leaf,
          };
          const result =
            name === 'quit'
              ? await client!.closeChat(capturedIdentity, dispatch)
              : await client!.replaceChat(name, target, capturedIdentity, dispatch);
          if (!result || result.cancelled === true) return { cancelled: true, valid };
          if (!valid() || !surfaceValid()) throw new Error('The originating native host changed.');
          if (name === 'quit') {
            if (result.closed !== true)
              throw new Error('Native chat disposal was not acknowledged.');
            return { cancelled: false, valid: stableHost };
          }
          const expected = result.replacementIdentity as JsonObject | undefined;
          const projection = result.replacementProjection as JsonObject | undefined;
          const identity = projection?.identity as JsonObject | undefined;
          const capturedOrigin = projection?.origin as JsonObject | undefined;
          const replacement = projection?.state as SessionState | undefined;
          // The managed host captures all public getters synchronously under its
          // lifecycle reservation and detaches their data before response I/O.
          // No independent reads (even repeated leaf reads permit branch ABA).
          if (
            !valid() ||
            !surfaceValid() ||
            projection?.contract !== 1 ||
            typeof expected?.sessionId !== 'string' ||
            !expected.sessionId ||
            typeof identity?.sessionId !== 'string' ||
            !identity.sessionId ||
            typeof replacement?.sessionId !== 'string' ||
            !replacement.sessionId ||
            !(
              expected.sessionFile === undefined ||
              (typeof expected.sessionFile === 'string' && expected.sessionFile.length > 0)
            ) ||
            !(
              identity.sessionFile === undefined ||
              (typeof identity.sessionFile === 'string' && identity.sessionFile.length > 0)
            ) ||
            !(
              replacement.sessionFile === undefined ||
              (typeof replacement.sessionFile === 'string' && replacement.sessionFile.length > 0)
            ) ||
            capturedOrigin?.sessionId !== origin.sessionId ||
            capturedOrigin?.sessionFile !== origin.sessionFile ||
            capturedOrigin?.leafId !== leaf ||
            identity.sessionId !== expected.sessionId ||
            identity.sessionFile !== expected.sessionFile ||
            identity.leafId !== expected.leafId ||
            !(
              (typeof identity.leafId === 'string' && identity.leafId.length > 0) ||
              identity.leafId === null
            ) ||
            replacement.sessionId !== identity.sessionId ||
            replacement.sessionFile !== identity.sessionFile ||
            !Array.isArray(projection.entries) ||
            !Array.isArray(projection.messages)
          )
            throw new Error(
              'Native replacement identity/branch unavailable or changed. Native may already have switched; outgoing history and draft retained.'
            );
          const replacementLeaf = identity.leafId as string | null;
          this.state = {
            ...resetControllerProjection(this.state),
            state: replacement,
            draft: this.state.draft,
            entries: projection!.entries as JsonObject[],
            leafId: replacementLeaf,
            messages: (projection!.messages as JsonObject[]).slice(
              -Math.max(50, this.settings.maxTranscriptItems)
            ),
          };
          this.selfWriteAt = Date.now();
          this.armSessionFileWatcher();
          this.fire();
          await this.syncFileReadOffset();
          return {
            cancelled: false,
            replacementIdentity: replacement as JsonObject,
            editorText: typeof result.text === 'string' ? result.text : undefined,
            valid: () =>
              stableHost() &&
              this.state.state.sessionId === replacement.sessionId &&
              this.state.state.sessionFile === replacement.sessionFile &&
              this.state.leafId === replacementLeaf,
          };
        } catch (error) {
          // A runtime can fail after invalidating its old session. Do not allow
          // later sends into an uncertain native identity; retain saved draft for recovery.
          if (dispatch.attempted) {
            this.state = { ...this.state, connectionState: 'faulted' };
            this.fire();
            throw new Error(
              `${error instanceof Error ? error.message : String(error)} Native may already have switched; outgoing history and draft retained. Restart/recover before sending.`
            );
          }
          throw error;
        } finally {
          this.lifecyclePending = false;
        }
      },
    };
  }

  public captureDeliveryIntent() {
    const client = this.supervisor.currentClient;
    const originValid = this.captureLocalCommandOrigin();
    const leaf = this.state.leafId;
    const valid = () => originValid() && this.state.leafId === leaf;
    const origin = {
      sessionId: this.state.state.sessionId,
      sessionFile: this.state.state.sessionFile,
      leafId: this.state.leafId,
    };
    return {
      valid,
      payload: async (share: boolean) => {
        if (!client || !valid()) throw new Error('The originating chat changed or is offline.');
        const result = await client.engineCommand('delivery_payload', origin, { share });
        if (!valid() || typeof result?.jsonl !== 'string')
          throw new Error('Payload unavailable for this originating branch.');
        return { jsonl: result.jsonl };
      },
    };
  }

  public captureAuthIntent() {
    const client = this.supervisor.currentClient;
    const originValid = this.captureLocalCommandOrigin();
    const leaf = this.state.leafId;
    const valid = () => !this.authDisposed && originValid() && this.state.leafId === leaf;
    const origin = {
      sessionId: this.state.state.sessionId,
      sessionFile: this.state.state.sessionFile,
      leafId: this.state.leafId,
    };
    const required = () => {
      if (!client || !valid()) throw new Error('The originating chat changed or is offline.');
      return client;
    };
    return {
      valid,
      providers: async () => {
        const data = await required().engineCommand('auth_providers', origin);
        if (!valid()) throw new Error('The originating chat changed.');
        return Array.isArray(data?.providers) ? (data.providers as JsonObject[]) : [];
      },
      run: async (
        name: 'logout' | 'login',
        providerId: string,
        authType?: string,
        interact?: (data: JsonObject, token?: vscode.CancellationToken) => Promise<string | null>,
        surfaceValid: () => boolean = valid,
        signal?: AbortSignal
      ) => {
        this.assertNoManualCompaction();
        if (name === 'logout') {
          const result = await required().engineCommand('auth_logout', origin, { providerId });
          if (!valid()) return false;
          await this.refreshState();
          return valid() && result?.applied === true;
        }
        const captured = required();
        const start = await captured.engineCommand('auth_login', origin, { providerId, authType });
        const nonce = start?.nonce;
        if (typeof nonce !== 'string') throw new Error('Authentication could not start.');
        let completed = false;
        let nativeTerminal: JsonObject | undefined;
        const ui = new vscode.CancellationTokenSource();
        let stopped = false;
        let abortRequest: Promise<unknown> | undefined;
        let release!: () => void;
        const interrupted = new Promise<null>((resolve) => {
          release = () => resolve(null);
        });
        const stop = () => {
          if (stopped || completed) return;
          stopped = true;
          // Bypass the login/preference queue: native cancellation must not wait
          // for a UI promise or a provider's parallel callback.
          if (!nativeTerminal)
            abortRequest = captured
              .engineCommand('auth_response', origin, { nonce, value: null })
              .catch(() => {});
          ui.cancel();
          release();
        };
        const check = () => {
          if (signal?.aborted || !valid() || !surfaceValid()) stop();
        };
        signal?.addEventListener('abort', stop, { once: true });
        const changes = this.onDidChangeState?.(check);
        // Surface identity (panel/sidebar resource/disposal) belongs to the caller.
        // Its existing captured guard is also observed while native UI is open.
        const timer = setInterval(check, 25);
        const deferredEvents: import('../rpc/protocol').JsonValue[] = [];
        const interaction = async (data: JsonObject) => {
          let polling = false;
          const nativeTimer = setInterval(() => {
            if (polling || stopped || nativeTerminal || completed) return;
            polling = true;
            void captured
              .engineCommand('auth_poll', origin, { nonce })
              .then((result) => {
                if (stopped || completed) return;
                check();
                if (stopped) return;
                if (Array.isArray(result?.events)) deferredEvents.push(...result.events);
                if (result?.status === 'applied' || result?.status === 'changed_sync_failed') {
                  // Completion of this captured nonce dismisses obsolete UI, not
                  // the native flow. Never send a null response for this dismissal.
                  nativeTerminal = result;
                  ui.cancel();
                  release();
                } else if (result?.status === 'cancelled' || result?.status === 'failed') stop();
              })
              .catch(stop)
              .finally(() => {
                polling = false;
              });
          }, 100);
          try {
            return await Promise.race([Promise.resolve(interact?.(data, ui.token)), interrupted]);
          } finally {
            clearInterval(nativeTimer);
          }
        };
        try {
          check();
          while (!stopped && valid() && surfaceValid()) {
            const data =
              nativeTerminal ?? (await captured.engineCommand('auth_poll', origin, { nonce }));
            check();
            if (stopped || !valid() || !surfaceValid() || !data) return false;
            if (data.status !== 'pending') {
              completed = true;
              if (data.status === 'applied') {
                await this.refreshState();
                return valid() && surfaceValid();
              }
              if (data.status === 'cancelled') return false;
              throw new Error(
                data.status === 'changed_sync_failed'
                  ? 'Credential changed, but model catalog synchronization failed. Review provider status before retrying.'
                  : 'Authentication failed. No credential details are displayed.'
              );
            }
            for (const event of [
              ...deferredEvents.splice(0),
              ...(Array.isArray(data.events) ? data.events : []),
            ]) {
              if (!valid() || !surfaceValid()) return false;
              if (event && typeof event === 'object' && !Array.isArray(event))
                await interaction({ event });
              if (nativeTerminal || stopped) break;
            }
            if (nativeTerminal) continue;
            if (data.prompt && typeof data.prompt === 'object' && !Array.isArray(data.prompt)) {
              const prompt = data.prompt;
              const value = (await interaction({ prompt })) ?? null;
              check();
              if (stopped || !valid() || !surfaceValid()) return false;
              if (nativeTerminal) continue;
              await captured.engineCommand('auth_response', origin, {
                nonce,
                promptNonce: prompt.nonce,
                value,
              });
              if (value === null) return false;
            }
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          return false;
        } finally {
          clearInterval(timer);
          changes?.dispose();
          signal?.removeEventListener('abort', stop);
          if (!completed) stop();
          ui.cancel();
          ui.dispose();
          await abortRequest;
          if (stopped) {
            // Cancellation cannot revoke a credential committed before native
            // cancellation arrived. Do not promise rollback, even on stale UI.
            const result = await captured
              .engineCommand('auth_poll', origin, { nonce })
              .catch(() => undefined);
            if (result?.status === 'applied' || result?.status === 'changed_sync_failed')
              throw new Error(
                'Authentication may already have stored credentials globally. Review provider status; use /logout if you want to remove them. Cancellation does not revoke account tokens.'
              );
          }
        }
      },
    };
  }

  /** Capture the native origin before any composer/UI read. A successful tree move
   * admits only its exact returned leaf; normal origin guards remain unchanged. */
  public captureEngineIntent() {
    const client = this.supervisor.currentClient;
    const generation = this.generation;
    const origin = {
      sessionId: this.state.state.sessionId,
      sessionFile: this.state.state.sessionFile,
      leafId: this.state.leafId,
    };
    const stable = () =>
      this.supervisor.currentClient === client &&
      this.generation === generation &&
      this.state.state.sessionId === origin.sessionId &&
      this.state.state.sessionFile === origin.sessionFile;
    const valid = () => stable() && this.state.leafId === origin.leafId;
    const required = () => {
      if (!client || !valid())
        throw new Error('The originating native chat changed or is offline.');
      return client;
    };
    return {
      valid,
      tree: () => required().getTree(),
      trust: () => required().engineCommand('get_project_trust', origin),
      run: async (
        name: 'tree' | 'trust' | 'reload',
        payload: JsonObject,
        surfaceValid: () => boolean
      ) => {
        this.assertNoManualCompaction();
        if (hasModelOperation(this)) throw new Error('Wait for pending model/preferences changes.');
        const captured = required();
        const native = await captured.getState();
        if (
          !native ||
          !valid() ||
          !surfaceValid() ||
          native.sessionId !== origin.sessionId ||
          native.sessionFile !== origin.sessionFile
        )
          throw new Error('The originating chat changed.');
        if (
          this.state.connectionState !== 'ready' ||
          this.bashPending ||
          this.state.retry ||
          this.state.queue.steering.length ||
          this.state.queue.followUp.length ||
          this.state.tools.some((tool) => !tool.endedAt) ||
          native.isStreaming ||
          native.isCompacting ||
          native.isRetrying ||
          native.isBashRunning ||
          native.hasPendingBashMessages ||
          native.pendingMessageCount ||
          native.isIdle === false
        )
          throw new Error(
            'Wait for this chat and its queued work; nothing was aborted or discarded.'
          );
        this.assertNoManualCompaction();
        this.lifecyclePending = true;
        let applied = false;
        try {
          const result = await captured.engineCommand(
            name === 'tree'
              ? 'navigate_tree'
              : name === 'trust'
                ? 'set_project_trust'
                : 'reload_session',
            origin,
            payload
          );
          applied = !!result && result.cancelled !== true && result.aborted !== true;
          if (!stable() || !surfaceValid())
            throw new Error('The originating chat changed during the native operation.');
          if (!result || result.cancelled === true || result.aborted === true)
            return { cancelled: true, valid };
          const check = () => {
            if (!stable() || !surfaceValid())
              throw new Error('The originating chat changed during native completion.');
          };
          if (name === 'tree' || name === 'reload') {
            // Incremental refreshEntries ignores leaf-only moves. Collect on the
            // captured client and validate each wait BEFORE changing projection.
            const entries = await captured.getEntries();
            check();
            const messages = await captured.getMessages();
            check();
            const current = await captured.getState();
            check();
            if (
              !current ||
              !Array.isArray(entries?.entries) ||
              !Array.isArray(messages?.messages) ||
              current.sessionId !== origin.sessionId ||
              current.sessionFile !== origin.sessionFile ||
              entries?.leafId !== result.leafId
            )
              throw new Error('ENGINE_RECOVERY_REQUIRED_AFTER_COMPLETION');
            const all = messages.messages as JsonObject[];
            this.state = {
              ...this.state,
              state: current,
              entries: entries.entries as JsonObject[],
              leafId: typeof entries.leafId === 'string' ? entries.leafId : null,
              messages: all.slice(-Math.max(50, this.settings.maxTranscriptItems)),
            };
            this.selfWriteAt = Date.now();
            await this.syncFileReadOffset();
            check();
          }
          const leaf = this.state.leafId;
          this.fire();
          return {
            cancelled: false,
            editorText: typeof result.editorText === 'string' ? result.editorText : undefined,
            valid: () => stable() && this.state.leafId === leaf,
          };
        } catch (error) {
          if (stable() && (applied || String(error).includes('RECOVERY_REQUIRED'))) {
            this.state = { ...this.state, connectionState: 'faulted' };
            this.fire();
          }
          throw error;
        } finally {
          this.lifecyclePending = false;
        }
      },
    };
  }

  public async start(sessionFile = this.state.state.sessionFile): Promise<void> {
    this.assertNoManualCompaction();
    if (this.state.connectionState === 'ready' || this.state.connectionState === 'busy') {
      return;
    }
    if (this.folder.uri.scheme !== 'file') {
      throw new Error('Virtual workspaces are unsupported for Pi');
    }
    this.stopping = false;
    // While an explicit start (incl. the recovery ladder) is in flight, the crash
    // 'exit' handler must NOT also auto-restart — start() owns recovery.
    this.startInProgress = true;

    // Recovery ladder. VS Code runs Pi with --offline by default; the TUI runs
    // online. An extension that needs the network at startup crashes Pi offline
    // (exit 1) even though the same session opens fine in the TUI. So: try as
    // configured, then retry ONLINE keeping extensions (matches the TUI), and
    // only disable extensions as a last resort — we never silently drop
    // capabilities the user may want.
    const configuredOffline = this.settings.offline;
    const ladder: Array<{ offline: boolean; noExtensions: boolean; note?: string }> = sessionFile
      ? [
          { offline: configuredOffline, noExtensions: false },
          ...(configuredOffline
            ? [
                {
                  offline: false,
                  noExtensions: false,
                  note: 'loaded this chat by letting Pi go online (an extension needs the network at startup). Extensions are kept.',
                },
              ]
            : []),
          {
            offline: false,
            noExtensions: true,
            note: 'loaded this chat with Pi extensions disabled (an extension failed to start even online). Restart Pi to re-enable them.',
          },
        ]
      : [{ offline: configuredOffline, noExtensions: false }];

    let lastError: unknown;
    for (let index = 0; index < ladder.length; index += 1) {
      const attempt = ladder[index]!;
      this.state = {
        ...this.state,
        state: { ...this.state.state, sessionFile },
        connectionState: 'starting',
      };
      this.fire();
      try {
        await this.launchOnce(sessionFile, attempt);
        this.restartAttempts = 0;
        this.startInProgress = false;
        if (index > 0 && attempt.note) {
          this.logger.warn(`Pi recovery: ${attempt.note}`);
          void vscode.window.showWarningMessage(`Pi: ${attempt.note}`);
        }
        return;
      } catch (error) {
        lastError = error;
        this.logger.warn(
          `Pi start attempt ${index + 1}/${ladder.length} failed ` +
            `(offline=${attempt.offline}, noExtensions=${attempt.noExtensions}): ` +
            `${error instanceof Error ? error.message : String(error)}`
        );
        await this.supervisor.stop().catch(() => undefined);
      }
    }

    // Every attempt failed — surface the reason and move to the faulted state.
    this.startInProgress = false;
    const message = lastError instanceof Error ? lastError.message : String(lastError);
    this.logger.error(`Pi failed to start for '${this.folder.name}'`, lastError);
    this.addDiagnostic('error', 'Pi failed to start', message);
    this.state = { ...this.state, connectionState: 'faulted' };
    this.fire();
    throw lastError instanceof Error ? lastError : new Error(message);
  }

  /** One launch attempt: spawn Pi, wire handlers, handshake + reconcile. */
  private async launchOnce(
    sessionFile: string | undefined,
    options: { offline: boolean; noExtensions: boolean }
  ): Promise<void> {
    const client = await this.supervisor.start(sessionFile, options);
    client.onEvent((event) => this.onEvent(event));
    client.onExtensionUi((request) => this.onExtensionUi(request));
    client.onResponseFailure((response) => {
      this.addDiagnostic(
        response.command === 'parse' ? 'error' : 'warning',
        `RPC response failed: ${response.command}`,
        response.success
          ? ''
          : response.command === 'compact'
            ? 'Compaction failed or was cancelled.'
            : response.error
      );
    });
    client.onProtocolFault((error) => this.addDiagnostic('error', 'Protocol fault', error.message));
    client.onDisconnected((error) => this.addDiagnostic('warning', 'Disconnected', error.message));
    client.onStderr((text) => {
      this.state = { ...this.state, stderrTail: [...this.state.stderrTail.slice(-49), text] };
      this.fire();
    });
    this.state = {
      ...this.state,
      connectionState: 'handshaking',
      generation: this.supervisor.currentGeneration,
    };
    this.fire();
    this.logger.info(`Handshaking with Pi for '${this.folder.name}'…`);
    await this.reconcile();
    this.logger.info(`Pi is ready for '${this.folder.name}' (state=${this.state.connectionState})`);
  }

  public async stop(): Promise<void> {
    this.assertNoManualCompaction();
    cancelModelOperations(this);
    this.stopping = true;
    this.disarmSessionFileWatcher();
    await this.supervisor.stop();
    this.state = { ...this.state, connectionState: 'stopped' };
    this.fire();
  }

  // ---- Native session-file watcher (real-time TUI -> GUI sync) -------------
  // VS Code's workspace file watcher is unreliable/high-latency for the Pi
  // sessions dir (it lives OUTSIDE the workspace under ~/.pi/agent). A direct
  // OS-level fs.watch on the active session file surfaces terminal appends
  // within ~150ms; we fall back to stat-polling where fs.watch is unavailable.
  private sessionWatcher: FSWatcher | undefined;
  private watchedSessionFile: string | undefined;
  private watchFallbackActive = false;
  private watchDebounce: ReturnType<typeof setTimeout> | undefined;
  private static readonly WATCH_DEBOUNCE_MS = 150;
  private static readonly WATCH_SELF_WRITE_GRACE_MS = 1500;

  private armSessionFileWatcher(): void {
    const file = this.activeSessionFile;
    if (file === this.watchedSessionFile) {
      return; // already watching the right file
    }
    this.disarmSessionFileWatcher();
    if (!file) {
      return;
    }
    this.watchedSessionFile = file;
    try {
      this.sessionWatcher = fsWatch(file, { persistent: false }, () => this.onSessionFileEvent());
      this.sessionWatcher.on('error', () => this.enableWatchFallback(file));
    } catch {
      this.enableWatchFallback(file);
    }
  }

  private enableWatchFallback(file: string): void {
    if (this.sessionWatcher) {
      try {
        this.sessionWatcher.close();
      } catch {
        /* ignore */
      }
      this.sessionWatcher = undefined;
    }
    this.watchFallbackActive = true;
    this.watchedSessionFile = file;
    watchFile(file, { persistent: false, interval: 1000 }, () => this.onSessionFileEvent());
  }

  private onSessionFileEvent(): void {
    if (this.watchDebounce) {
      clearTimeout(this.watchDebounce);
    }
    this.watchDebounce = setTimeout(() => {
      this.watchDebounce = undefined;
      // Skip our own writes and non-idle states.
      if (this.state.connectionState !== 'ready') {
        return;
      }
      if (this.msSinceSelfWrite() < SessionController.WATCH_SELF_WRITE_GRACE_MS) {
        return;
      }
      // Resync the authoritative active branch over RPC (see appendExternalMessages).
      void this.appendExternalMessages().catch(() => {
        /* best-effort live resync */
      });
    }, SessionController.WATCH_DEBOUNCE_MS);
  }

  private disarmSessionFileWatcher(): void {
    if (this.watchDebounce) {
      clearTimeout(this.watchDebounce);
      this.watchDebounce = undefined;
    }
    if (this.sessionWatcher) {
      try {
        this.sessionWatcher.close();
      } catch {
        /* ignore */
      }
      this.sessionWatcher = undefined;
    }
    if (this.watchFallbackActive && this.watchedSessionFile) {
      try {
        unwatchFile(this.watchedSessionFile);
      } catch {
        /* ignore */
      }
      this.watchFallbackActive = false;
    }
    this.watchedSessionFile = undefined;
  }

  public async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  public async reconcile(): Promise<void> {
    const client = this.requireClient();
    const valid = this.captureLocalCommandOrigin();
    const catalogRequest = (this.catalogRequest = (this.catalogRequest ?? 0) + 1);
    // Do not request the complete historical transcript/entry tree over RPC.
    // Pi returns each as one JSONL response record; old sessions with images or
    // large tool output make that record huge and block the handshake. Runtime
    // metadata is small and the transcript is read locally below.
    // Use the LONG timeout: when a big session is still being parsed by Pi,
    // these metadata calls block until it finishes loading. The short (15s)
    // timeout made long chats fail with "couldn't load this chat" mid-load.
    const [state, commands, stats] = await Promise.all([
      client.getState('long'),
      client.getCommands('long'),
      client.getSessionStats('long'),
    ]).catch((error: unknown) => {
      // A reconcile failure (timeout, protocol fault) is why a tab can be stuck
      // in 'handshaking' — always record it so it's explainable from the logs.
      this.logger.error(`Reconcile failed for '${this.folder.name}'`, error);
      throw error instanceof Error ? error : new Error(String(error));
    });
    if (!valid()) return;
    const sessionState = mergeSessionState(this.state.state, (state ?? {}) as SessionState);
    const sessionFile =
      typeof sessionState.sessionFile === 'string'
        ? sessionState.sessionFile
        : typeof this.state.state.sessionFile === 'string'
          ? this.state.state.sessionFile
          : undefined;
    const messageList = sessionFile ? await this.readRecentSessionMessages(sessionFile) : [];
    if (!valid()) return;
    // Entries/tree are intentionally lazy. Fork/tree commands request them only
    // when the user opens those actions, keeping normal resume fast and bounded.
    const entries: JsonObject = { entries: [] };
    const tree: JsonObject = { tree: [] };
    this.state = {
      ...this.state,
      connectionState: sessionState.isStreaming || sessionState.isCompacting ? 'busy' : 'ready',
      state: sessionState,
      messages: messageList,
      entries: Array.isArray(entries.entries) ? (entries.entries as JsonObject[]) : [],
      tree: Array.isArray(tree.tree) ? (tree.tree as JsonObject[]) : [],
      commands:
        catalogRequest === this.catalogRequest
          ? mergeLocalCommands(
              Array.isArray(commands?.commands) ? (commands.commands as JsonObject[]) : []
            )
          : this.state.commands,
      lastSessionStats: (stats ?? undefined) as JsonObject | undefined,
      leafId:
        typeof entries.leafId === 'string'
          ? entries.leafId
          : typeof tree.leafId === 'string'
            ? tree.leafId
            : null,
    };
    // Explain exactly what Pi returned so an "empty transcript on resume" is
    // diagnosable: which call held the data, and how many.
    this.logger.info(
      `Reconciled '${this.folder.name}': state=${this.state.connectionState}, ` +
        `messages=${messageList.length} (local session tail), ` +
        `entries=${this.state.entries.length} (lazy), ` +
        `tree=${this.state.tree.length} (lazy), ` +
        `session=${this.state.state.sessionFile ?? '(none)'}`
    );
    // We now hold the full transcript; the file tail beyond this is external.
    await this.syncFileReadOffset();
    // (Re)arm the native file watcher so terminal (TUI) appends to THIS session
    // file push into the GUI in near real time.
    this.armSessionFileWatcher();
    this.fire();
    // NOTE: the tail read above is already branch-aware (selectActiveBranchMessages
    // walks the active leaf), so we do NOT resync via getMessages here — that
    // transferred the full 11MB+ active branch on every switch and was the main
    // remaining switch lag. Live edits/forks/TUI writes still resync via the
    // session-file watcher and the agent_end/settled handlers.
  }

  private async readRecentSessionMessages(sessionFile: string): Promise<JsonObject[]> {
    const limit = Math.max(50, this.settings.maxTranscriptItems);
    const records: SessionRecord[] = [];
    try {
      // Read only the TAIL of the file, not the whole thing. Sessions grow to
      // tens of MB (images / large tool output); reading all of it on every
      // open/switch was the main switch lag (~200ms+ for a 40MB file). The tail
      // holds the most recent messages, which is what the transcript shows;
      // the authoritative active branch is resynced over RPC separately.
      const TAIL_BYTES = 3 * 1024 * 1024;
      const size = (await stat(sessionFile)).size;
      const start = size > TAIL_BYTES ? size - TAIL_BYTES : 0;
      const input = createReadStream(sessionFile, { encoding: 'utf8', start });
      const lines = createInterface({ input, crlfDelay: Infinity });
      let skipPartialFirstLine = start > 0;
      for await (const line of lines) {
        if (skipPartialFirstLine) {
          // When starting mid-file the first line is a partial record fragment.
          skipPartialFirstLine = false;
          continue;
        }
        if (!line.trim()) continue;
        try {
          records.push(JSON.parse(line) as SessionRecord);
        } catch {
          // A malformed/partial historical line must not prevent the chat from opening.
        }
      }
      // Only the ACTIVE branch — Pi keeps every fork branch in the same file, so
      // a plain read would resurrect dropped branches after an inline edit/fork.
      return selectActiveBranchMessages<JsonObject>(records, limit);
    } catch (error) {
      // A brand-new session file may not exist on disk yet — that's expected.
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        this.logger.warn(`Could not read local transcript for '${sessionFile}': ${String(error)}`);
      }
      return [];
    }
  }

  /** ms since we last wrote to our own session file. */
  public msSinceSelfWrite(): number {
    return Date.now() - this.selfWriteAt;
  }

  public get activeSessionFile(): string | undefined {
    return typeof this.state.state.sessionFile === 'string'
      ? this.state.state.sessionFile
      : undefined;
  }

  // Byte offset in the session file that we have already accounted for. Used to
  // TAIL new lines (silent append) instead of reloading the whole session.
  private lastReadFileSize = 0;

  private async syncFileReadOffset(): Promise<void> {
    const file = this.activeSessionFile;
    if (!file) {
      this.lastReadFileSize = 0;
      return;
    }
    try {
      this.lastReadFileSize = (await stat(file)).size;
    } catch {
      this.lastReadFileSize = 0;
    }
  }

  /**
   * A terminal (or a fork/branch switch) changed the SAME session file. Resync
   * the transcript from Pi's AUTHORITATIVE active branch over RPC instead of
   * tailing the file: the file stores EVERY fork branch, so a local tail-append
   * can only add (never remove) and would resurrect dropped branches. RPC
   * get_messages returns exactly the active branch, so this also reflects
   * truncations (e.g. after an inline edit/fork). Idle-only.
   */
  public async appendExternalMessages(): Promise<void> {
    const file = this.activeSessionFile;
    if (!file || this.state.connectionState !== 'ready') {
      return;
    }
    let size: number;
    try {
      size = (await stat(file)).size;
    } catch {
      return;
    }
    if (size === this.lastReadFileSize) {
      return; // nothing changed on disk since we last synced
    }
    this.lastReadFileSize = size;
    await this.refreshMessages();
  }

  public async prompt(
    message: string,
    mode: 'prompt' | 'steer' | 'followUp' = 'prompt',
    images: JsonObject[] = []
  ): Promise<void> {
    this.assertNoManualCompaction();
    assertNotCoreSlashPrompt(message);
    await waitForModelOperations(this);
    this.assertNoManualCompaction();
    if (this.state.connectionState === 'faulted')
      throw new Error('Native chat identity is unconfirmed. Restart/recover before sending.');
    this.selfWriteAt = Date.now();
    const client = this.requireClient();
    // Immediate feedback: show the working state the instant the user submits,
    // before Pi's first event arrives.
    this.state = {
      ...this.state,
      connectionState: 'busy',
      state: { ...this.state.state, isStreaming: true },
    };
    this.fire();
    if (mode === 'prompt') {
      await client.prompt(message, images);
    } else if (mode === 'steer') {
      await client.steer(message, images);
    } else {
      await client.followUp(message, images);
    }
  }

  public async abort(): Promise<void> {
    const operation = this.manualCompactOperation;
    // Invalidate the reservation before native abort: preflight has no native work to cancel.
    if (operation) operation.cancelled = true;
    const pending = this.requireClient().abort();
    if (operation)
      operation.aborts.push(
        pending.then(
          () => {},
          () => {}
        )
      );
    await pending;
  }

  public async newSession(parentSession?: string): Promise<JsonObject | undefined> {
    this.assertNoManualCompaction();
    cancelModelOperations(this);
    this.selfWriteAt = Date.now();
    const result = await this.requireClient().newSession(parentSession);
    if (result?.cancelled === true) {
      this.addDiagnostic('info', 'New session cancelled');
      return result;
    }
    this.state = { ...resetControllerProjection(this.state), draft: '' };
    this.fire();
    await this.reconcile();
    return result;
  }

  public async refreshState(): Promise<void> {
    this.state = {
      ...this.state,
      state: mergeSessionState(
        this.state.state,
        ((await this.requireClient().getState()) ?? {}) as SessionState
      ),
    };
    this.fire();
  }

  public async refreshMessages(): Promise<void> {
    const data = await this.requireClient().getMessages();
    const all = Array.isArray(data?.messages) ? (data.messages as JsonObject[]) : [];
    // Window to the most recent N. Large sessions return an 11MB+ list; rendering
    // all of it is slow and unnecessary (older messages load lazily on scroll).
    const limit = Math.max(50, this.settings.maxTranscriptItems);
    const messages = all.length > limit ? all.slice(-limit) : all;
    this.state = { ...this.state, messages };
    this.fire();
  }

  public modelEpoch = 0;

  public async selectModel(provider: string, modelId: string): Promise<void> {
    this.assertNoManualCompaction();
    this.modelEpoch = (this.modelEpoch ?? 0) + 1;
    const client = this.requireClient();
    const session = { ...this.state.state };
    await client.setModel(provider, modelId);
    if (
      this.supervisor.currentClient !== client ||
      this.state.state.sessionId !== session.sessionId ||
      this.state.state.sessionFile !== session.sessionFile
    ) {
      throw new Error('The originating chat changed; model selection cancelled.');
    }
    const next = await client.getState();
    if (
      this.supervisor.currentClient !== client ||
      this.state.state.sessionId !== session.sessionId ||
      this.state.state.sessionFile !== session.sessionFile
    ) {
      throw new Error('The originating chat changed; model selection cancelled.');
    }
    this.state = {
      ...this.state,
      state: mergeSessionState(this.state.state, (next ?? {}) as SessionState),
    };
    this.fire();
  }

  public async cycleModel(): Promise<void> {
    this.assertNoManualCompaction();
    this.modelEpoch = (this.modelEpoch ?? 0) + 1;
    const data = await this.requireClient().cycleModel();
    if (data) {
      this.state = {
        ...this.state,
        state: {
          ...this.state.state,
          model: (data.model as SessionState['model']) ?? this.state.state.model,
          thinkingLevel:
            typeof data.thinkingLevel === 'string'
              ? data.thinkingLevel
              : this.state.state.thinkingLevel,
        },
      };
      this.fire();
    }
    await this.refreshState();
  }

  public async getPreferences() {
    return this.requireClient().getPreferences();
  }

  public async savePreference(
    key: string,
    value: import('../rpc/preferences').PreferenceValue,
    revision: string,
    confirmPaid: boolean
  ) {
    this.assertNoManualCompaction();
    const client = this.requireClient();
    const state = { ...this.state.state };
    if (
      state.isStreaming ||
      state.isCompacting ||
      state.isRetrying ||
      state.isBashRunning ||
      this.state.queue.steering.length ||
      this.state.queue.followUp.length
    )
      throw new Error(
        'Engine preferences can be viewed while busy; saving requires an idle session with empty queues.'
      );
    const result = await client.savePreference(key, value, revision, confirmPaid);
    if (
      client !== this.supervisor.currentClient ||
      state.sessionId !== this.state.state.sessionId ||
      state.sessionFile !== this.state.state.sessionFile
    )
      throw new Error(
        'Global preference saved; originating chat changed, session outcome not acknowledged.'
      );
    await this.refreshState();
    if (
      client !== this.supervisor.currentClient ||
      state.sessionId !== this.state.state.sessionId ||
      state.sessionFile !== this.state.state.sessionFile
    )
      throw new Error(
        'Global preference saved; originating chat changed during refresh, session outcome not acknowledged.'
      );
    return result;
  }

  public async getScopedModels() {
    return this.requireClient().getScopedModels();
  }

  public async applyScopedModels(
    refs: import('../rpc/protocol').ScopedModelRef[],
    revision: string,
    saveGlobal: boolean,
    replaceUnavailable: boolean
  ): Promise<void> {
    const client = this.requireClient();
    const session = { ...this.state.state };
    this.assertNoManualCompaction();
    await client.setScopedModels(refs, revision, saveGlobal, replaceUnavailable);
    if (
      client !== this.supervisor.currentClient ||
      session.sessionId !== this.state.state.sessionId ||
      session.sessionFile !== this.state.state.sessionFile
    )
      throw new Error('The originating chat changed; scope selection cancelled.');
  }

  public async getAvailableModels(): Promise<JsonObject[]> {
    const data = await this.requireClient().getAvailableModels();
    return Array.isArray(data?.models) ? (data.models as JsonObject[]) : [];
  }

  public async getThinkingCapabilities() {
    return this.requireClient().getThinkingCapabilities();
  }

  public async setThinkingLevel(level: string, expectedRevision?: string): Promise<void> {
    this.assertNoManualCompaction();
    const client = this.requireClient();
    const state = { ...this.state.state };
    const capabilities = await client.getThinkingCapabilities();
    if (!capabilities.levels.includes(level))
      throw new Error('Unsupported thinking level for current model.');
    if (
      client !== this.supervisor.currentClient ||
      state.sessionId !== this.state.state.sessionId ||
      state.sessionFile !== this.state.state.sessionFile ||
      JSON.stringify(state.model) !== JSON.stringify(this.state.state.model)
    )
      throw new Error('The originating model changed; thinking selection cancelled.');
    this.assertNoManualCompaction();
    await client.setThinkingLevel(level, expectedRevision ?? capabilities.revision);
    if (
      client !== this.supervisor.currentClient ||
      state.sessionId !== this.state.state.sessionId ||
      state.sessionFile !== this.state.state.sessionFile
    )
      throw new Error('The originating chat changed; thinking selection cancelled.');
    await this.refreshState();
  }

  public async cycleThinkingLevel(): Promise<void> {
    this.assertNoManualCompaction();
    const data = await this.requireClient().cycleThinkingLevel();
    if (data && typeof data.level === 'string') {
      this.state = { ...this.state, state: { ...this.state.state, thinkingLevel: data.level } };
      this.fire();
    }
    await this.refreshState();
  }

  public async setSteeringMode(mode: string): Promise<void> {
    this.assertNoManualCompaction();
    await this.requireClient().setSteeringMode(mode);
    await this.refreshState();
  }

  public async setFollowUpMode(mode: string): Promise<void> {
    this.assertNoManualCompaction();
    await this.requireClient().setFollowUpMode(mode);
    await this.refreshState();
  }

  private manualCompactPending = false;
  private manualCompactOperation?: { cancelled: boolean; aborts: Promise<void>[] };
  private bashPending = false;
  private lifecyclePending = false;

  public assertNoManualCompaction(): void {
    if (this.lifecyclePending) throw new Error('A chat lifecycle operation is in progress.');
    if (this.manualCompactPending) throw new Error('Compaction is in progress.');
  }

  private assertCompactIdle(state = this.state.state, ownReservation = false): void {
    if (
      this.lifecyclePending ||
      (!ownReservation && this.manualCompactPending) ||
      this.bashPending ||
      hasModelOperation(this) ||
      state.isStreaming ||
      state.isCompacting ||
      state.pendingMessageCount ||
      state.isIdle === false ||
      state.isBashRunning ||
      state.hasPendingBashMessages ||
      state.isRetrying ||
      this.state.retry ||
      this.state.switchingSession ||
      this.state.queue?.steering.length ||
      this.state.queue?.followUp.length ||
      this.requireClient().hasCompactionConflict
    )
      throw new Error('Compaction requires an idle session; no work or queues were aborted.');
  }

  public captureCompactIntent() {
    this.assertCompactIdle();
    const client = this.requireClient();
    const generation = this.generation;
    const origin = { ...this.state.state };
    const valid = () =>
      this.generation === generation &&
      this.supervisor.currentClient === client &&
      this.state.state.sessionId === origin.sessionId &&
      this.state.state.sessionFile === origin.sessionFile;
    return {
      valid,
      run: async (instructions?: string) => {
        if (!valid()) throw new Error('The originating chat changed; compaction cancelled.');
        this.assertCompactIdle();
        this.manualCompactPending = true;
        const operation = { cancelled: false, aborts: [] as Promise<void>[] };
        this.manualCompactOperation = operation;
        try {
          const state = await client.getState();
          if (
            operation.cancelled ||
            !valid() ||
            !state ||
            state.sessionId !== origin.sessionId ||
            state.sessionFile !== origin.sessionFile
          )
            throw new Error('The originating chat changed; compaction cancelled.');
          // The reservation is ours; all other busy conditions must still be absent.
          this.assertCompactIdle(this.state.state, true);
          this.assertCompactIdle(state, true);
          this.selfWriteAt = Date.now();
          const result = await client.compact(instructions?.trim() || undefined);
          if (operation.cancelled) throw new Error('Compaction cancelled.');
          if (
            !result ||
            typeof result.summary !== 'string' ||
            typeof result.firstKeptEntryId !== 'string' ||
            typeof result.tokensBefore !== 'number'
          )
            throw new Error('Compaction did not return a native result.');
          return result;
        } catch {
          throw new Error('Compaction failed or was cancelled.');
        } finally {
          // Do not admit replacement work while an originating native abort is unsettled.
          for (const abort of operation.aborts) await abort;
          this.manualCompactOperation = undefined;
          this.manualCompactPending = false;
          if (valid()) {
            this.state = {
              ...this.state,
              connectionState: this.state.state.isStreaming ? 'busy' : 'ready',
              state: { ...this.state.state, isCompacting: false },
            };
            this.fire();
          }
        }
      },
    };
  }

  public async compact(customInstructions?: string): Promise<JsonObject | undefined> {
    return this.captureCompactIntent().run(customInstructions);
  }

  public async toggleAutoCompaction(): Promise<void> {
    this.assertNoManualCompaction();
    await this.requireClient().setAutoCompaction(
      !(this.state.state.autoCompactionEnabled === true)
    );
    await this.refreshState();
  }

  public async toggleAutoRetry(enabled: boolean): Promise<void> {
    this.assertNoManualCompaction();
    await this.requireClient().setAutoRetry(enabled);
  }

  public async abortRetry(): Promise<void> {
    await this.requireClient().abortRetry();
  }

  public async runBash(
    command: string,
    excludeFromContext = false
  ): Promise<JsonObject | undefined> {
    if (this.manualCompactPending) throw new Error('Compaction is in progress.');
    this.bashPending = true;
    try {
      return await this.requireClient().bash(command, excludeFromContext);
    } finally {
      this.bashPending = false;
    }
  }

  public async abortBash(): Promise<void> {
    await this.requireClient().abortBash();
  }

  public async refreshEntries(): Promise<void> {
    try {
      const data = await this.requireClient().getEntries(
        typeof this.state.entries.at(-1)?.id === 'string'
          ? (this.state.entries.at(-1)?.id as string)
          : undefined
      );
      if (Array.isArray(data?.entries) && data.entries.length > 0) {
        this.state = {
          ...this.state,
          entries: [...this.state.entries, ...(data.entries as JsonObject[])],
          leafId: typeof data.leafId === 'string' ? data.leafId : this.state.leafId,
        };
        this.fire();
      }
    } catch {
      const full = await this.requireClient().getEntries();
      this.state = {
        ...this.state,
        entries: Array.isArray(full?.entries) ? (full.entries as JsonObject[]) : [],
        leafId: typeof full?.leafId === 'string' ? full.leafId : null,
      };
      this.fire();
    }
  }

  public async refreshTree(): Promise<void> {
    const data = await this.requireClient().getTree();
    this.state = {
      ...this.state,
      tree: Array.isArray(data?.tree) ? (data.tree as JsonObject[]) : [],
      leafId: typeof data?.leafId === 'string' ? data.leafId : null,
    };
    this.fire();
  }

  public async renameSession(name: string): Promise<void> {
    this.assertNoManualCompaction();
    const client = this.requireClient();
    const generation = this.generation;
    const origin = { ...this.state.state };
    const valid = () =>
      this.generation === generation &&
      this.state.state.sessionId === origin.sessionId &&
      this.state.state.sessionFile === origin.sessionFile &&
      this.requireClient() === client;
    if (!name.trim()) throw new Error('Session name cannot be empty');
    this.selfWriteAt = Date.now();
    await client.setSessionName(name.trim());
    if (!valid()) throw new Error('The originating chat changed; rename cancelled.');
    const updated = await client.getState();
    if (
      !updated ||
      !valid() ||
      updated.sessionId !== origin.sessionId ||
      updated?.sessionFile !== origin.sessionFile
    ) {
      throw new Error('The originating chat changed; rename cancelled.');
    }
    if (typeof updated.sessionName !== 'string' || !updated.sessionName) {
      throw new Error('Session name persistence could not be confirmed.');
    }
    this.state = {
      ...this.state,
      state: { ...this.state.state, sessionName: updated.sessionName },
    };
    this.fire();
  }

  public async showSessionStats(): Promise<JsonObject | undefined> {
    const client = this.requireClient();
    const generation = this.generation;
    const origin = { ...this.state.state };
    const [stats, state, entries] = await Promise.all([
      client.getSessionStats(),
      client.getState(),
      client.getEntries(),
    ]);
    if (
      this.generation !== generation ||
      this.requireClient() !== client ||
      this.state.state.sessionId !== origin.sessionId ||
      this.state.state.sessionFile !== origin.sessionFile ||
      !state ||
      state.sessionId !== origin.sessionId ||
      state.sessionFile !== origin.sessionFile ||
      !stats ||
      stats.sessionId !== origin.sessionId ||
      stats.sessionFile !== origin.sessionFile
    )
      throw new Error('The originating chat changed; session info cancelled.');
    const data = projectSessionInfo(stats, state);
    if (Array.isArray(entries?.entries)) data.totalEntries = entries.entries.length;
    this.state = { ...this.state, lastSessionStats: data };
    this.fire();
    return data;
  }

  /** Immutable originating client/session/branch; never retarget after UI waits. */
  public captureExportIntent() {
    const client = this.requireClient();
    const generation = this.generation;
    const origin = { ...this.state.state };
    const leafId = this.state.leafId;
    const valid = () =>
      this.generation === generation &&
      this.supervisor.currentClient === client &&
      this.state.state.sessionId === origin.sessionId &&
      this.state.state.sessionFile === origin.sessionFile &&
      this.state.leafId === leafId;
    return {
      valid,
      write: async (path: string, jsonl: boolean) => {
        const [state, entries] = await Promise.all([client.getState(), client.getEntries()]);
        if (
          !valid() ||
          !state ||
          state.sessionId !== origin.sessionId ||
          state.sessionFile !== origin.sessionFile ||
          entries?.leafId !== leafId
        )
          throw new Error('The originating chat or branch changed; export cancelled.');
        if (
          state.isStreaming ||
          state.isCompacting ||
          state.pendingMessageCount ||
          this.state.retry ||
          this.state.switchingSession
        )
          throw new Error('Export requires an idle stable session.');
        const expected = { sessionId: origin.sessionId, sessionFile: origin.sessionFile, leafId };
        const data = jsonl
          ? await client.exportJsonl(path, expected, valid)
          : await client.exportHtml(path, expected);
        if (valid()) {
          this.state = {
            ...this.state,
            lastExportPath: typeof data?.path === 'string' ? data.path : undefined,
          };
          this.fire();
        }
        return data;
      },
    };
  }

  public async exportHtml(outputPath?: string): Promise<JsonObject | undefined> {
    const data = await this.requireClient().exportHtml(outputPath);
    this.state = {
      ...this.state,
      lastExportPath: typeof data?.path === 'string' ? data.path : undefined,
    };
    this.fire();
    return data;
  }

  public async switchSession(sessionPath: string): Promise<JsonObject | undefined> {
    this.assertNoManualCompaction();
    cancelModelOperations(this);
    const canonical = await canonicalizeSessionPath(this.folder.uri.fsPath, sessionPath);
    this.logger.info(`Resuming session ${canonical} for '${this.folder.name}'`);
    let result: JsonObject | undefined;
    try {
      // Ensure the RPC client is actually usable (handles the warm-start race
      // where connectionState is 'starting' but the client isn't created yet).
      // MUST happen BEFORE we set the loading state below: whenReady() waits for
      // 'ready'/'busy', so setting 'handshaking' first would deadlock it (30s
      // "Timed out waiting for Pi to be ready").
      await this.whenReady();
      this.assertNoManualCompaction();
      // Loading feedback WITHOUT touching connectionState: clear the transcript
      // and set `switchingSession` so the webview shows the "Loading chat…"
      // loader. Using a flag (not 'handshaking') is critical — with one Pi per
      // folder, concurrent session switches would otherwise deadlock each
      // other's whenReady() (which waits for ready/busy), causing the frozen UI
      // and the "Timed out waiting for Pi to be ready" noise.
      this.state = {
        ...resetControllerProjection(this.state),
        switchingSession: true,
        state: { ...this.state.state, sessionFile: canonical },
      };
      this.fire();
      result = await this.requireClient().switchSession(canonical);
    } catch (error) {
      this.state = { ...this.state, switchingSession: false };
      this.fire();
      // Surface the real reason (path/permission/cwd errors are common on
      // Windows) instead of failing silently.
      this.logger.error(`Failed to resume session ${canonical}`, error);
      this.addDiagnostic(
        'error',
        'Failed to resume session',
        error instanceof Error ? error.message : String(error)
      );
      throw error;
    }
    if (result?.cancelled === true) {
      this.state = { ...this.state, switchingSession: false };
      this.fire();
      this.addDiagnostic('info', 'Switch session cancelled');
      return result;
    }
    await this.reconcile();
    this.state = { ...this.state, switchingSession: false };
    this.fire();
    return result;
  }

  public async fork(entryId: string): Promise<JsonObject | undefined> {
    this.assertNoManualCompaction();
    const result = await this.requireClient().fork(entryId);
    const text = typeof result?.text === 'string' ? result.text : '';
    if (result?.cancelled === true) {
      this.addDiagnostic('info', 'Fork session cancelled', text);
      return result;
    }
    this.state = { ...resetControllerProjection(this.state), draft: text };
    this.fire();
    await this.reconcile();
    // reconcile reads the transcript locally from the session file, which holds
    // ALL branches — so the pre-fork messages would reappear. Override with the
    // active (forked) branch over RPC so everything after the fork point stays
    // dropped.
    try {
      await this.refreshMessages();
    } catch (error) {
      this.logger.warn(`Could not refresh messages after fork: ${String(error)}`);
    }
    // The file watcher tails the session file (which holds every branch) and
    // appends "new" lines. Fork rewrites/branches the file, so move the tail
    // pointer to EOF and mark a self-write; otherwise the just-dropped branch
    // would be re-appended and the post-fork messages would reappear.
    this.selfWriteAt = Date.now();
    await this.syncFileReadOffset();
    return result;
  }

  // Lean in-place fork for the inline-edit flow. Unlike fork(), this does NOT
  // reset the projection or run a full reconcile (which re-reads get_state and
  // makes the tab treat it as a session switch, spawning a new tab + sidebar
  // entry). Pi's fork branches in-place in the SAME session file, so we only
  // refresh the transcript from the active branch over RPC and keep the tab
  // bound to the same session.
  public async forkInPlace(entryId: string): Promise<JsonObject | undefined> {
    this.assertNoManualCompaction();
    const result = await this.requireClient().fork(entryId);
    if (result?.cancelled === true) {
      this.addDiagnostic('info', 'Fork cancelled');
      return result;
    }
    try {
      await this.refreshMessages();
    } catch (error) {
      this.logger.warn(`Could not refresh messages after in-place fork: ${String(error)}`);
    }
    this.selfWriteAt = Date.now();
    await this.syncFileReadOffset();
    return result;
  }

  public async clone(): Promise<JsonObject | undefined> {
    this.assertNoManualCompaction();
    const result = await this.requireClient().clone();
    if (result?.cancelled === true) {
      this.addDiagnostic('info', 'Clone session cancelled');
      return result;
    }
    this.state = { ...resetControllerProjection(this.state), draft: '' };
    this.fire();
    await this.reconcile();
    return result;
  }

  public async getForkMessages(): Promise<JsonObject[]> {
    const result = await this.requireClient().getForkMessages();
    return Array.isArray(result?.messages) ? (result.messages as JsonObject[]) : [];
  }

  public async copyLastAssistantText(): Promise<string | null> {
    const result = await this.requireClient().getLastAssistantText();
    return typeof result?.text === 'string' ? result.text : null;
  }

  public get piCommandsReady(): boolean {
    return (
      !!this.supervisor.currentClient && ['ready', 'busy'].includes(this.state.connectionState)
    );
  }

  private catalogRequest = 0;

  public async getPiCommands(): Promise<JsonObject[]> {
    const request = (this.catalogRequest = (this.catalogRequest ?? 0) + 1);
    const client = this.supervisor.currentClient;
    const valid = this.captureLocalCommandOrigin();
    if (!client) return mergeLocalCommands([]);
    const result = await client.getCommands();
    if (!valid() || request !== this.catalogRequest) {
      throw new Error('Obsolete command catalog request');
    }
    const commands = mergeLocalCommands(
      Array.isArray(result?.commands) ? (result.commands as JsonObject[]) : []
    );
    this.state = { ...this.state, commands };
    this.fire();
    return commands;
  }

  public async respondExtensionUi(response: JsonObject): Promise<void> {
    await this.requireClient().respondExtensionUi(response);
  }

  public applyExtensionUiRequest(request: ExtensionUiRequest): void {
    this.state = reduceExtensionUiRequest(this.state, request);
    this.extensionUiEmitter.fire(request);
    this.fire();
  }

  public completeExtensionUiRequest(id: string): void {
    this.state = {
      ...this.state,
      pendingUi: this.state.pendingUi.filter((item) => item.id !== id),
    };
    this.fire();
  }

  public setDraft(draft: string, options?: { silent?: boolean }): void {
    this.state = { ...this.state, draft };
    if (!options?.silent) {
      this.fire();
    }
  }

  public dispose(): void {
    this.assertNoManualCompaction();
    this.authDisposed = true;
    this.changeEmitter.fire(this.state);
    cancelModelOperations(this);
    this.disarmSessionFileWatcher();
    void this.stop();
    this.supervisor.dispose();
    this.changeEmitter.dispose();
    this.extensionUiEmitter.dispose();
  }

  private requireClient() {
    const client = this.supervisor.currentClient;
    if (!client) {
      throw new Error('Pi is not started for this workspace');
    }
    return client;
  }

  private fire(): void {
    // Durable audit trail of the connection lifecycle so "can't type / stuck
    // not-ready" issues (e.g. the Windows version-probe fault) are always
    // explainable from More → Show Logs.
    if (this.state.connectionState !== this.lastLoggedConnectionState) {
      this.logger.info(
        `Connection for '${this.folder.name}': ` +
          `${this.lastLoggedConnectionState ?? 'init'} → ${this.state.connectionState}` +
          (this.state.state.sessionFile ? ` [session=${this.state.state.sessionFile}]` : '')
      );
      this.lastLoggedConnectionState = this.state.connectionState;
    }
    // Any time we're actively working (generating/compacting) we are writing to
    // the session file; record it so our own writes don't trigger a live-reload.
    if (this.state.connectionState === 'busy') {
      this.selfWriteAt = Date.now();
    }
    this.changeEmitter.fire(this.state);
  }

  private onEvent(event: RpcEvent): void {
    if (event.type === 'compaction_end' && event.errorMessage)
      event = { ...event, errorMessage: 'Compaction failed or was cancelled.' };
    let next = this.state;
    if (!isKnownEventType(String(event.type))) {
      const detail = JSON.stringify(redactJsonValue(event), null, 2);
      const boundedDetail = detail.length > 2000 ? `${detail.slice(0, 2000)}…` : detail;
      this.logger.warn(`Compatibility event ${String(event.type)} ${boundedDetail}`);
      next = this.appendDiagnostic(
        next,
        'info',
        `Compatibility event: ${String(event.type)}`,
        boundedDetail
      );
    }
    this.state = reduceEvent(next, event);
    this.fire();
    // When a run settles, resync the transcript from the authoritative
    // get_messages list. Streaming events are keyed heuristically (Pi messages
    // have no id), so this guarantees the finished conversation is exactly what
    // Pi holds — no duplicated or partial bubbles.
    if (event.type === 'agent_end' || event.type === 'agent_settled') {
      void this.refreshMessages().catch(() => {
        /* best-effort resync; live state already rendered */
      });
    }
    if (event.type === 'agent_settled') {
      void this.maybeAutoCompact().catch(() => {
        /* best-effort; never let auto-compaction break the turn */
      });
    }
    // Resilience: after a compaction (auto or manual), resync state + transcript
    // so the chat resumes cleanly on the rebuilt context.
    if (event.type === 'compaction_end') {
      void this.refreshState().catch(() => {});
      void this.refreshMessages().catch(() => {});
    }
  }

  private autoCompactInFlight = false;
  /**
   * Auto-compact once context usage crosses the configured threshold, then let
   * the conversation continue on the compacted context. Pi has its own
   * near-full auto-compaction; this triggers earlier at a user-chosen percent.
   */
  private async maybeAutoCompact(): Promise<void> {
    const settings = getSettings();
    if (settings.autoCompactMode !== 'auto') {
      return;
    }
    const threshold = Math.min(95, Math.max(10, settings.autoCompactPercent));
    if (this.autoCompactInFlight || this.state.state.isCompacting === true) {
      return;
    }
    const stats = await this.requireClient()
      .getSessionStats()
      .catch(() => undefined);
    const percent = this.contextUsagePercent(stats);
    if (percent === undefined || percent < threshold) {
      return;
    }
    this.autoCompactInFlight = true;
    try {
      this.logger.info(
        `Auto-compacting: context ${percent.toFixed(0)}% >= ${threshold}% of the model's max context`
      );
      await this.compact();
      await this.refreshState();
      await this.refreshMessages();
      // Resume whatever task was underway on the freshly compacted context.
      if (settings.autoCompactResumeTask) {
        this.logger.info('Resuming task after auto-compaction');
        await this.prompt('Continue.');
      }
    } finally {
      this.autoCompactInFlight = false;
    }
  }

  /**
   * Context usage as a percent of the current model's max context window.
   * Prefers Pi's reported `contextUsage.percent` (already relative to the
   * model's window); otherwise computes it from the used tokens and the
   * auto-detected `model.contextWindow` (max tokens the model supports).
   */
  private contextUsagePercent(stats: JsonObject | undefined): number | undefined {
    const context =
      stats && typeof stats.contextUsage === 'object' && stats.contextUsage !== null
        ? (stats.contextUsage as JsonObject)
        : undefined;
    if (typeof context?.percent === 'number') {
      return context.percent;
    }
    const asNum = (value: unknown): number | undefined =>
      typeof value === 'number' && Number.isFinite(value) ? value : undefined;
    const tokens =
      stats && typeof stats.tokens === 'object' && stats.tokens !== null
        ? (stats.tokens as JsonObject)
        : undefined;
    const model = this.state.state.model;
    const max =
      asNum(context?.max) ??
      asNum(context?.total) ??
      asNum(context?.contextWindow) ??
      (model && typeof model.contextWindow === 'number' ? model.contextWindow : undefined);
    const used = asNum(context?.used) ?? asNum(context?.tokens) ?? asNum(tokens?.total);
    if (max && used && max > 0) {
      return (used / max) * 100;
    }
    return undefined;
  }

  private onExtensionUi(request: ExtensionUiRequest): void {
    this.applyExtensionUiRequest(request);
  }

  private addDiagnostic(
    kind: 'info' | 'warning' | 'error',
    message: string,
    detail?: string
  ): void {
    this.state = this.appendDiagnostic(this.state, kind, message, detail);
    this.fire();
  }

  /** Public log passthrough so UI flows (e.g. inline edit) can trace to the Pi output channel. */
  public log(level: 'info' | 'warn' | 'error', message: string): void {
    if (level === 'warn') {
      this.logger.warn(message);
    } else if (level === 'error') {
      this.logger.error(message);
    } else {
      this.logger.info(message);
    }
  }

  private appendDiagnostic(
    state: ControllerState,
    kind: 'info' | 'warning' | 'error',
    message: string,
    detail?: string
  ): ControllerState {
    return {
      ...state,
      diagnostics: [
        ...state.diagnostics.slice(-99),
        { id: `${kind}-${Date.now()}`, kind, message, detail, timestamp: Date.now() },
      ],
    };
  }

  private async restartAfterBackoff(): Promise<void> {
    const delayMs = Math.min(1000 * 2 ** (this.restartAttempts - 1), 5000);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    try {
      await this.start();
    } catch (error) {
      this.addDiagnostic(
        'error',
        'Automatic restart failed',
        error instanceof Error ? error.message : String(error)
      );
    }
  }
}
