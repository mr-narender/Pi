import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stripAnsiCodes } from '../../src/ui/status/ansi';

test('strips the exact reported case: color codes around an emoji + text', () => {
  const input = '\x1b[38;5;109m🐈 MCP: 2 servers enabled\x1b[39m';
  assert.equal(stripAnsiCodes(input), '🐈 MCP: 2 servers enabled');
});

test('strips multiple color codes in one string', () => {
  const input = '\x1b[38;5;241m○\x1b[39m \x1b[38;5;244mponytail: \x1b[39m\x1b[38;5;188m⚡ FULL\x1b[39m';
  assert.equal(stripAnsiCodes(input), '○ ponytail: ⚡ FULL');
});

test('plain text with no ANSI codes is unchanged', () => {
  assert.equal(stripAnsiCodes('just plain text'), 'just plain text');
});

test('empty string is unchanged', () => {
  assert.equal(stripAnsiCodes(''), '');
});
