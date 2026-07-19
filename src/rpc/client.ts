import { createRequestId, RpcTransport } from './transport';
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

  public async newSession(parentSession?: string): Promise<JsonObject | undefined> {
    return this.command('new_session', { parentSession }, 'long');
  }

  public async getState(): Promise<SessionState | undefined> {
    return this.command('get_state', {}, 'short') as Promise<SessionState | undefined>;
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

  public async setThinkingLevel(level: string): Promise<void> {
    await this.command('set_thinking_level', { level }, 'short');
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

  public async getSessionStats(): Promise<JsonObject | undefined> {
    return this.command('get_session_stats', {}, 'short');
  }

  public async exportHtml(outputPath?: string): Promise<JsonObject | undefined> {
    return this.command('export_html', { outputPath }, 'long');
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

  public async getCommands(): Promise<JsonObject | undefined> {
    return this.command('get_commands', {}, 'short');
  }

  public async respondExtensionUi(response: JsonObject): Promise<void> {
    await this.transport.notify({ type: 'extension_ui_response', ...response });
  }

  private async command<T extends JsonObject | undefined>(
    type: RpcCommandType,
    extra: JsonObject,
    timeoutClass: 'short' | 'long'
  ): Promise<T> {
    const id = createRequestId(this.generation, ++this.counter);
    const timeoutMs =
      timeoutClass === 'short' ? this.options.shortTimeoutMs : this.options.longTimeoutMs;
    const request = { type, id, ...extra };
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
      if (timer) {
        clearTimeout(timer);
      }
    }
  }
}
