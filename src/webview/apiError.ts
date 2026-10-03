// Parse a raw provider-failure string ("anthropic/claude-fable-5 failed: 429
// {json}") into structured fields for a proper error card — instead of
// dumping the raw JSON at the user. Never throws; falls back to the raw
// message untouched if the shape doesn't match (never hides information).
export interface ParsedApiError {
  provider?: string;
  model?: string;
  statusCode?: number;
  errorType?: string;
  message: string;
  requestId?: string;
  raw: string;
}

export function parseProviderError(raw: string): ParsedApiError {
  const trimmed = raw.trim();
  const head = /^([\w.-]+\/[\w.:-]+)\s+failed:\s*(\d{3})?\s*([\s\S]*)$/.exec(trimmed);
  if (!head) {
    return { message: trimmed, raw: trimmed };
  }
  const [, providerModel, statusText, rest = ''] = head;
  const [provider, ...modelParts] = (providerModel ?? '').split('/');
  const model = modelParts.length > 0 ? modelParts.join('/') : undefined;
  const statusCode = statusText ? Number.parseInt(statusText, 10) : undefined;
  let errorType: string | undefined;
  let message = rest.trim() || trimmed;
  let requestId: string | undefined;

  const jsonMatch = /\{[\s\S]*\}/.exec(rest);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
      const errorObj =
        parsed.error && typeof parsed.error === 'object'
          ? (parsed.error as Record<string, unknown>)
          : parsed;
      if (typeof errorObj.type === 'string') {
        errorType = errorObj.type;
      }
      if (typeof errorObj.message === 'string') {
        message = errorObj.message;
      }
      if (typeof parsed.request_id === 'string') {
        requestId = parsed.request_id;
      } else if (typeof errorObj.request_id === 'string') {
        requestId = errorObj.request_id as string;
      }
    } catch {
      // Malformed/partial JSON — keep the plain-text remainder as the message.
    }
  }

  return {
    provider: provider || undefined,
    model,
    statusCode,
    errorType,
    message,
    requestId,
    raw: trimmed,
  };
}

/** Human label + retry-worthiness for a status/error-type pair. */
export function friendlyApiStatus(
  statusCode: number | undefined,
  errorType: string | undefined
): { label: string; severity: 'warning' | 'error' } {
  const type = (errorType ?? '').toLowerCase();
  if (statusCode === 429 || type.includes('rate_limit')) {
    return { label: 'Rate Limited', severity: 'warning' };
  }
  if (statusCode === 529 || type.includes('overloaded')) {
    return { label: 'Overloaded', severity: 'warning' };
  }
  if (statusCode === 502 || statusCode === 503) {
    return { label: 'Service Unavailable', severity: 'warning' };
  }
  if (statusCode === 401 || type.includes('authentication')) {
    return { label: 'Authentication Error', severity: 'error' };
  }
  if (statusCode === 403 || type.includes('permission')) {
    return { label: 'Permission Denied', severity: 'error' };
  }
  if (statusCode === 404 || type.includes('not_found')) {
    return { label: 'Not Found', severity: 'error' };
  }
  if (statusCode === 400 || type.includes('invalid_request')) {
    return { label: 'Invalid Request', severity: 'error' };
  }
  if (statusCode === 413 || type.includes('too_large')) {
    return { label: 'Request Too Large', severity: 'error' };
  }
  if (statusCode !== undefined && statusCode >= 500) {
    return { label: 'Server Error', severity: 'error' };
  }
  return { label: statusCode ? `Error ${statusCode}` : 'Error', severity: 'error' };
}
