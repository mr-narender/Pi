import { createRequestId, RpcTransport } from './transport';
import { parsePreferencesSnapshot, type PreferenceValue } from './preferences';
import {
  parseScopedModelsSnapshot,
  type ScopedModelsSnapshot,
  type ScopedModelRef,
} from './protocol';
import type {
  ExtensionUiRequest,
  JsonObject,
  RpcCommandType,
  RpcEvent,
  RpcResponse,
  SessionState,
} from './protocol';

export interface RpcClientOptions {
  shortTimeoutMs: number;
  longTimeoutMs: number;
}

/** Local-only receipt: never inferred from a remote response or error. */
export interface LifecycleDispatch {
  attempted: boolean;
  valid: () => boolean;
}

export class RpcClient {
  private counter = 0;

  public constructor(
    private readonly generation: number,
    private readonly transport: RpcTransport,
    private readonly options: RpcClientOptions
  ) {}

  public onEvent(listener: (event: RpcEvent) => void): void {
    this.transport.on('event', listener);
  }

  public onExtensionUi(listener: (request: ExtensionUiRequest) => void): void {
    this.transport.on('extensionUi', listener);
  }

  public onProtocolFault(listener: (error: Error) => void): void {
    this.transport.on('protocolFault', listener);
  }

  public onDisconnected(listener: (error: Error) => void): void {
    this.transport.on('disconnected', listener);
  }

  public onStderr(listener: (text: string) => void): void {
    this.transport.on('stderr', listener);
  }

  public onResponseFailure(listener: (response: RpcResponse) => void): void {
    this.transport.on('responseFailure', listener);
  }

  public async prompt(
    message: string,
    images?: JsonObject[],
    streamingBehavior?: 'steer' | 'followUp'
  ): Promise<void> {
    await this.command('prompt', { message, images, streamingBehavior }, 'long');
  }

  public async steer(message: string, images?: JsonObject[]): Promise<void> {
    await this.command('steer', { message, images }, 'short');
  }

  public async followUp(message: string, images?: JsonObject[]): Promise<void> {
    await this.command('follow_up', { message, images }, 'short');
  }

  public async abort(): Promise<void> {
    await this.command('abort', {}, 'short');
  }

  public async replaceChat(
    name: 'new' | 'resume' | 'fork' | 'clone' | 'import',
    target: string | undefined,
    origin: JsonObject,
    dispatch?: LifecycleDispatch
  ): Promise<JsonObject | undefined> {
    if (dispatch) dispatch.attempted = false;
    const caps = await this.command('get_capabilities', {}, 'short');
    if (caps?.protocol !== 1 || caps.lifecycleProjection !== 1)
      throw new Error(
        'This backend has no coherent lifecycle projection capability; nothing was applied.'
      );
    if (dispatch && !dispatch.valid()) throw new Error('The originating chat changed.');
    return this.command(
      name === 'new'
        ? 'new_session'
        : name === 'resume'
          ? 'switch_session'
          : name === 'import'
            ? 'import_session'
            : name,
      {
        guiLifecycle: true,
        origin,
        nonce: name === 'import' ? target : undefined,
        entryId: name === 'fork' ? target : undefined,
        sessionPath: name === 'resume' ? target : undefined,
      },
      'long',
      dispatch
    );
  }

  public async closeChat(
    origin?: JsonObject,
    dispatch?: LifecycleDispatch
  ): Promise<JsonObject | undefined> {
    if (dispatch) dispatch.attempted = false;
    const caps = await this.command('get_capabilities', {}, 'short');
    if (
      caps?.protocol !== 1 ||
      !['0.99.1', '0.99.2', '1.0.0'].includes(caps.sdkVersion as string) ||
      caps.closeChat !== true
    )
      throw new Error(
        'This backend has no acknowledged per-chat disposal API; chat was not closed.'
      );
    if (dispatch && !dispatch.valid()) throw new Error('The originating chat changed.');
    return this.command('close_chat', { origin, guiLifecycle: !!origin }, 'long', dispatch);
  }

