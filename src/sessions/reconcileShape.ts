import type { JsonObject } from '../rpc/protocol';

/** Describe an RPC payload's shape for logs, e.g. `object{messages:array[42]}`. */
export function describeShape(value: unknown): string {
  if (Array.isArray(value)) {
    return `array[${value.length}]`;
  }
  if (value && typeof value === 'object') {
    const parts = Object.entries(value as Record<string, unknown>).map(([key, val]) => {
      if (Array.isArray(val)) {
        return `${key}:array[${val.length}]`;
      }
      return `${key}:${val === null ? 'null' : typeof val}`;
    });
    return `object{${parts.join(',')}}`;
  }
  return value === null ? 'null' : typeof value;
}

/** Pull the message list out of a getMessages payload, tolerant of shape drift. */
export function extractMessageArray(payload: unknown): JsonObject[] {
  if (Array.isArray(payload)) {
    return payload as JsonObject[];
  }
  const record = payload as Record<string, unknown> | null | undefined;
  for (const key of ['messages', 'items', 'entries', 'transcript']) {
    const candidate = record?.[key];
    if (Array.isArray(candidate)) {
      return candidate as JsonObject[];
    }
  }
  return [];
}
