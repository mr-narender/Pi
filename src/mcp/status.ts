import { redactText } from '../diagnostics/redaction';

export interface McpStatusSnapshot {
  status: 'unchecked' | 'checking' | 'checked' | 'none' | 'unsupported' | 'unknown';
  checkedAt?: number;
  servers: Array<{ name: string; state: string; exposure: string; tools?: number }>;
  details?: string;
}

export function parseMcpStatus(value: unknown): McpStatusSnapshot {
  const unknown = (): McpStatusSnapshot => ({ status: 'unknown', servers: [] });
  if (!value || typeof value !== 'object') return unknown();
  const record = value as Record<string, unknown>;
  if (record.contract !== 1) return unknown();
  if (record.status === 'unsupported') return { status: 'unsupported', servers: [] };
  if (
    record.status !== 'checked' ||
    !Array.isArray(record.notifications) ||
    record.notifications.length !== 1
  )
    return unknown();
  const notification = record.notifications[0] as Record<string, unknown> | undefined;
  if (!notification || notification.level !== 'info' || typeof notification.message !== 'string')
    return unknown();
  const raw = notification.message;
  if (raw.length > 24000) return unknown();
  const details = redactText(
    raw
      .split('\n')
      .map((line) =>
        /(?:authorization|cookie|password|secret|api[_-]?key|(?:access|refresh)[_-]?token)\b|\btoken\b\s*[:=]/i.test(
          line
        )
          ? '[Credential detail omitted]'
          : line
      )
      .join('\n')
      .replace(/https?:\/\/[^\s<>]+/gi, '[URL omitted]')
      .replace(/\bBasic\s+\S+/gi, '[REDACTED]')
      .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
  ).slice(0, 12000);
  const result: McpStatusSnapshot = {
    status: 'checked',
    servers: [],
    details,
    checkedAt:
      typeof record.checkedAt === 'number' &&
      Number.isFinite(record.checkedAt) &&
      record.checkedAt > 0
        ? record.checkedAt
        : undefined,
  };
  if (
    raw.length > 24000 ||
    /[\u0000-\u0008\u000b-\u001f\u007f]/.test(raw) ||
    result.checkedAt === undefined
  )
    return { ...result, status: 'unknown' };
  if (/^No MCP servers configured\. Add them to .+mcp\.json or \.pi\/mcp\.json\.$/.test(raw))
    return { ...result, status: 'none', details: undefined };
  let tail = false;
  const names = new Set<string>();
  for (const line of raw.split('\n')) {
    if (tail || /^ {4}/.test(line)) continue;
    const match =
      /^([A-Za-z0-9_-]{1,80}): (disabled|starting|connecting|connected|failed|closed|disconnected, reconnects on next call|needs sign-in, run \/mcp login \1)(?:, (\d{1,6}) tools)? \((codemode|deferred|direct|hidden)\)$/.exec(
        line
      );
    if (!match && /^(?:config error|overridden): /.test(line)) {
      tail = true;
      continue;
    }
    if (
      !match ||
      names.has(match[1]!) ||
      result.servers.length >= 32 ||
      (match[3] !== undefined && match[2] !== 'connected')
    )
      return { ...result, status: 'unknown', servers: [] };
    names.add(match[1]!);
    result.servers.push({
      name: match[1]!,
      state: match[2]!.startsWith('needs sign-in')
        ? 'needs-auth'
        : match[2]!.startsWith('disconnected')
          ? 'disconnected'
          : match[2]!,
      exposure: match[4]!,
      tools: match[3] === undefined ? undefined : Number(match[3]),
    });
  }
  return result.servers.length ? result : { ...result, status: 'unknown' };
}