  /** GUI SDK bridge, never sent optimistically to stock RPC. */
  public async engineCommand(
    type:
      | 'navigate_tree'
      | 'get_project_trust'
      | 'set_project_trust'
      | 'reload_session'
      | 'auth_providers'
      | 'auth_logout'
      | 'auth_login'
      | 'auth_poll'
      | 'auth_response'
      | 'delivery_payload'
      | 'import_prepare',
    origin: JsonObject,
    payload: JsonObject = {}
  ): Promise<JsonObject | undefined> {
    const caps = await this.command('get_capabilities', {}, 'short');
    const engine = caps?.engineCommands as JsonObject | undefined;
    if (
      caps?.protocol !== 1 ||
      !['0.99.1', '0.99.2', '1.0.0'].includes(caps.sdkVersion as string) ||
      engine?.contract !== 1 ||
      engine[type] !== true
    )
      throw new Error(`This backend does not support ${type}; nothing was applied.`);
    return this.command(type, { ...payload, origin, guiLifecycle: true }, 'long');
  }

  public async newSession(parentSession?: string): Promise<JsonObject | undefined> {
    return this.command('new_session', { parentSession }, 'long');
  }

  public async getState(timeout: 'short' | 'long' = 'short'): Promise<SessionState | undefined> {
    return this.command('get_state', {}, timeout) as Promise<SessionState | undefined>;
  }

  public async getMessages(): Promise<JsonObject | undefined> {
    return this.command('get_messages', {}, 'short');
  }

  public async setModel(provider: string, modelId: string): Promise<JsonObject | undefined> {
    return this.command('set_model', { provider, modelId }, 'short');
  }

  public async cycleModel(): Promise<JsonObject | undefined> {
    return this.command('cycle_model', {}, 'short');
  }

  public async getAvailableModels(): Promise<JsonObject | undefined> {
    return this.command('get_available_models', {}, 'short');
  }

  public async getPreferences() {
    let caps: JsonObject | undefined;
    try {
      caps = await this.command('get_capabilities', {}, 'short');
    } catch {
      throw new Error(
        '/settings engine preferences are unsupported by this backend; select a resolved Pi SDK 0.99.1, 0.99.2 or 1.0.0 installation.'
      );
    }
    const preference = caps?.preferences as JsonObject | undefined;
    if (
      caps?.protocol !== 1 ||
      !['0.99.1', '0.99.2', '1.0.0'].includes(caps.sdkVersion as string) ||
      preference?.contract !== 1 ||
      preference.read !== true ||
      preference.saveGlobal !== true
    )
      throw new Error('/settings engine preferences are unsupported by this backend.');
    return parsePreferencesSnapshot(await this.command('get_preferences', {}, 'short'));
  }

  public async savePreference(
    key: string,
    value: PreferenceValue,
    expectedRevision: string,
    confirmPaid: boolean
  ) {
    return parsePreferencesSnapshot(
      await this.command(
        'save_preference',
        { key, value, expectedRevision, confirmGlobal: true, confirmPaid },
        'short'
      )
    );
  }

  public async getScopedModels(): Promise<ScopedModelsSnapshot> {
    let caps: JsonObject | undefined;
    try {
      caps = await this.command('get_capabilities', {}, 'short');
    } catch {
      throw new Error(
        '/scoped-models is unsupported by this backend. Select a resolvable Pi SDK 0.99.1, 0.99.2 or 1.0.0 JavaScript installation; ordinary stock RPC operations remain available.'
      );
    }
    const scope = caps?.scopedModels as JsonObject | undefined;
    if (
      caps?.protocol !== 1 ||
      !['0.99.1', '0.99.2', '1.0.0'].includes(caps?.sdkVersion as string) ||
      !scope?.read ||
      !scope?.set ||
      !scope?.saveGlobal
    )
      throw new Error('The backend does not advertise supported scoped-model operations.');
    return parseScopedModelsSnapshot(await this.command('get_scoped_models', {}, 'short'));
  }

