const SECRET_PATTERNS = [
  /(sk-[A-Za-z0-9_-]{10,})/g,
  /(Bearer\s+[A-Za-z0-9._-]+)/gi,
  /(Authorization\s*:\s*[^\s]+)/gi,
  /([A-Z_]*KEY\s*=\s*[^\s]+)/g,
  /(token\s*=\s*[^\s]+)/gi,
];

export function redactText(value: string): string {
  let redacted = value;
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, '[REDACTED]');
  }
  return redacted
    .replace(/([A-Za-z]:)?\/Users\/[^/\s]+/g, '[HOME]')
    .replace(/\/home\/[^/\s]+/g, '[HOME]');
}

export function redactJsonValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return redactText(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactJsonValue(item));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactJsonValue(item)])
    );
  }
  return value;
}
