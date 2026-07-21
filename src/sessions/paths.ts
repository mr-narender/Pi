import { realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

/**
 * Resolve a session path to an absolute, canonical path.
 *
 * `realpath` is used only to normalize symlinks/casing. It MUST NOT be allowed
 * to throw: on Windows (and for a not-yet-flushed file) realpath can fail with
 * ENOENT even though the resolved path is valid, which previously aborted
 * loading a session with e.g. `ENOENT: ... realpath 'C:\\--c--Users-...--'`.
 * When realpath fails we fall back to the resolved absolute candidate, which is
 * a perfectly usable path to hand to Pi.
 */
export async function canonicalizeSessionPath(cwd: string, sessionPath: string): Promise<string> {
  const candidate = isAbsolute(sessionPath) ? sessionPath : resolve(cwd, sessionPath);
  try {
    return await realpath(candidate);
  } catch {
    return candidate;
  }
}