  public async setScopedModels(
    refs: ScopedModelRef[],
    expectedRevision: string,
    saveGlobal: boolean,
    replaceUnavailable = false
  ): Promise<ScopedModelsSnapshot> {
    return parseScopedModelsSnapshot(
      await this.command(
        saveGlobal ? 'save_scoped_models_default' : 'set_scoped_models',
        { refs, expectedRevision, replaceUnavailable },
        'short'
      )
    );
  }

  public async getThinkingCapabilities(): Promise<{ levels: string[]; revision: string }> {
    let caps: JsonObject | undefined;
    try {
      caps = await this.command('get_capabilities', {}, 'short');
    } catch {
      throw new Error(
        '/thinking is unsupported by this backend; use a resolved Pi SDK 0.99.1, 0.99.2 or 1.0.0 installation.'
      );
    }
    const thinking = caps?.thinking as JsonObject | undefined;
    if (
      caps?.protocol !== 1 ||
      !['0.99.1', '0.99.2', '1.0.0'].includes(caps?.sdkVersion as string) ||
      thinking?.contract !== 1 ||
      thinking.read !== true ||
      thinking.strictSet !== true
    )
      throw new Error('Backend thinking capabilities are unsupported.');
    const data = await this.command('get_available_thinking_levels', {}, 'short');
    const known = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
    if (
      !Array.isArray(data?.levels) ||
      !data.levels.length ||
      data.levels.some((l) => typeof l !== 'string' || !known.includes(l)) ||
      new Set(data.levels).size !== data.levels.length ||
      typeof data.revision !== 'string'
    )
      throw new Error('Invalid native thinking capabilities.');
    return { levels: data.levels as string[], revision: data.revision };
  }

  public async setThinkingLevel(level: string, expectedRevision?: string): Promise<void> {
    await this.command(
      'set_thinking_level',
      { level, ...(expectedRevision ? { expectedRevision } : {}) },
      'short'
    );
  }

  public async cycleThinkingLevel(): Promise<JsonObject | undefined> {
    return this.command('cycle_thinking_level', {}, 'short');
  }

  public async setSteeringMode(mode: string): Promise<void> {
    await this.command('set_steering_mode', { mode }, 'short');
  }

  public async setFollowUpMode(mode: string): Promise<void> {
    await this.command('set_follow_up_mode', { mode }, 'short');
  }

  public async compact(customInstructions?: string): Promise<JsonObject | undefined> {
    return this.command('compact', { customInstructions }, 'long');
  }

  public async setAutoCompaction(enabled: boolean): Promise<void> {
    await this.command('set_auto_compaction', { enabled }, 'short');
  }

  public async setAutoRetry(enabled: boolean): Promise<void> {
    await this.command('set_auto_retry', { enabled }, 'short');
  }

  public async abortRetry(): Promise<void> {
    await this.command('abort_retry', {}, 'short');
  }

  public async bash(command: string, excludeFromContext = false): Promise<JsonObject | undefined> {
    return this.command('bash', { command, excludeFromContext }, 'long');
  }

  public async abortBash(): Promise<void> {
    await this.command('abort_bash', {}, 'short');
  }

  public async getSessionStats(
    timeout: 'short' | 'long' = 'short'
  ): Promise<JsonObject | undefined> {
    return this.command('get_session_stats', {}, timeout);
  }

  public async exportHtml(
    outputPath?: string,
    origin?: JsonObject
  ): Promise<JsonObject | undefined> {
    return this.command('export_html', { outputPath, ...(origin ? { origin } : {}) }, 'long');
  }

