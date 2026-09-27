// Shared types for the extensions/skills/prompts manager (Track B).
// Mirrors Pi's own vocabulary from docs/settings.md#resources and
// docs/configuration.md so this stays a thin GUI over Pi's real mechanism,
// not a parallel system.

/** The three resource kinds Pi's settings.json exposes as arrays
 * (`extensions`, `skills`, `prompts`) — see settings.md#resources. */
export type ResourceKind = 'extensions' | 'skills' | 'prompts';

export type ResourceScope = 'user' | 'project';

/** One discovered item — a skill directory, an extension file, or a prompt
 * template file — before any enable/disable state is applied. */
export interface DiscoveredResource {
  kind: ResourceKind;
  scope: ResourceScope;
  /** Absolute filesystem path to the skill dir / extension file / prompt file. */
  absolutePath: string;
  /** Display name: skill/prompt frontmatter `name`/filename, or the
   * extension's filename without extension. */
  name: string;
  /** Frontmatter `description`, when present (skills, prompts only). */
  description?: string;
  /** True when found via the Agent Skills spec locations (~/.agents/skills,
   * .agents/skills) rather than Pi's own canonical <agent-dir>/skills or
   * .pi/skills — informational only, both are equally real to Pi. */
  viaAgentSkillsSpec?: boolean;
}

/** Enable/disable state for one discovered resource, derived from whether
 * an exact `-path` exclusion entry for it exists in the relevant
 * settings.json's resource array. */
export interface ResourceState extends DiscoveredResource {
  enabled: boolean;
}

/** Portable snapshot for export/import — just the deltas (excluded paths +
 * any custom-added paths) per kind/scope, not the full discovered list
 * (which is re-derived from disk on import). */
export interface ResourceConfigSnapshot {
  version: 1;
  exportedAt: string;
  /** scope -> kind -> excluded absolute paths (bare `-path` entries found
   * in that settings.json's array for that kind). */
  excluded: Record<ResourceScope, Record<ResourceKind, string[]>>;
  /** scope -> kind -> custom-added absolute paths (plain-path entries that
   * are NOT inside one of the canonical/spec discovery directories). */
  added: Record<ResourceScope, Record<ResourceKind, string[]>>;
}
