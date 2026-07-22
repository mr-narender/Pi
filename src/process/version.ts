/**
 * Pi CLI version gating.
 *
 * We require a MINIMUM Pi version (the RPC surface this extension build was
 * written against), NOT an exact match — a newer Pi must keep working. If the
 * version can't be parsed we proceed with a warning rather than blocking.
 */

export const MIN_PI_VERSION = '0.80.10';

/** Extract a semver `x.y.z` from arbitrary `pi --version` output. */
export function parsePiVersion(output: string): string | undefined {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(output);
  return match ? `${match[1]}.${match[2]}.${match[3]}` : undefined;
}

/** Compare two `x.y.z` strings. Returns -1 / 0 / 1. */
export function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) {
      return diff < 0 ? -1 : 1;
    }
  }
  return 0;
}

export type PiVersionCheck =
  | { ok: true; version?: string; note?: string }
  | { ok: false; version: string; reason: string };

/**
 * Accept any Pi version >= `min`. Older versions are rejected with a clear
 * reason; unparseable output is allowed (with a note) so an unusual build
 * string never hard-blocks the extension.
 */
export function checkPiVersion(output: string, min: string = MIN_PI_VERSION): PiVersionCheck {
  const version = parsePiVersion(output);
  if (!version) {
    return {
      ok: true,
      note: `Could not parse a Pi version from '${output.trim()}'; proceeding (minimum supported ${min}).`,
    };
  }
  if (compareSemver(version, min) < 0) {
    return {
      ok: false,
      version,
      reason: `Pi ${version} is older than the minimum supported ${min}. Update the Pi CLI (npm install -g @earendil-works/pi-coding-agent).`,
    };
  }
  return { ok: true, version };
}
