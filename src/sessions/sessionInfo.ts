import type { JsonObject } from '../rpc/protocol';

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const finite = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

/** Explicit public stats/metadata whitelist. Never copy transcripts or provider objects. */
export function projectSessionInfo(value: unknown, metadata: unknown = value): JsonObject {
  const stats = record(value);
  const state = record(metadata);
  const result: JsonObject = {};
  for (const key of ['sessionId', 'sessionFile', 'sessionName']) {
    if (typeof state[key] === 'string') result[key] = state[key];
  }
  for (const key of [
    'totalEntries',
    'userMessages',
    'assistantMessages',
    'toolCalls',
    'toolResults',
    'totalMessages',
    'cost',
  ]) {
    const number = finite(stats[key]);
    if (number !== undefined) result[key] = number;
  }
  const tokens = record(stats.tokens);
  const projected: JsonObject = {};
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'total']) {
    const number = finite(tokens[key]);
    if (number !== undefined) projected[key] = number;
  }
  result.tokens = projected;
  const context = record(stats.contextUsage);
  result.contextUsage = {
    tokens: finite(context.tokens) ?? null,
    contextWindow: finite(context.contextWindow) ?? null,
    percent: finite(context.percent) ?? null,
  };
  return result;
}
