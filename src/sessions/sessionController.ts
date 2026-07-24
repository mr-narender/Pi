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
import { open, stat } from 'node:fs/promises';
import { canonicalizeSessionPath } from './paths';
import { describeShape, extractMessageArray } from './reconcileShape';

export class SessionController implements vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<ControllerState>();
  private readonly extensionUiEmitter = new vscode.EventEmitter<ExtensionUiRequest>();
  private readonly supervisor: PiProcessSupervisor;
  private readonly settings: PiRpcSettings;
  private state: ControllerState;
  private restartAttempts = 0;
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
    this.state = {
      ...this.state,
      state: { ...this.state.state, sessionFile },
      connectionState: 'starting',
    };
    this.fire();
    try {
      const client = await this.supervisor.start(sessionFile);
      client.onEvent((event) => this.onEvent(event));
      client.onExtensionUi((request) => this.onExtensionUi(request));
      client.onResponseFailure((response) => {
        this.addDiagnostic(
          response.command === 'parse' ? 'error' : 'warning',
          `RPC response failed: ${response.command}`,
          response.success ? '' : response.error
        );
      });
      client.onProtocolFault((error) =>
        this.addDiagnostic('error', 'Protocol fault', error.message)
      );
      client.onDisconnected((error) =>
        this.addDiagnostic('warning', 'Disconnected', error.message)
      );
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
      this.logger.info(
        `Pi is ready for '${this.folder.name}' (state=${this.state.connectionState})`
      );
      this.restartAttempts = 0;
    } catch (error) {
      // Surface the exact reason clearly: log it, record it as a diagnostic, and
      // move to the 'faulted' state so the chat shows a recoverable error.
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Pi failed to start for '${this.folder.name}'`, error);
      this.addDiagnostic('error', 'Pi failed to start', message);
      this.state = { ...this.state, connectionState: 'faulted' };
      this.fire();
      throw error instanceof Error ? error : new Error(message);
    }
  }

  public async stop(): Promise<void> {
    this.stopping = true;
    await this.supervisor.stop();
    this.state = { ...this.state, connectionState: 'stopped' };
    this.fire();
  }

  public async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  public async reconcile(): Promise<void> {
    const client = this.requireClient();
    const [state, messages, entries, tree, commands, stats] = await Promise.all([
      client.getState(),
      client.getMessages(),
      client.getEntries(),
      client.getTree(),
      client.getCommands(),
      client.getSessionStats(),
    ]).catch((error: unknown) => {
      // A reconcile failure (timeout, protocol fault) is why a tab can be stuck
      // in 'handshaking' — always record it so it's explainable from the logs.
      this.logger.error(`Reconcile failed for '${this.folder.name}'`, error);
      throw error instanceof Error ? error : new Error(String(error));
    });
    const sessionState = mergeSessionState(this.state.state, (state ?? {}) as SessionState);
    // Tolerant extraction: prefer the documented `messages` array, but fall back
    // to a bare array or common alternates so a shape difference across Pi
    // versions doesn't render an empty transcript for a resumed session.
    const messageList = extractMessageArray(messages);
    this.state = {
      ...this.state,
      connectionState: sessionState.isStreaming || sessionState.isCompacting ? 'busy' : 'ready',
      state: sessionState,
      messages: messageList,
      entries: Array.isArray(entries?.entries) ? (entries.entries as JsonObject[]) : [],
      tree: Array.isArray(tree?.tree) ? (tree.tree as JsonObject[]) : [],
      commands: Array.isArray(commands?.commands) ? (commands.commands as JsonObject[]) : [],
      lastSessionStats: (stats ?? undefined) as JsonObject | undefined,
      leafId:
        typeof entries?.leafId === 'string'
          ? entries.leafId
          : typeof tree?.leafId === 'string'
            ? tree.leafId
            : null,
    };
    // Explain exactly what Pi returned so an "empty transcript on resume" is
    // diagnosable: which call held the data, and how many.
    this.logger.info(
      `Reconciled '${this.folder.name}': state=${this.state.connectionState}, ` +
        `messages=${messageList.length} (getMessages ${describeShape(messages)}), ` +
        `entries=${this.state.entries.length} (${describeShape(entries)}), ` +
        `tree=${this.state.tree.length} (${describeShape(tree)}), ` +
        `session=${this.state.state.sessionFile ?? '(none)'}`
    );
    // We now hold the full transcript; the file tail beyond this is external.
    await this.syncFileReadOffset();
    this.fire();
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
   * Silently append messages a terminal added to the SAME session file, by
   * reading only the new tail bytes and appending unseen messages — no reload,
   * no "Loading chat…" flash, no connection-state change. Idle-only; throttled
   * by the caller. Dedupes by message id.
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
    if (size <= this.lastReadFileSize) {
      if (size < this.lastReadFileSize) {
        this.lastReadFileSize = size; // file was rewritten/shrank
      }
      return;
    }
    const length = size - this.lastReadFileSize;
    const buffer = Buffer.alloc(length);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(file, 'r');
      await handle.read(buffer, 0, length, this.lastReadFileSize);
    } catch {
      return;
    } finally {
      await handle?.close();
    }
    const text = buffer.toString('utf8');
    const lastNewline = text.lastIndexOf('\n');
    if (lastNewline < 0) {
      return; // no complete line appended yet
    }
    const complete = text.slice(0, lastNewline);
    this.lastReadFileSize += Buffer.byteLength(complete, 'utf8') + 1;

    const existingIds = new Set(
      this.state.messages
        .map((message) => (typeof message.id === 'string' ? message.id : undefined))
        .filter((id): id is string => Boolean(id))
    );
    const additions: JsonObject[] = [];
    for (const line of complete.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      let entry: unknown;
      try {
        entry = JSON.parse(trimmed);
      } catch {
        continue;
      }
      const record = entry as { type?: unknown; message?: unknown } | null;
      if (record?.type === 'message' && record.message && typeof record.message === 'object') {
        const message = record.message as JsonObject;
        const id = typeof message.id === 'string' ? message.id : undefined;
        if (id && existingIds.has(id)) {
          continue;
        }
        if (id) {
          existingIds.add(id);
        }
        additions.push(message);
      }
    }
    if (additions.length === 0) {
      return;
    }
    this.logger.info(
      `Silently appended ${additions.length} external message(s) to '${this.folder.name}'`
    );
    this.state = { ...this.state, messages: [...this.state.messages, ...additions] };
    this.fire();
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
    const threshold = getSettings().autoCompactThreshold;
    if (!threshold || threshold <= 0 || threshold >= 100) {
      return;
    }
    if (this.autoCompactInFlight || this.state.state.isCompacting === true) {
      return;
    }
    const stats = await this.requireClient()
      .getSessionStats()
      .catch(() => undefined);
    const context =
      stats && typeof stats.contextUsage === 'object' && stats.contextUsage !== null
        ? (stats.contextUsage as JsonObject)
        : undefined;
    const percent = typeof context?.percent === 'number' ? context.percent : undefined;
    if (percent === undefined || percent < threshold) {
      return;
    }
    this.autoCompactInFlight = true;
    try {
      this.logger.info(`Auto-compacting: context ${percent}% >= ${threshold}% threshold`);
      await this.compact();
      await this.refreshState();
      await this.refreshMessages();
    } finally {
      this.autoCompactInFlight = false;
    }
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
