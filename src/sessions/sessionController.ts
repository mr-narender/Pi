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
import { canonicalizeSessionPath } from './paths';

export class SessionController implements vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<ControllerState>();
  private readonly extensionUiEmitter = new vscode.EventEmitter<ExtensionUiRequest>();
  private readonly supervisor: PiProcessSupervisor;
  private readonly settings: PiRpcSettings;
  private state: ControllerState;
  private restartAttempts = 0;
  private stopping = false;

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
      throw new Error('Virtual workspaces are unsupported for Pi RPC');
    }
    this.stopping = false;
    this.state = {
      ...this.state,
      state: { ...this.state.state, sessionFile },
      connectionState: 'starting',
    };
    this.fire();
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
    await this.reconcile();
    this.restartAttempts = 0;
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
    ]);
    const sessionState = mergeSessionState(this.state.state, (state ?? {}) as SessionState);
    this.state = {
      ...this.state,
      connectionState: sessionState.isStreaming || sessionState.isCompacting ? 'busy' : 'ready',
      state: sessionState,
      messages: Array.isArray(messages?.messages) ? (messages.messages as JsonObject[]) : [],
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
    this.fire();
  }

  public async prompt(
    message: string,
    mode: 'prompt' | 'steer' | 'followUp' = 'prompt',
    images: JsonObject[] = []
  ): Promise<void> {
    const client = this.requireClient();
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
    const result = await this.requireClient().switchSession(canonical);
    if (result?.cancelled === true) {
      this.addDiagnostic('info', 'Switch session cancelled');
      return result;
    }
    this.state = resetControllerProjection(this.state);
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

  public setDraft(draft: string): void {
    this.state = { ...this.state, draft };
    this.fire();
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
      throw new Error('Pi RPC is not started for this workspace');
    }
    return client;
  }

  private fire(): void {
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
