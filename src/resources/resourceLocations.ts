import * as path from 'node:path';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import type { ResourceKind } from './resourceTypes';

// Pure path computation — no fs reads beyond existsSync for the repo-root
// walk, no vscode import. Ground truth: docs/configuration.md ("Agent
// directory" / "Project .pi directory" tables) and docs/skills.md ("Add it
// to Pi"), verified against this machine's real ~/.pi/agent and a real
// project .pi/extensions built earlier this session — not assumed from
// memory of the docs alone.

/** `<agent-dir>` — defaults to ~/.pi/agent, overridable via
 * PI_CODING_AGENT_DIR (same env var Pi's own SDK/CLI respects). */
export function agentDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.PI_CODING_AGENT_DIR || path.join(homedir(), '.pi', 'agent');
}

/** Pi's own canonical discovery directory for one resource kind/scope —
 * <agent-dir>/<kind>/ for user, <projectRoot>/.pi/<kind>/ for project. */
export function canonicalDir(
  kind: ResourceKind,
  scope: 'user' | 'project',
  projectRoot: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  return scope === 'user' ? path.join(agentDir(env), kind) : path.join(projectRoot, '.pi', kind);
}

/** Skills only: Pi ALSO discovers via the Agent Skills spec locations
 * (~/.agents/skills, .agents/skills), in addition to its own canonical
 * <agent-dir>/skills and .pi/skills — see skills.md "Add it to Pi". */
export function agentSkillsSpecUserDir(): string {
  return path.join(homedir(), '.agents', 'skills');
}

/** Project .agents/skills is discovered walking UP from the working
 * directory through ancestors, stopping at the repo root when one exists
 * (skills.md). Returns every .agents/skills that exists along that walk,
 * nearest first. */
export function agentSkillsSpecProjectDirs(startDir: string): string[] {
  const found: string[] = [];
  let dir = path.resolve(startDir);
  for (;;) {
    const candidate = path.join(dir, '.agents', 'skills');
    if (existsSync(candidate)) {
      found.push(candidate);
    }
    if (existsSync(path.join(dir, '.git'))) {
      break; // repo root reached — per spec, stop here
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break; // filesystem root
    }
    dir = parent;
  }
  return found;
}

/** Where the settings.json for a scope lives — the file resourceSettings.ts
 * reads/writes to toggle a resource on or off. */
export function settingsFilePath(scope: 'user' | 'project', projectRoot: string): string {
  return scope === 'user'
    ? path.join(agentDir(), 'settings.json')
    : path.join(projectRoot, '.pi', 'settings.json');
}
