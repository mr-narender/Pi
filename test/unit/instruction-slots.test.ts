import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  userInstructionSlots,
  projectInstructionSlots,
} from '../../src/resources/instructionSlots';

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'pi-instruction-slots-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('SYSTEM.md existing on disk is never surfaced as a slot — the explicit safety exclusion', () => {
  withTempDir((agentDir) => {
    writeFileSync(join(agentDir, 'SYSTEM.md'), 'should never be surfaced, even though it exists');
    const slots = userInstructionSlots({ PI_CODING_AGENT_DIR: agentDir });
    // Exactly the 2 expected kinds — nothing extra, nothing SYSTEM.md-related,
    // regardless of what's actually sitting on disk.
    assert.deepEqual(slots.map((s) => s.kind).sort(), ['agentsFile', 'appendSystem']);
  });
});

test('userInstructionSlots: neither file exists -> both slots report exists:false with a create-path', () => {
  withTempDir((agentDir) => {
    const slots = userInstructionSlots({ PI_CODING_AGENT_DIR: agentDir });
    assert.equal(slots.length, 2);
    for (const slot of slots) {
      assert.equal(slot.exists, false);
      assert.ok(slot.path.startsWith(agentDir));
    }
    const agentsSlot = slots.find((s) => s.kind === 'agentsFile');
    assert.equal(agentsSlot?.path, join(agentDir, 'AGENTS.md')); // default create name
  });
});

test('userInstructionSlots: APPEND_SYSTEM.md exists -> reported correctly, agentsFile still missing', () => {
  withTempDir((agentDir) => {
    writeFileSync(join(agentDir, 'APPEND_SYSTEM.md'), '# extra instructions');
    const slots = userInstructionSlots({ PI_CODING_AGENT_DIR: agentDir });
    const appendSlot = slots.find((s) => s.kind === 'appendSystem');
    const agentsSlot = slots.find((s) => s.kind === 'agentsFile');
    assert.equal(appendSlot?.exists, true);
    assert.equal(agentsSlot?.exists, false);
  });
});

test('agentsFile precedence: AGENTS.override.md wins over AGENTS.md when both exist', () => {
  withTempDir((agentDir) => {
    writeFileSync(join(agentDir, 'AGENTS.md'), 'base');
    writeFileSync(join(agentDir, 'AGENTS.override.md'), 'override');
    const slots = userInstructionSlots({ PI_CODING_AGENT_DIR: agentDir });
    const agentsSlot = slots.find((s) => s.kind === 'agentsFile');
    assert.equal(agentsSlot?.matchedName, 'AGENTS.override.md');
    assert.equal(agentsSlot?.path, join(agentDir, 'AGENTS.override.md'));
  });
});

test('agentsFile precedence: CLAUDE.md found when no AGENTS.* variant exists', () => {
  withTempDir((agentDir) => {
    writeFileSync(join(agentDir, 'CLAUDE.md'), 'claude instructions');
    const slots = userInstructionSlots({ PI_CODING_AGENT_DIR: agentDir });
    const agentsSlot = slots.find((s) => s.kind === 'agentsFile');
    assert.equal(agentsSlot?.matchedName, 'CLAUDE.md');
    assert.equal(agentsSlot?.exists, true);
  });
});

test('projectInstructionSlots: APPEND_SYSTEM.md resolves under .pi/, AGENTS.md resolves at project root (NOT under .pi/)', () => {
  withTempDir((projectRoot) => {
    mkdirSync(join(projectRoot, '.pi'), { recursive: true });
    writeFileSync(join(projectRoot, '.pi', 'APPEND_SYSTEM.md'), 'project append');
    writeFileSync(join(projectRoot, 'AGENTS.md'), 'project agents file at ROOT, not .pi/');
    const slots = projectInstructionSlots(projectRoot);
    const appendSlot = slots.find((s) => s.kind === 'appendSystem');
    const agentsSlot = slots.find((s) => s.kind === 'agentsFile');
    assert.equal(appendSlot?.path, join(projectRoot, '.pi', 'APPEND_SYSTEM.md'));
    assert.equal(appendSlot?.exists, true);
    assert.equal(agentsSlot?.path, join(projectRoot, 'AGENTS.md'));
    assert.equal(agentsSlot?.exists, true);
  });
});

test('projectInstructionSlots: an AGENTS.md placed under .pi/ (wrong location) is NOT picked up — confirms it is deliberately not treated as a .pi/ resource', () => {
  withTempDir((projectRoot) => {
    mkdirSync(join(projectRoot, '.pi'), { recursive: true });
    writeFileSync(join(projectRoot, '.pi', 'AGENTS.md'), 'wrong location, should be ignored');
    const slots = projectInstructionSlots(projectRoot);
    const agentsSlot = slots.find((s) => s.kind === 'agentsFile');
    assert.equal(agentsSlot?.exists, false);
    assert.equal(agentsSlot?.path, join(projectRoot, 'AGENTS.md'));
  });
});

test('every slot carries a non-empty, kind-specific explanation', () => {
  withTempDir((agentDir) => {
    const slots = userInstructionSlots({ PI_CODING_AGENT_DIR: agentDir });
    for (const slot of slots) {
      assert.ok(slot.description.length > 20);
    }
    const [appendSlot, agentsSlot] = slots;
    assert.notEqual(appendSlot?.description, agentsSlot?.description);
  });
});
