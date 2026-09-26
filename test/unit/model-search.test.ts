import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  fuzzyModelMatch,
  matchesAnyField,
  normalizeForModelSearch,
} from '../../src/commands/modelSearch';

test('normalizes hyphens, underscores, dots, and whitespace to one form', () => {
  assert.equal(normalizeForModelSearch('claude-4-8'), 'claude 4 8');
  assert.equal(normalizeForModelSearch('claude_4_8'), 'claude 4 8');
  assert.equal(normalizeForModelSearch('claude.4.8'), 'claude 4 8');
  assert.equal(normalizeForModelSearch('  Claude   4.8  '), 'claude 4 8');
});

test('"claude 4.8" style queries match hyphenated ids (the exact reported case)', () => {
  assert.equal(fuzzyModelMatch('claude 4.8', 'claude-4-8'), true);
  assert.equal(fuzzyModelMatch('claude-4.8', 'claude 4 8'), true);
  assert.equal(fuzzyModelMatch('CLAUDE 4 8', 'claude-4-8'), true);
});

test('still fuzzy: partial/out-of-order-free subsequence typing works', () => {
  assert.equal(fuzzyModelMatch('cld48', 'claude-4-8'), true); // skips letters, still a subsequence
  assert.equal(fuzzyModelMatch('fable', 'anthropic/claude-fable-5'), true);
});

test('non-matches correctly fail', () => {
  assert.equal(fuzzyModelMatch('gpt', 'claude-4-8'), false);
  assert.equal(fuzzyModelMatch('84', 'claude-4-8'), false); // wrong order
});

test('empty query matches everything (shows the full list)', () => {
  assert.equal(fuzzyModelMatch('', 'claude-4-8'), true);
  assert.equal(fuzzyModelMatch('   ', 'claude-4-8'), true);
});

test('matchesAnyField checks label/description/detail together', () => {
  assert.equal(matchesAnyField('4.8', ['claude-4-8', undefined, 'ctx 200K']), true);
  assert.equal(matchesAnyField('200k', ['claude-4-8', undefined, 'ctx 200K']), true);
  assert.equal(matchesAnyField('xyz', ['claude-4-8', undefined, 'ctx 200K']), false);
});
