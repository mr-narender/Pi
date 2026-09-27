import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  agentDir,
  canonicalDir,
  agentSkillsSpecProjectDirs,
  settingsFilePath,
} from '../../src/resources/resourceLocations';

test('agentDir defaults to ~/.pi/agent, respects PI_CODING_AGENT_DIR override', () => {
  const noOverride = agentDir({});
  assert.ok(noOverride.endsWith(join('.pi', 'agent')));
  const withOverride = agentDir({ PI_CODING_AGENT_DIR: '/custom/agent/dir' });
  assert.equal(withOverride, '/custom/agent/dir');
});

test('canonicalDir: user scope under agent dir, project scope under <root>/.pi', () => {
  const env = { PI_CODING_AGENT_DIR: '/home/x/.pi/agent' };
  assert.equal(canonicalDir('skills', 'user', '/proj', env), '/home/x/.pi/agent/skills');
  assert.equal(canonicalDir('extensions', 'project', '/proj', env), join('/proj', '.pi', 'extensions'));
  assert.equal(canonicalDir('prompts', 'project', '/proj', env), join('/proj', '.pi', 'prompts'));
});

test('settingsFilePath matches the real on-disk shape used by approvalGateSettings.ts', () => {
  const env = { PI_CODING_AGENT_DIR: '/home/x/.pi/agent' };
  assert.equal(canonicalDir('skills', 'user', '/proj', env), '/home/x/.pi/agent/skills');
  assert.equal(settingsFilePath('project', '/proj'), join('/proj', '.pi', 'settings.json'));
});

test('agentSkillsSpecProjectDirs: finds .agents/skills walking up, stops at repo root', () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-resource-loc-'));
  try {
    // repo/               <- has .git (repo root, walk stops here)
    //   .agents/skills/    <- found
    //   sub/
    //     .agents/skills/  <- found (nearer)
    //     sub2/            <- start here
    const repo = join(root, 'repo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    mkdirSync(join(repo, '.agents', 'skills'), { recursive: true });
    mkdirSync(join(repo, 'sub', '.agents', 'skills'), { recursive: true });
    const start = join(repo, 'sub', 'sub2');
    mkdirSync(start, { recursive: true });
    // Outside the repo entirely — must NOT be found once .git is hit.
    mkdirSync(join(root, '.agents', 'skills'), { recursive: true });

    const found = agentSkillsSpecProjectDirs(start);
    assert.deepEqual(found, [join(repo, 'sub', '.agents', 'skills'), join(repo, '.agents', 'skills')]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('agentSkillsSpecProjectDirs: bounded by .git, no .agents/skills present -> empty', () => {
  // Real filesystem above tmpdir() is outside this test's control, so the
  // walk MUST be bounded by a .git within our own sandbox, or this would
  // silently start depending on whatever's actually above /tmp on whatever
  // machine runs it.
  const root = mkdtempSync(join(tmpdir(), 'pi-resource-loc-'));
  try {
    mkdirSync(join(root, '.git'), { recursive: true });
    const start = join(root, 'a', 'b', 'c');
    mkdirSync(start, { recursive: true });
    assert.deepEqual(agentSkillsSpecProjectDirs(start), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
