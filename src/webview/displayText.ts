import { redactText } from '../diagnostics/redaction';

export function displayText(value: string, limit: number): string {
  const plain = value
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
  const redacted = redactText(
    plain.replace(/data:[^\s]+|[A-Za-z0-9+/]{128,}={0,2}/g, '[encoded data omitted]')
  );
  return redacted.length > limit ? `${redacted.slice(0, limit)}…` : redacted;
}
