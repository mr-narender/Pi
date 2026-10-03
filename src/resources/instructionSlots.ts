import * as path from 'node:path';
import { existsSync } from 'node:fs';
import { agentDir } from './resourceLocations';

// "Agent Instructions" — the slots that shape how π behaves, distinct from
// extensions/skills/prompts (open-ended collections you toggle) because
// there's zero-or-one file per slot, and the useful action is edit/create,
// not enable/disable. Deliberately does NOT include SYSTEM.md (full replace
// of the default system prompt) — explicit user call: too easy to cause
// real damage, only the additive/context-file forms are offered here.
//
// Ground truth: docs/configuration.md, read fresh, not from memory —
// APPEND_SYSTEM.md lives at <agent-dir>/ or .pi/ (same convention as
// extensions/skills/prompts); AGENTS.md/CLAUDE.md are a SEPARATE mechanism
// ("context files") that live directly in the working directory (project
// root), not inside .pi/, and cascade through parent directories. This
// module intentionally only surfaces the immediate project root's context
// file, not every ancestor — that broader cascade is Pi's own concern, not
// something to re-expose as an editable list here.
export type InstructionSlotKind = 'appendSystem' | 'agentsFile';
export type InstructionScope = 'user' | 'project';

export interface InstructionSlot {
  kind: InstructionSlotKind;
  scope: InstructionScope;
  /** Absolute path this slot resolves to (existing file, or where a new
   * one would be created). */
  path: string;
  exists: boolean;
  /** Which of the 5 accepted names this resolved to, agentsFile slots only. */
  matchedName?: string;
  description: string;
}

const APPEND_SYSTEM_EXPLANATION =
  'Adds to π\u2019s default system prompt \u2014 extra instructions layered on top of the built-in ones, without replacing anything π already knows how to do.';

const AGENTS_FILE_EXPLANATION =
  'Project/personal instructions π reads for context \u2014 conventions, architecture notes, how you like things done. Loaded whenever π runs in this directory (or below it).';

// Precedence order exactly as configuration.md lists them; first existing
// one found is the one Pi actually uses.
const AGENTS_FILE_NAMES = [
  'AGENTS.override.md',
  'AGENTS.md',
  'AGENTS.MD',
  'CLAUDE.md',
  'CLAUDE.MD',
];
const DEFAULT_NEW_AGENTS_FILE_NAME = 'AGENTS.md';

function resolveAgentsFile(dir: string): { path: string; exists: boolean; matchedName?: string } {
  for (const name of AGENTS_FILE_NAMES) {
    const candidate = path.join(dir, name);
    if (existsSync(candidate)) {
      return { path: candidate, exists: true, matchedName: name };
    }
  }
  return { path: path.join(dir, DEFAULT_NEW_AGENTS_FILE_NAME), exists: false };
}

export function userInstructionSlots(env: NodeJS.ProcessEnv = process.env): InstructionSlot[] {
  const dir = agentDir(env);
  const appendSystemPath = path.join(dir, 'APPEND_SYSTEM.md');
  const agentsFile = resolveAgentsFile(dir);
  return [
    {
      kind: 'appendSystem',
      scope: 'user',
      path: appendSystemPath,
      exists: existsSync(appendSystemPath),
      description: APPEND_SYSTEM_EXPLANATION,
    },
    {
      kind: 'agentsFile',
      scope: 'user',
      path: agentsFile.path,
      exists: agentsFile.exists,
      matchedName: agentsFile.matchedName,
      description: AGENTS_FILE_EXPLANATION,
    },
  ];
}

export function projectInstructionSlots(projectRoot: string): InstructionSlot[] {
  // APPEND_SYSTEM.md: same .pi/ convention as extensions/skills/prompts.
  const appendSystemPath = path.join(projectRoot, '.pi', 'APPEND_SYSTEM.md');
  // AGENTS.md/CLAUDE.md: NOT under .pi/ — lives directly in the project
  // root, per configuration.md's "Context files" section.
  const agentsFile = resolveAgentsFile(projectRoot);
  return [
    {
      kind: 'appendSystem',
      scope: 'project',
      path: appendSystemPath,
      exists: existsSync(appendSystemPath),
      description: APPEND_SYSTEM_EXPLANATION,
    },
    {
      kind: 'agentsFile',
      scope: 'project',
      path: agentsFile.path,
      exists: agentsFile.exists,
      matchedName: agentsFile.matchedName,
      description: AGENTS_FILE_EXPLANATION,
    },
  ];
}
