import type { DiagnosticsLogger } from './logger';
import type { SessionController } from '../sessions/sessionController';

declare const __PI_BUILD__: string;

export interface SafeDiagnostics {
  schemaVersion: 1;
  guiVersion: string;
  capabilities: { localPreview: true; localCopy: true; localSave: true; rawLogs: false };
  active: {
    connectionState?: string;
    generation?: number;
    restartCount?: number;
    queue: { steering?: number; followUp?: number };
    thinkingLevel?: string;
    isStreaming?: boolean;
    isCompacting?: boolean;
    autoCompactionEnabled?: boolean;
    messageCount?: number;
    pendingMessageCount?: number;
    diagnosticCount?: number;
    eventCount?: number;
    uiRequestCount?: number;
    stats: {
      totalEntries?: number;
      totalMessages?: number;
      userMessages?: number;
      assistantMessages?: number;
      toolCalls?: number;
      toolResults?: number;
      cost?: number;
      tokens: {
        input?: number;
        output?: number;
        total?: number;
        cacheRead?: number;
        cacheWrite?: number;
      };
      contextUsage: { tokens?: number | null; contextWindow?: number; percent?: number } | null;
    };
  } | null;
}
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const finite = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
const count = (value: unknown) => {
  const n = finite(value);
  return n !== undefined && Number.isSafeInteger(n) ? n : undefined;
};
const length = (value: unknown) => (Array.isArray(value) ? value.length : undefined);
const boolean = (value: unknown) => (typeof value === 'boolean' ? value : undefined);
const enumeration = (value: unknown, known: readonly string[]) =>
  typeof value === 'string' && known.includes(value) ? value : undefined;

/** Closed projection, not redaction. Never read logs, settings, credentials,
 * model labels, session/folder identity, messages, errors or arbitrary DTO keys.
 * Cached statistics only: diagnostics must not start a host or mutate session state. */
export function createRedactedDiagnosticsExport(
  _logger: DiagnosticsLogger | undefined,
  controller: SessionController | undefined
): SafeDiagnostics {
  const snapshot = record(controller?.snapshot);
  const state = record(snapshot.state);
  const queue = record(snapshot.queue);
  const stats = record(snapshot.lastSessionStats);
  const tokens = record(stats.tokens);
  const context = record(stats.contextUsage);
  const build = typeof __PI_BUILD__ === 'string' ? __PI_BUILD__ : 'development';
  return {
    schemaVersion: 1,
    guiVersion: /^\d+\.\d+\.\d+$/.test(build) ? build : 'development',
    capabilities: { localPreview: true, localCopy: true, localSave: true, rawLogs: false },
    active: controller
      ? {
          connectionState: enumeration(snapshot.connectionState, [
            'unconfigured',
            'locating',
            'versionChecking',
            'starting',
            'handshaking',
            'ready',
            'busy',
            'faulted',
            'stopped',
            'unsupported',
          ]),
          generation: count(snapshot.generation),
          restartCount: count(snapshot.restartCount),
          queue: { steering: length(queue.steering), followUp: length(queue.followUp) },
          thinkingLevel: enumeration(state.thinkingLevel, [
            'off',
            'minimal',
            'low',
            'medium',
            'high',
            'xhigh',
          ]),
          isStreaming: boolean(state.isStreaming),
          isCompacting: boolean(state.isCompacting),
          autoCompactionEnabled: boolean(state.autoCompactionEnabled),
          messageCount: count(state.messageCount),
          pendingMessageCount: count(state.pendingMessageCount),
          diagnosticCount: length(snapshot.diagnostics),
          eventCount: length(snapshot.eventHistory),
          uiRequestCount: length(snapshot.uiHistory),
          stats: {
            totalEntries: count(stats.totalEntries),
            totalMessages: count(stats.totalMessages),
            userMessages: count(stats.userMessages),
            assistantMessages: count(stats.assistantMessages),
            toolCalls: count(stats.toolCalls),
            toolResults: count(stats.toolResults),
            cost: finite(stats.cost),
            tokens: {
              input: count(tokens.input),
              output: count(tokens.output),
              total: count(tokens.total),
              cacheRead: count(tokens.cacheRead),
              cacheWrite: count(tokens.cacheWrite),
            },
            contextUsage:
              stats.contextUsage === null
                ? null
                : {
                    tokens: context.tokens === null ? null : count(context.tokens),
                    contextWindow: count(context.contextWindow),
                    percent:
                      finite(context.percent) !== undefined && Number(context.percent) <= 100
                        ? finite(context.percent)
                        : undefined,
                  },
          },
        }
      : null,
  };
}
