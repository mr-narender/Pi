import assert from 'node:assert/strict';
import test from 'node:test';
import { formatRelativeTime } from '../../src/webview/chatListShared';
import { formatRelativeTimestamp } from '../../src/sessions/recentSessions';

const NOW = Date.UTC(2024, 0, 4, 12, 0, 0);

test('formatRelativeTime: boundary buckets', () => {
  assert.equal(formatRelativeTime(NOW, NOW), 'just now');
  assert.equal(formatRelativeTime(NOW - 59_000, NOW), 'just now');
  assert.equal(formatRelativeTime(NOW - 60_000, NOW), '1m ago');
  assert.equal(formatRelativeTime(NOW - 59 * 60_000, NOW), '59m ago');
  assert.equal(formatRelativeTime(NOW - 60 * 60_000, NOW), '1h ago');
  assert.equal(formatRelativeTime(NOW - 24 * 60 * 60_000, NOW), '1d ago');
  assert.equal(formatRelativeTime(NOW - 400 * 24 * 60 * 60_000, NOW), '400d ago');
});

test('formatRelativeTime: invalid inputs degrade to Unknown, never NaN text', () => {
  for (const value of [Number.NaN, 0, -5, Number.POSITIVE_INFINITY]) {
    assert.equal(formatRelativeTime(value, NOW), 'Unknown');
  }
  assert.equal(formatRelativeTime(NOW, Number.NaN), 'Unknown');
  // A future timestamp (clock skew) clamps to "just now", not negative text.
  assert.equal(formatRelativeTime(NOW + 60_000, NOW), 'just now');
});

test('recentSessions re-export stays the same function (node consumers unchanged)', () => {
  assert.equal(formatRelativeTimestamp, formatRelativeTime);
});
