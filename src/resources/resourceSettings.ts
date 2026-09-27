import type { ResourceKind } from './resourceTypes';

// Generalizes review/approvalGateSettings.ts's mergeApprovalGateSetting (one
// hardcoded extension path) into the general case: any of the three
// resource arrays (settings.md#resources), toggling ANY path on/off via
// Pi's own native syntax — plain path = include, `-path` = exact exclude.
// Same pure-JSON-merge shape, same safety behavior (malformed JSON parses
// as empty rather than throwing; a settings file that ends up with zero
// keys returns undefined so the caller can delete it).

function safeParseSettings(existingJson: string | undefined): Record<string, unknown> {
  if (!existingJson) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(existingJson);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function arrayFor(settings: Record<string, unknown>, kind: ResourceKind): string[] {
  return Array.isArray(settings[kind])
    ? (settings[kind] as unknown[]).filter((e): e is string => typeof e === 'string')
    : [];
}

function withArray(
  settings: Record<string, unknown>,
  kind: ResourceKind,
  next: string[]
): Record<string, unknown> {
  if (next.length > 0) {
    return { ...settings, [kind]: next };
  }
  if (kind in settings) {
    return Object.fromEntries(Object.entries(settings).filter(([key]) => key !== kind));
  }
  return settings;
}

function serialize(settings: Record<string, unknown>): string | undefined {
  return Object.keys(settings).length === 0 ? undefined : JSON.stringify(settings, null, 2) + '\n';
}

export type ResourceEntryOp =
  | 'exclude' // disable an auto-discovered resource: ensure `-path` present
  | 'unexclude' // re-enable: ensure `-path` absent
  | 'include' // add a custom resource: ensure plain `path` present
  | 'uninclude'; // remove a custom-added resource: ensure plain `path` absent

/** Apply ONE change to ONE resource array in a settings.json's text.
 * Returns the new file text, or undefined when the settings file should be
 * deleted entirely (now has zero top-level keys). */
export function mergeResourceEntry(
  existingJson: string | undefined,
  kind: ResourceKind,
  op: ResourceEntryOp,
  entryPath: string
): string | undefined {
  let settings = safeParseSettings(existingJson);
  const current = arrayFor(settings, kind);
  const excludeEntry = `-${entryPath}`;
  let next: string[];
  switch (op) {
    case 'exclude':
      next = current.includes(excludeEntry)
        ? current
        : [...current.filter((e) => e !== entryPath), excludeEntry];
      break;
    case 'unexclude':
      next = current.filter((e) => e !== excludeEntry);
      break;
    case 'include':
      next = current.includes(entryPath) ? current : [...current, entryPath];
      break;
    case 'uninclude':
      next = current.filter((e) => e !== entryPath);
      break;
  }
  settings = withArray(settings, kind, next);
  return serialize(settings);
}

/** Read-only: is `entryPath` currently excluded (`-path` present) in this
 * kind's array? Used to compute a discovered item's enabled state. */
export function isResourceExcluded(
  existingJson: string | undefined,
  kind: ResourceKind,
  entryPath: string
): boolean {
  return arrayFor(safeParseSettings(existingJson), kind).includes(`-${entryPath}`);
}

/** Read-only: is `entryPath` present as a bare (non-excluded) entry? Used
 * to detect custom-added resources not under a default discovery dir. */
export function isResourceIncluded(
  existingJson: string | undefined,
  kind: ResourceKind,
  entryPath: string
): boolean {
  return arrayFor(safeParseSettings(existingJson), kind).includes(entryPath);
}

/** Read-only: every bare (non `-`/`+`/`!`-prefixed) plain-path entry for one
 * kind — the custom-added resources not under a default discovery dir. Used
 * to list them in the manager UI and to build the export snapshot. */
export function listPlainEntries(existingJson: string | undefined, kind: ResourceKind): string[] {
  return arrayFor(safeParseSettings(existingJson), kind).filter(
    (entry) => !entry.startsWith('-') && !entry.startsWith('+') && !entry.startsWith('!')
  );
}

/** Read-only: every `-path` exclusion entry's bare path, for one kind. */
export function listExcludedPaths(existingJson: string | undefined, kind: ResourceKind): string[] {
  return arrayFor(safeParseSettings(existingJson), kind)
    .filter((entry) => entry.startsWith('-'))
    .map((entry) => entry.slice(1));
}
