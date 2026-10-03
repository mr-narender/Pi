import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  discoverSkills,
  discoverExtensions,
  discoverPrompts,
} from '../../src/resources/resourceDiscovery';

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'pi-resource-disc-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('discoverSkills: finds flat skill directories, parses name/description from frontmatter', () => {
  withTempDir((dir) => {
    mkdirSync(join(dir, 'pdf-tools'), { recursive: true });
    writeFileSync(
      join(dir, 'pdf-tools', 'SKILL.md'),
      '---\nname: pdf-tools\ndescription: Extract text from PDFs.\n---\nBody.'
    );
    mkdirSync(join(dir, 'not-a-skill'), { recursive: true }); // no SKILL.md
    writeFileSync(join(dir, 'stray-file.md'), 'not a directory, ignored');

    const found = discoverSkills('user', dir);
    assert.equal(found.length, 1);
    assert.equal(found[0]?.name, 'pdf-tools');
    assert.equal(found[0]?.description, 'Extract text from PDFs.');
    assert.equal(found[0]?.kind, 'skills');
    assert.equal(found[0]?.scope, 'user');
  });
});

test('discoverSkills: falls back to directory name when frontmatter has no name field', () => {
  withTempDir((dir) => {
    mkdirSync(join(dir, 'my-skill'), { recursive: true });
    writeFileSync(join(dir, 'my-skill', 'SKILL.md'), '---\ndescription: no name field here\n---\n');
    const found = discoverSkills('project', dir);
    assert.equal(found[0]?.name, 'my-skill');
  });
});

test('discoverSkills: one level of category-folder nesting is discovered', () => {
  withTempDir((dir) => {
    mkdirSync(join(dir, 'category', 'nested-skill'), { recursive: true });
    writeFileSync(join(dir, 'category', 'nested-skill', 'SKILL.md'), '---\nname: nested\n---\n');
    const found = discoverSkills('user', dir);
    assert.equal(found.length, 1);
    assert.equal(found[0]?.name, 'nested');
  });
});

test('discoverSkills: viaAgentSkillsSpec flag propagates through', () => {
  withTempDir((dir) => {
    mkdirSync(join(dir, 'x'), { recursive: true });
    writeFileSync(join(dir, 'x', 'SKILL.md'), '---\nname: x\n---\n');
    const found = discoverSkills('user', dir, true);
    assert.equal(found[0]?.viaAgentSkillsSpec, true);
  });
});

test('discoverSkills: nonexistent directory returns empty, does not throw', () => {
  assert.deepEqual(discoverSkills('user', '/definitely/does/not/exist'), []);
});

test('discoverExtensions: direct .ts/.js files and index.ts/index.js directories', () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, 'hello.ts'), 'export default function() {}');
    writeFileSync(join(dir, 'legacy.js'), 'module.exports = () => {}');
    writeFileSync(join(dir, 'readme.md'), 'not an extension');
    mkdirSync(join(dir, 'multi-file-ext'), { recursive: true });
    writeFileSync(join(dir, 'multi-file-ext', 'index.ts'), 'export default function() {}');
    mkdirSync(join(dir, 'not-an-extension-dir'), { recursive: true }); // no index.ts/js

    const found = discoverExtensions('user', dir);
    const names = found.map((f) => f.name).sort();
    assert.deepEqual(names, ['hello', 'legacy', 'multi-file-ext']);
  });
});

test('discoverExtensions: nonexistent directory returns empty, does not throw', () => {
  assert.deepEqual(discoverExtensions('project', '/definitely/does/not/exist'), []);
});

test('discoverPrompts: direct .md children only, frontmatter description', () => {
  withTempDir((dir) => {
    writeFileSync(
      join(dir, 'review.md'),
      '---\ndescription: Review staged git changes\nargument-hint: "[focus]"\n---\nBody.'
    );
    mkdirSync(join(dir, 'nested'), { recursive: true });
    writeFileSync(join(dir, 'nested', 'ignored.md'), '---\ndescription: not direct child\n---\n');

    const found = discoverPrompts('user', dir);
    assert.equal(found.length, 1);
    assert.equal(found[0]?.name, 'review');
    assert.equal(found[0]?.description, 'Review staged git changes');
  });
});

test('discoverPrompts: falls back to first non-empty body line when description omitted', () => {
  withTempDir((dir) => {
    writeFileSync(
      join(dir, 'noframe.md'),
      '---\nargument-hint: "[x]"\n---\n\nFirst real line here.\n'
    );
    const found = discoverPrompts('user', dir);
    assert.equal(found[0]?.description, 'First real line here.');
  });
});

test('discoverPrompts: nonexistent directory returns empty, does not throw', () => {
  assert.deepEqual(discoverPrompts('user', '/definitely/does/not/exist'), []);
});
