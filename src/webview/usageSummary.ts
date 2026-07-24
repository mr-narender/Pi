// Pure (vscode-free) helpers to derive a compact usage summary from the
// session stats payload Pi returns via get_session_stats. Kept separate so it
// can be unit-tested in plain Node.

export interface UsageSummary {
  totalTokens: number;
  contextPercent?: number;
  cost?: number;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Extract totals from the raw stats object; returns undefined if nothing useful. */
export function summarizeUsage(stats: unknown): UsageSummary | undefined {
  const record = asRecord(stats);
  if (!record) {
    return undefined;
  }
  const tokens = asRecord(record.tokens) ?? {};
  const context = asRecord(record.contextUsage);
  const total = num(tokens.total);
  const cost = num(record.cost);
  const percent = context ? num(context.percent) : undefined;
  if (total === undefined && cost === undefined && percent === undefined) {
    return undefined;
  }
  return { totalTokens: total ?? 0, contextPercent: percent, cost };
}

/** Human-friendly token count: 950, 12.3k, 1.2M. */
export function formatTokens(count: number): string {
  if (count < 1000) {
    return String(Math.round(count));
  }
  if (count < 1_000_000) {
    return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k`;
  }
  return `${(count / 1_000_000).toFixed(1)}M`;
}

/** Short chip label, e.g. "45% · 12.3k · $0.02". Empty parts are dropped. */
export function formatUsageChip(usage: UsageSummary): string {
  const parts: string[] = [];
  if (typeof usage.contextPercent === 'number') {
    parts.push(`${Math.round(usage.contextPercent)}%`);
  }
  if (usage.totalTokens > 0) {
    parts.push(`${formatTokens(usage.totalTokens)} tok`);
  }
  if (typeof usage.cost === 'number' && usage.cost > 0) {
    parts.push(`$${usage.cost.toFixed(usage.cost < 1 ? 3 : 2)}`);
  }
  return parts.join(' · ');
}
