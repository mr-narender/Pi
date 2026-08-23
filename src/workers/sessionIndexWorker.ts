// Session index/search worker: runs the heavy disk work (all-projects session
// scanning, full-text content search) OFF the extension-host main thread. The
// content-blob cache is mtime-validated so repeated searches are in-memory.
// Bundled to dist/sessionIndexWorker.js by scripts/build.mjs.
import { parentPort } from 'node:worker_threads';
import { readFile, stat } from 'node:fs/promises';
import { readAllProjectsSessions } from '../sessions/recentSessions';

interface ScanAllRequest {
  id: number;
  op: 'scanAll';
  excludeCwds: string[];
}

interface SearchCandidate {
  path: string;
  name: string;
  cwd: string;
  other: boolean;
}

interface SearchRequest {
  id: number;
  op: 'search';
  query: string;
  candidates: SearchCandidate[];
}

type Request = ScanAllRequest | SearchRequest;

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_MATCHES = 20;

const blobCache = new Map<string, { mtimeMs: number; text: string; raw: string }>();

async function blobFor(path: string): Promise<{ text: string; raw: string } | undefined> {
  try {
    const stats = await stat(path);
    if (stats.size > MAX_FILE_BYTES) {
      return undefined;
    }
    const cached = blobCache.get(path);
    if (cached && cached.mtimeMs === stats.mtimeMs) {
      return cached;
    }
    const raw = await readFile(path, 'utf8');
    const entry = { mtimeMs: stats.mtimeMs, raw, text: raw.toLowerCase() };
    blobCache.set(path, entry);
    // Bound the cache: drop oldest entries beyond 120 files.
    if (blobCache.size > 120) {
      const first = blobCache.keys().next().value;
      if (first) {
        blobCache.delete(first);
      }
    }
    return entry;
  } catch {
    return undefined;
  }
}

function preview(raw: string, index: number, needleLength: number): string {
  return `…${raw
    .slice(Math.max(0, index - 60), index + needleLength + 60)
    .replace(/\\+[nrt]/g, ' ')
    .replace(/[\\"{}[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim()}…`;
}

async function handle(request: Request): Promise<void> {
  try {
    if (request.op === 'scanAll') {
      const records = await readAllProjectsSessions(request.excludeCwds);
      parentPort?.postMessage({ id: request.id, ok: true, records });
      return;
    }
    const needle = request.query.trim().toLowerCase();
    const matches: Array<{
      path: string;
      name: string;
      preview: string;
      cwd: string;
      other: boolean;
      count: number;
    }> = [];
    for (const candidate of request.candidates.slice(0, 80)) {
      if (matches.length >= MAX_MATCHES) {
        break;
      }
      const blob = await blobFor(candidate.path);
      if (!blob) {
        continue;
      }
      const index = blob.text.indexOf(needle);
      if (index < 0) {
        continue;
      }
      let count = 0;
      for (let at = index; at >= 0 && count < 50; at = blob.text.indexOf(needle, at + 1)) {
        count += 1;
      }
      matches.push({
        path: candidate.path,
        name: candidate.name,
        preview: preview(blob.raw, index, needle.length),
        cwd: candidate.cwd,
        other: candidate.other,
        count,
      });
    }
    matches.sort((left, right) => right.count - left.count);
    parentPort?.postMessage({ id: request.id, ok: true, matches });
  } catch (error) {
    parentPort?.postMessage({
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

parentPort?.on('message', (request: Request) => {
  void handle(request);
});
