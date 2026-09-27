import * as path from 'node:path';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import type { DiscoveredResource, ResourceScope } from './resourceTypes';
import { parseFrontmatter, firstNonEmptyLineAfterFrontmatter } from './frontmatter';

// Real fs reads, no vscode dependency — kept plain-Node so it's directly
// unit-testable the same way importScan.ts is, per this session's
// established pattern for anything filesystem-facing.
//
// SCOPE BOUNDARY (found via real-data testing, not assumed): Pi packages
// (settings.json's `packages: [...]`, e.g. "git:github.com/x/y") can ALSO
// bring their own skills/extensions/prompts, unpacked under
// <agent-dir>/git/…, <agent-dir>/npm/…, etc. — a resolution mechanism this
// module deliberately does NOT reach into for v1. Those are already
// toggleable by removing the package declaration itself; duplicating that
// control here would mean tracking install-location-dependent absolute
// paths that can shift across package updates. This module only covers
// Pi's own canonical <agent-dir>/<kind> + .pi/<kind>, and (skills only) the
// Agent Skills spec locations.

function safeReaddir(dir: string): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  try {
    return readdirSync(dir);
  } catch {
    return []; // permission error, race with deletion, etc. — never throw into a UI list
  }
}

function safeRead(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

/** Skills: directories containing SKILL.md, discovered recursively one
 * level (skills.md: "Directories containing SKILL.md are discovered
 * recursively" — in practice every real skill collection here and in this
 * project's own ~/.agents/skills is a flat list of skill dirs, so this
 * scans immediate children and one level of nesting, matching what users
 * actually have on disk without an unbounded recursive walk). */
export function discoverSkills(
  scope: ResourceScope,
  dir: string,
  viaAgentSkillsSpec = false
): DiscoveredResource[] {
  const found: DiscoveredResource[] = [];
  const visit = (current: string, depth: number): void => {
    if (depth > 2) {
      return; // bounded — real skill collections are flat or one level deep
    }
    for (const entry of safeReaddir(current)) {
      const entryPath = path.join(current, entry);
      let stat;
      try {
        stat = statSync(entryPath);
      } catch {
        continue;
      }
      if (!stat.isDirectory()) {
        continue;
      }
      const skillMd = path.join(entryPath, 'SKILL.md');
      if (existsSync(skillMd)) {
        const content = safeRead(skillMd);
        const fields = content ? parseFrontmatter(content) : {};
        found.push({
          kind: 'skills',
          scope,
          absolutePath: entryPath,
          name: fields.name || entry,
          description: fields.description,
          viaAgentSkillsSpec,
        });
      } else {
        visit(entryPath, depth + 1); // a category folder of skill folders
      }
    }
  };
  visit(dir, 0);
  return found;
}

/** Extensions: direct .ts/.js files, or subdirectories with an index.ts/
 * index.js entry point — exact rule from extensions.md ("Pi loads direct
 * TypeScript or JavaScript files and subdirectories containing an index.ts
 * or index.js entry point"). No frontmatter/description mechanism exists
 * for extensions, so name is just the filename. */
export function discoverExtensions(scope: ResourceScope, dir: string): DiscoveredResource[] {
  const found: DiscoveredResource[] = [];
  for (const entry of safeReaddir(dir)) {
    const entryPath = path.join(dir, entry);
    let stat;
    try {
      stat = statSync(entryPath);
    } catch {
      continue;
    }
    if (stat.isFile() && (entry.endsWith('.ts') || entry.endsWith('.js'))) {
      found.push({
        kind: 'extensions',
        scope,
        absolutePath: entryPath,
        name: entry.replace(/\.(ts|js)$/, ''),
      });
    } else if (stat.isDirectory()) {
      const indexTs = path.join(entryPath, 'index.ts');
      const indexJs = path.join(entryPath, 'index.js');
      if (existsSync(indexTs) || existsSync(indexJs)) {
        found.push({
          kind: 'extensions',
          scope,
          absolutePath: entryPath,
          name: entry,
        });
      }
    }
  }
  return found;
}

/** Prompts: direct .md children only — exact rule from prompt-templates.md
 * ("Conventional prompt directories load direct .md children only"). The
 * filename (minus extension) becomes the /command name. Description comes
 * from frontmatter, falling back to the first non-empty body line per the
 * doc's own stated rule. */
export function discoverPrompts(scope: ResourceScope, dir: string): DiscoveredResource[] {
  const found: DiscoveredResource[] = [];
  for (const entry of safeReaddir(dir)) {
    if (!entry.endsWith('.md')) {
      continue;
    }
    const entryPath = path.join(dir, entry);
    let stat;
    try {
      stat = statSync(entryPath);
    } catch {
      continue;
    }
    if (!stat.isFile()) {
      continue;
    }
    const content = safeRead(entryPath);
    const fields = content ? parseFrontmatter(content) : {};
    const description =
      fields.description || (content ? firstNonEmptyLineAfterFrontmatter(content) : undefined);
    found.push({
      kind: 'prompts',
      scope,
      absolutePath: entryPath,
      name: entry.replace(/\.md$/, ''),
      description,
    });
  }
  return found;
}
