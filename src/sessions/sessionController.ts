import * as vscode from 'vscode';
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

  public get generation(): number {
    return this.supervisor.currentGeneration;
  }

  public async start(sessionFile = this.state.state.sessionFile): Promise<void> {
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
        response.success ? '' : response.error
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
    const sessionState = mergeSessionState(this.state.state, (state ?? {}) as SessionState);
    const sessionFile =
      typeof sessionState.sessionFile === 'string'
        ? sessionState.sessionFile
        : typeof this.state.state.sessionFile === 'string'
          ? this.state.state.sessionFile
          : undefined;
    const messageList = sessionFile ? await this.readRecentSessionMessages(sessionFile) : [];
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
      commands: Array.isArray(commands?.commands) ? (commands.commands as JsonObject[]) : [],
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
    // The local tail read above includes EVERY branch stored in the session
    // file, so a forked session would resurrect the dropped branch on any
    // reconcile (session open/switch/focus). Correct the transcript from Pi's
    // authoritative ACTIVE branch over RPC — in the background so resume stays
    // instant and this never blocks or fails the load.
    if (this.state.connectionState === 'ready') {
      void this.refreshMessages().catch(() => {
        /* best-effort; the local tail is already painted */
      });
    }
  }

  private async readRecentSessionMessages(sessionFile: string): Promise<JsonObject[]> {
    const limit = Math.max(50, this.settings.maxTranscriptItems);
    const records: SessionRecord[] = [];
    try {
      const input = createReadStream(sessionFile, { encoding: 'utf8' });
      const lines = createInterface({ input, crlfDelay: Infinity });
      for await (const line of lines) {
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
    await this.requireClient().abort();
  }

  public async newSession(parentSession?: string): Promise<JsonObject | undefined> {
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
    this.state = {
      ...this.state,
      messages: Array.isArray(data?.messages) ? (data.messages as JsonObject[]) : [],
    };
    this.fire();
  }

  public async selectModel(provider: string, modelId: string): Promise<void> {
    await this.requireClient().setModel(provider, modelId);
    await this.refreshState();
  }

  public async cycleModel(): Promise<void> {
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

  public async getAvailableModels(): Promise<JsonObject[]> {
    const data = await this.requireClient().getAvailableModels();
    return Array.isArray(data?.models) ? (data.models as JsonObject[]) : [];
  }

  public async setThinkingLevel(level: string): Promise<void> {
    await this.requireClient().setThinkingLevel(level);
    await this.refreshState();
  }

  public async cycleThinkingLevel(): Promise<void> {
    const data = await this.requireClient().cycleThinkingLevel();
    if (data && typeof data.level === 'string') {
      this.state = { ...this.state, state: { ...this.state.state, thinkingLevel: data.level } };
      this.fire();
    }
    await this.refreshState();
  }

  public async setSteeringMode(mode: string): Promise<void> {
    await this.requireClient().setSteeringMode(mode);
    await this.refreshState();
  }

  public async setFollowUpMode(mode: string): Promise<void> {
    await this.requireClient().setFollowUpMode(mode);
    await this.refreshState();
  }

  public async compact(customInstructions?: string): Promise<JsonObject | undefined> {
    this.selfWriteAt = Date.now();
    return this.requireClient().compact(customInstructions);
  }

  public async toggleAutoCompaction(): Promise<void> {
    await this.requireClient().setAutoCompaction(
      !(this.state.state.autoCompactionEnabled === true)
    );
    await this.refreshState();
  }

  public async toggleAutoRetry(enabled: boolean): Promise<void> {
    await this.requireClient().setAutoRetry(enabled);
  }

  public async abortRetry(): Promise<void> {
    await this.requireClient().abortRetry();
  }

  public async runBash(
    command: string,
    excludeFromContext = false
  ): Promise<JsonObject | undefined> {
    return this.requireClient().bash(command, excludeFromContext);
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
    this.selfWriteAt = Date.now();
    await this.requireClient().setSessionName(name);
    await this.refreshState();
  }

  public async showSessionStats(): Promise<JsonObject | undefined> {
    const data = await this.requireClient().getSessionStats();
    this.state = { ...this.state, lastSessionStats: data };
    this.fire();
    return data;
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
    const canonical = await canonicalizeSessionPath(this.folder.uri.fsPath, sessionPath);
    this.logger.info(`Resuming session ${canonical} for '${this.folder.name}'`);
    // Instant loading feedback: clear the current transcript and switch to a
    // 'handshaking' state so the webview shows the "Loading chat…" loader right
    // away, instead of showing the PREVIOUS chat until the RPC switch + reconcile
    // finish (which can take a while for large sessions).
    this.state = {
      ...resetControllerProjection(this.state),
      connectionState: 'handshaking',
      state: { ...this.state.state, sessionFile: canonical },
    };
    this.fire();
    let result: JsonObject | undefined;
    try {
      // Ensure the RPC client is actually usable (handles the warm-start race
      // where connectionState is 'starting' but the client isn't created yet).
      await this.whenReady();
      result = await this.requireClient().switchSession(canonical);
    } catch (error) {
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
      this.addDiagnostic('info', 'Switch session cancelled');
      return result;
    }
    // Show the loading state while the transcript is fetched: clear the old
    // projection and mark the connection as handshaking so the webview renders
    // a spinner instead of an empty transcript during the reconcile.
    this.state = { ...resetControllerProjection(this.state), connectionState: 'handshaking' };
    this.fire();
    await this.reconcile();
    return result;
  }

  public async fork(entryId: string): Promise<JsonObject | undefined> {
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

  public async getPiCommands(): Promise<JsonObject[]> {
    const result = await this.requireClient().getCommands();
    const commands = Array.isArray(result?.commands) ? (result.commands as JsonObject[]) : [];
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
