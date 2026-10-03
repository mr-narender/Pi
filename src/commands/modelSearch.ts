// Separator-agnostic fuzzy search for the model/provider picker: "claude 4.8"
// must match an id like "claude-4-8" or "claude.4.8" — VS Code's native
// QuickPick filter does literal character-subsequence matching, so a space in
// the query has nothing to match against a hyphen in the id and fails
// outright. Normalizing -, _, ., and whitespace to one interchangeable
// separator fixes that; used with QuickPickItem.alwaysShow to fully replace
// VS Code's native filter (see modelPicker.ts).
export function normalizeForModelSearch(text: string): string {
  return text
    .toLowerCase()
    .replace(/[-_.\s]+/g, ' ')
    .trim();
}

/** Subsequence match on normalized text — keeps the "fuzzy" typing feel
 * while treating every separator variant as equivalent. */
export function fuzzyModelMatch(query: string, candidate: string): boolean {
  const q = normalizeForModelSearch(query);
  if (!q) {
    return true;
  }
  const c = normalizeForModelSearch(candidate);
  let cursor = 0;
  for (const char of q) {
    const at = c.indexOf(char, cursor);
    if (at === -1) {
      return false;
    }
    cursor = at + 1;
  }
  return true;
}

/** True if the query matches ANY of the candidate's searchable fields. */
export function matchesAnyField(query: string, fields: Array<string | undefined>): boolean {
  return fields.some((field) => field !== undefined && fuzzyModelMatch(query, field));
}

/** Every numeric run found in text, in order — "claude-4-8" → [4, 8],
 * "claude-fable-5" → [5], "gpt" → [0] (no version found, sorts last). */
function versionTuple(text: string): number[] {
  const found = [...text.matchAll(/\d+/g)].map((match) => Number.parseInt(match[0], 10));
  return found.length > 0 ? found : [0];
}

/** Highest-version-first comparator for a model list — "easier eye filtering":
 * best-effort, based on whatever version-like numbers appear in the id/name.
 * Compares tuples positionally (major, minor, …), descending. */
export function compareModelRankDesc(
  a: { id?: string; name?: string; contextWindow?: number },
  b: { id?: string; name?: string; contextWindow?: number }
): number {
  const ta = versionTuple(`${a.id ?? ''} ${a.name ?? ''}`);
  const tb = versionTuple(`${b.id ?? ''} ${b.name ?? ''}`);
  const length = Math.max(ta.length, tb.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (tb[index] ?? 0) - (ta[index] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  const contextDiff = (b.contextWindow ?? 0) - (a.contextWindow ?? 0);
  if (contextDiff !== 0) {
    return contextDiff;
  }
  return (a.id ?? '').localeCompare(b.id ?? '');
}
