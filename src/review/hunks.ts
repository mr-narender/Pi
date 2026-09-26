// Hunk engine: line-level diff between the turn snapshot ("before") and the
// current file ("after"), via `git diff --no-index --unified=0` (works outside
// repos too — git is already a hard dependency of turn review). Each hunk maps
// to a precise line range in the CURRENT file so it can be kept or reverted
// individually — Zed's single-file review, in VS Code.
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export interface Hunk {
  /** 0-based first line of this hunk in the CURRENT file. */
  afterStart: number;
  /** Line count in the current file (0 = pure deletion at this point). */
  afterCount: number;
  /** Replacement text that restores the BEFORE state of this hunk. */
  beforeText: string;
  /** Lines removed from before (for display). */
  removed: number;
  /** Lines added in after (for display). */
  added: number;
}

/** Parse `--unified=0` output into hunks. */
export function parseUnifiedZero(diff: string): Hunk[] {
  const hunks: Hunk[] = [];
  const lines = diff.split('\n');
  let index = 0;
  while (index < lines.length) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[index] ?? '');
    if (!header) {
      index += 1;
      continue;
    }
    const beforeCount = header[2] !== undefined ? Number.parseInt(header[2], 10) : 1;
    const afterLine = Number.parseInt(header[3]!, 10);
    const afterCount = header[4] !== undefined ? Number.parseInt(header[4], 10) : 1;
    index += 1;
    const beforeLines: string[] = [];
    let added = 0;
    while (index < lines.length) {
      const line = lines[index]!;
      if (line.startsWith('-')) {
        beforeLines.push(line.slice(1));
        index += 1;
      } else if (line.startsWith('+')) {
        added += 1;
        index += 1;
      } else if (line.startsWith('\\')) {
        index += 1; // "\ No newline at end of file"
      } else {
        break;
      }
    }
    hunks.push({
      // For pure deletions (afterCount 0) git reports the line BEFORE the gap.
      afterStart: afterCount === 0 ? afterLine : afterLine - 1,
      afterCount,
      beforeText: beforeLines.join('\n'),
      removed: beforeCount,
      added,
    });
  }
  return hunks;
}

/** Diff two contents at line granularity. */
export async function computeHunks(before: string, after: string): Promise<Hunk[]> {
  const dir = await mkdtemp(join(tmpdir(), 'pi-hunks-'));
  try {
    const beforePath = join(dir, 'before');
    const afterPath = join(dir, 'after');
    await writeFile(beforePath, before, 'utf8');
    await writeFile(afterPath, after, 'utf8');
    try {
      await exec('git', ['diff', '--no-index', '--unified=0', '--', beforePath, afterPath], {
        maxBuffer: 32 * 1024 * 1024,
      });
      return []; // identical
    } catch (error) {
      const stdout = (error as { stdout?: string }).stdout ?? '';
      return parseUnifiedZero(stdout);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