  public async exportJsonl(
    outputPath: string,
    origin?: JsonObject,
    valid: () => boolean = () => true
  ): Promise<JsonObject | undefined> {
    let caps: JsonObject | undefined;
    try {
      caps = await this.command('get_capabilities', {}, 'short');
    } catch {
      throw new Error(
        'This backend supports HTML export only; JSONL requires the native SDK host.'
      );
    }
    if (
      caps?.protocol !== 1 ||
      !['0.99.1', '0.99.2', '1.0.0'].includes(caps.sdkVersion as string) ||
      (caps.exports as JsonObject | undefined)?.jsonl !== true
    )
      throw new Error('Native JSONL export capability is unavailable.');
    if (!valid()) throw new Error('The originating chat changed; export cancelled.');
    return this.command('export_jsonl', { outputPath, origin }, 'long');
  }

  public async switchSession(sessionPath: string): Promise<JsonObject | undefined> {
    return this.command('switch_session', { sessionPath }, 'long');
  }

  public async fork(entryId: string): Promise<JsonObject | undefined> {
    return this.command('fork', { entryId }, 'long');
  }

  public async clone(): Promise<JsonObject | undefined> {
    return this.command('clone', {}, 'long');
  }

  public async getForkMessages(entryId?: string): Promise<JsonObject | undefined> {
    return this.command('get_fork_messages', { entryId }, 'short');
  }

  public async getEntries(since?: string): Promise<JsonObject | undefined> {
    return this.command('get_entries', { since }, 'short');
  }

  public async getTree(): Promise<JsonObject | undefined> {
    return this.command('get_tree', {}, 'short');
  }

  public async getLastAssistantText(): Promise<JsonObject | undefined> {
    return this.command('get_last_assistant_text', {}, 'short');
  }

  public async setSessionName(name: string): Promise<void> {
    await this.command('set_session_name', { name }, 'short');
  }

  public async getCommands(timeout: 'short' | 'long' = 'short'): Promise<JsonObject | undefined> {
    return this.command('get_commands', {}, timeout);
  }

  public async respondExtensionUi(response: JsonObject): Promise<void> {
    await this.transport.notify({ type: 'extension_ui_response', ...response });
  }

  private activeMutations = 0;
  private compactPending = false;
  public get hasCompactionConflict(): boolean {
    return this.compactPending || this.activeMutations > 0;
  }

  private async command<T extends JsonObject | undefined>(
    type: RpcCommandType,
    extra: JsonObject,
    timeoutClass: 'short' | 'long',
    dispatch?: LifecycleDispatch
  ): Promise<T> {
    if (dispatch && !dispatch.valid()) throw new Error('The originating chat changed.');
    const mutation = new Set<string>([
      'prompt',
      'steer',
      'follow_up',
      'bash',
      'navigate_tree',
      'switch_session',
      'new_session',
      'fork',
      'set_model',
      'set_scoped_models',
      'save_scoped_models_default',
      'set_thinking_level',
    ]).has(type);
    if (type === 'compact' && this.hasCompactionConflict)
      throw new Error('Compaction requires an idle session.');
    if (mutation && this.compactPending) throw new Error('Compaction is in progress.');
    if (type === 'compact') this.compactPending = true;
    if (mutation) this.activeMutations = (this.activeMutations || 0) + 1;
    const id = createRequestId(this.generation, ++this.counter);
    const timeoutMs =
      timeoutClass === 'short' ? this.options.shortTimeoutMs : this.options.longTimeoutMs;
    const request = { type, id, ...extra };
    // This is the first point where the native mutation can have been sent.
    if (dispatch) dispatch.attempted = true;
    const pending = this.transport.request(request);
    let timer: NodeJS.Timeout | undefined;
    try {
      const response = await Promise.race([
        pending,
        new Promise<RpcResponse>((_resolve, reject) => {
          timer = setTimeout(() => {
            const error = new Error(`Timed out waiting for ${type}`);
            this.transport.cancelPending(id, error);
            reject(error);
          }, timeoutMs);
        }),
      ]);
      if (!response.success) {
        throw new Error(response.error);
      }
      return response.data as T;
    } finally {
      if (type === 'compact') this.compactPending = false;
      if (mutation) this.activeMutations--;
      if (timer) {
        clearTimeout(timer);
      }
    }
  }
}
