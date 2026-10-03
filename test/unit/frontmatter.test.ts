import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  parseFrontmatter,
  firstNonEmptyLineAfterFrontmatter,
} from '../../src/resources/frontmatter';

test('parses the exact SKILL.md example shape from skills.md', () => {
  const content = `---
name: pdf-tools
description: Extract text and tables from PDF files. Use when reading, converting, or inspecting PDFs.
---

# PDF tools

Read references/formats.md before converting a document.`;
  const fields = parseFrontmatter(content);
  assert.equal(fields.name, 'pdf-tools');
  assert.equal(
    fields.description,
    'Extract text and tables from PDF files. Use when reading, converting, or inspecting PDFs.'
  );
});

test('parses the exact prompt-template example shape (quoted value)', () => {
  const content = `---
description: Review staged git changes
argument-hint: "[focus]"
---
Review the staged changes.`;
  const fields = parseFrontmatter(content);
  assert.equal(fields.description, 'Review staged git changes');
  assert.equal(fields['argument-hint'], '[focus]'); // quotes stripped
});

test('no frontmatter fence -> empty object, does not throw', () => {
  assert.deepEqual(parseFrontmatter('# Just a heading\n\nSome text.'), {});
  assert.deepEqual(parseFrontmatter(''), {});
});

test('unclosed fence -> whatever was parsed before EOF, does not throw', () => {
  const fields = parseFrontmatter('---\nname: broken\n');
  assert.equal(fields.name, 'broken');
});

test('malformed lines (no colon) are skipped, not fatal', () => {
  const content = `---
this line has no colon
name: ok
---
body`;
  const fields = parseFrontmatter(content);
  assert.equal(fields.name, 'ok');
  assert.equal(Object.keys(fields).length, 1);
});

test('firstNonEmptyLineAfterFrontmatter finds the fallback description', () => {
  const content = `---
argument-hint: "[x]"
---

Review the staged changes. Focus on correctness.
`;
  assert.equal(
    firstNonEmptyLineAfterFrontmatter(content),
    'Review the staged changes. Focus on correctness.'
  );
});

test('firstNonEmptyLineAfterFrontmatter with no frontmatter at all', () => {
  assert.equal(firstNonEmptyLineAfterFrontmatter('\n\nfirst real line\nsecond'), 'first real line');
});

test('firstNonEmptyLineAfterFrontmatter returns undefined for empty body', () => {
  assert.equal(firstNonEmptyLineAfterFrontmatter('---\nname: x\n---\n\n\n'), undefined);
});
