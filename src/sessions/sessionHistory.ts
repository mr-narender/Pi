import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import type { JsonObject } from '../rpc/protocol';
import { selectActiveBranchMessages, type SessionRecord } from './activeBranch';

/** Stream bytes, retaining only the fields needed for authoritative branch selection. */
export async function readSessionHistory(
  sessionFile: string,
  activeLeafId?: string | null
): Promise<JsonObject[]> {
  const records: SessionRecord[] = [];
  const input = createReadStream(sessionFile, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      try {
        const record: unknown = JSON.parse(line);
        if (!record || typeof record !== 'object') continue;
        const { type, id, parentId, message } = record as SessionRecord;
        records.push({ type, id, parentId, message: type === 'message' ? message : undefined });
      } catch {
        // TUI writes may leave a partial record; the next file change retries it.
      }
    }
  } finally {
    lines.close();
    input.destroy();
  }
  return selectActiveBranchMessages<JsonObject>(records, Number.POSITIVE_INFINITY, activeLeafId);
}

type FileStat = Awaited<ReturnType<typeof stat>>;
function identity(value: FileStat): string {
  return `${value.dev}:${value.ino}:${value.size}:${value.mtimeMs}:${value.ctimeMs}`;
}

/** At most eight small histories (8 MiB of source) are retained by the index worker. */
export class SessionHistoryCache {
  private readonly entries = new Map<
    string,
    { identity: string; bytes: number; messages: JsonObject[] }
  >();

  public async read(file: string, leaf?: string | null): Promise<JsonObject[]> {
    const key = JSON.stringify([resolve(file), leaf === undefined ? ['latest'] : leaf]);
    let before: FileStat;
    try {
      before = await stat(file);
    } catch (error) {
      this.entries.delete(key);
      throw error;
    }
    const existing = this.entries.get(key);
    if (existing?.identity === identity(before)) {
      this.entries.delete(key);
      this.entries.set(key, existing);
      return existing.messages;
    }
    this.entries.delete(key);
    const messages = await readSessionHistory(file, leaf);
    const after = await stat(file);
    if (before.size <= 2 * 1024 * 1024 && identity(before) === identity(after)) {
      this.entries.set(key, { identity: identity(after), bytes: before.size, messages });
      while (
        this.entries.size > 8 ||
        [...this.entries.values()].reduce((sum, entry) => sum + entry.bytes, 0) > 8 * 1024 * 1024
      ) {
        this.entries.delete(this.entries.keys().next().value!);
      }
    }
    return messages;
  }
}
