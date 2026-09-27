import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  mergeResourceEntry,
  isResourceExcluded,
  isResourceIncluded,
  listPlainEntries,
  listExcludedPaths,
} from '../../src/resources/resourceSettings';

test('exclude on empty settings creates the array with a -path entry', () => {
  const out = mergeResourceEntry(undefined, 'skills', 'exclude', './skills/foo');
  assert.deepEqual(JSON.parse(out ?? '{}'), { skills: ['-./skills/foo'] });
});

test('exclude is idempotent — excluding twice does not duplicate', () => {
  const once = mergeResourceEntry(undefined, 'skills', 'exclude', './skills/foo');
  const twice = mergeResourceEntry(once, 'skills', 'exclude', './skills/foo');
  assert.deepEqual(JSON.parse(twice ?? '{}'), { skills: ['-./skills/foo'] });
});

test('exclude removes a conflicting plain-include entry for the same path first', () => {
  const included = mergeResourceEntry(undefined, 'skills', 'include', './skills/foo');
  const excluded = mergeResourceEntry(included, 'skills', 'exclude', './skills/foo');
  assert.deepEqual(JSON.parse(excluded ?? '{}'), { skills: ['-./skills/foo'] });
});

test('unexclude removes the -path entry (re-enable)', () => {
  const excluded = mergeResourceEntry(undefined, 'skills', 'exclude', './skills/foo');
  const reenabled = mergeResourceEntry(excluded, 'skills', 'unexclude', './skills/foo');
  // array empties out -> key removed -> whole settings object empty -> undefined
  assert.equal(reenabled, undefined);
});

test('include adds a bare path; uninclude removes it', () => {
  const included = mergeResourceEntry(undefined, 'extensions', 'include', '/custom/ext.ts');
  assert.deepEqual(JSON.parse(included ?? '{}'), { extensions: ['/custom/ext.ts'] });
  const removed = mergeResourceEntry(included, 'extensions', 'uninclude', '/custom/ext.ts');
  assert.equal(removed, undefined);
});

test('include is idempotent', () => {
  const once = mergeResourceEntry(undefined, 'extensions', 'include', '/custom/ext.ts');
  const twice = mergeResourceEntry(once, 'extensions', 'include', '/custom/ext.ts');
  assert.deepEqual(JSON.parse(twice ?? '{}'), { extensions: ['/custom/ext.ts'] });
});

test('other settings keys are preserved untouched', () => {
  const existing = JSON.stringify({ theme: 'dark', extensions: ['./keep-me.ts'] });
  const out = mergeResourceEntry(existing, 'skills', 'exclude', './skills/foo');
  assert.deepEqual(JSON.parse(out ?? '{}'), {
    theme: 'dark',
    extensions: ['./keep-me.ts'],
    skills: ['-./skills/foo'],
  });
});

test('kinds are independent — excluding a skill never touches extensions/prompts arrays', () => {
  const existing = JSON.stringify({
    extensions: ['./ext-a.ts'],
    prompts: ['./prompt-a.md'],
  });
  const out = mergeResourceEntry(existing, 'skills', 'exclude', './skills/foo');
  const parsed = JSON.parse(out ?? '{}');
  assert.deepEqual(parsed.extensions, ['./ext-a.ts']);
  assert.deepEqual(parsed.prompts, ['./prompt-a.md']);
  assert.deepEqual(parsed.skills, ['-./skills/foo']);
});

test('malformed JSON is treated as empty rather than throwing', () => {
  const out = mergeResourceEntry('{not valid json', 'skills', 'exclude', './skills/foo');
  assert.deepEqual(JSON.parse(out ?? '{}'), { skills: ['-./skills/foo'] });
});

test('a JSON array (not object) at the top level is treated as empty rather than throwing', () => {
  const out = mergeResourceEntry('[1,2,3]', 'skills', 'exclude', './skills/foo');
  assert.deepEqual(JSON.parse(out ?? '{}'), { skills: ['-./skills/foo'] });
});

test('unexclude/uninclude on an already-empty settings file is a safe no-op', () => {
  assert.equal(mergeResourceEntry(undefined, 'skills', 'unexclude', './x'), undefined);
  assert.equal(mergeResourceEntry(undefined, 'skills', 'uninclude', './x'), undefined);
});

test('output always ends with a single trailing newline (matches approvalGateSettings.ts convention)', () => {
  const out = mergeResourceEntry(undefined, 'skills', 'exclude', './skills/foo');
  assert.ok(out?.endsWith('}\n'));
  assert.ok(!out?.endsWith('}\n\n'));
});

test('isResourceExcluded / isResourceIncluded read state correctly', () => {
  const json = JSON.stringify({ skills: ['-./skills/off', './skills/custom'] });
  assert.equal(isResourceExcluded(json, 'skills', './skills/off'), true);
  assert.equal(isResourceExcluded(json, 'skills', './skills/custom'), false);
  assert.equal(isResourceIncluded(json, 'skills', './skills/custom'), true);
  assert.equal(isResourceIncluded(json, 'skills', './skills/off'), false);
});

test('listPlainEntries / listExcludedPaths skip +/-/! prefixed forms correctly', () => {
  const json = JSON.stringify({
    skills: ['./skills/plain', '-./skills/excluded', '+./skills/explicit', '!./skills/*.bak'],
  });
  assert.deepEqual(listPlainEntries(json, 'skills'), ['./skills/plain']);
  assert.deepEqual(listExcludedPaths(json, 'skills'), ['./skills/excluded']);
});

test('listPlainEntries / listExcludedPaths on undefined settings return empty arrays', () => {
  assert.deepEqual(listPlainEntries(undefined, 'skills'), []);
  assert.deepEqual(listExcludedPaths(undefined, 'skills'), []);
});
