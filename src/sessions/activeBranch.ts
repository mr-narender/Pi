// Pi session files store the ENTIRE branch tree in one JSONL file: entries are
// linked by `id`/`parentId` (session-format v2+). After a fork there are
// multiple branches in the same file, so naively collecting every `message`
// record would resurrect dropped branches. This selects only the ACTIVE branch:
// walk from the most-recently-written entry (the active tip) up through
// `parentId` to the root, keeping the message entries in chronological order.
//
// Backward-compatible: old (v1) sessions have no `id`/`parentId`; in that case
// we fall back to the linear list of all message records.

export interface SessionRecord {
  type?: unknown;
  id?: unknown;
  parentId?: unknown;
  message?: unknown;
}

export function selectActiveBranchMessages<T = Record<string, unknown>>(
  records: SessionRecord[],
  limit = Number.POSITIVE_INFINITY
): T[] {
  const byId = new Map<string, { parentId: string | null; message?: T }>();
  const linear: T[] = [];
  let lastId: string | undefined;

  for (const record of records) {
    const message =
      record.type === 'message' && record.message && typeof record.message === 'object'
        ? (record.message as T)
        : undefined;
    if (message) {
      linear.push(message);
    }
    const id = typeof record.id === 'string' && record.id ? record.id : undefined;
    if (!id) {
      continue; // session header (no id) or legacy record
    }
    const parentId = typeof record.parentId === 'string' ? record.parentId : null;
    byId.set(id, { parentId, message });
    lastId = id;
  }

  // Legacy v1 sessions (no id/parentId on any entry): keep the linear behaviour.
  if (byId.size === 0) {
    return clampTail(linear, limit);
  }

  const chain: T[] = [];
  const seen = new Set<string>();
  let cursor: string | null | undefined = lastId;
  while (cursor && byId.has(cursor) && !seen.has(cursor)) {
    seen.add(cursor);
    const node: { parentId: string | null; message?: T } = byId.get(cursor)!;
    if (node.message) {
      chain.push(node.message);
    }
    cursor = node.parentId;
  }
  chain.reverse();

  // Defensive fallback: if the walk somehow yielded nothing but messages exist
  // (unexpected id/parent shape), don't blank the transcript.
  if (chain.length === 0 && linear.length > 0) {
    return clampTail(linear, limit);
  }
  return clampTail(chain, limit);
}

function clampTail<T>(items: T[], limit: number): T[] {
  if (!Number.isFinite(limit) || items.length <= limit) {
    return items;
  }
  return items.slice(-limit);
}
