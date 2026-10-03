import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeApprovalGateSetting } from '../../src/review/approvalGateSettings';

test('enabling on an empty/missing settings file creates a minimal file', () => {
  const result = mergeApprovalGateSetting(undefined, true);
  assert.ok(result);
  const parsed = JSON.parse(result!);
  assert.deepEqual(parsed.extensions, ['./extensions/pi-approval-gate.ts']);
});

test('enabling preserves other settings and other extensions', () => {
  const existing = JSON.stringify({
    sessionDir: '/tmp/sessions',
    extensions: ['./extensions/something-else.ts'],
  });
  const result = mergeApprovalGateSetting(existing, true);
  const parsed = JSON.parse(result!);
  assert.equal(parsed.sessionDir, '/tmp/sessions');
  assert.deepEqual(parsed.extensions.sort(), [
    './extensions/pi-approval-gate.ts',
    './extensions/something-else.ts',
  ]);
});

test('enabling twice does not duplicate the entry', () => {
  const once = mergeApprovalGateSetting(undefined, true);
  const twice = mergeApprovalGateSetting(once, true);
  const parsed = JSON.parse(twice!);
  assert.deepEqual(parsed.extensions, ['./extensions/pi-approval-gate.ts']);
});

test('disabling removes only our entry, keeps others, keeps other settings', () => {
  const existing = JSON.stringify({
    sessionDir: '/tmp/sessions',
    extensions: ['./extensions/pi-approval-gate.ts', './extensions/something-else.ts'],
  });
  const result = mergeApprovalGateSetting(existing, false);
  const parsed = JSON.parse(result!);
  assert.equal(parsed.sessionDir, '/tmp/sessions');
  assert.deepEqual(parsed.extensions, ['./extensions/something-else.ts']);
});

test('disabling the only entry with nothing else present deletes the file entirely', () => {
  const existing = JSON.stringify({ extensions: ['./extensions/pi-approval-gate.ts'] });
  assert.equal(mergeApprovalGateSetting(existing, false), undefined);
});

test('disabling when it was never enabled is a no-op that keeps other settings', () => {
  const existing = JSON.stringify({ sessionDir: '/tmp/sessions' });
  const result = mergeApprovalGateSetting(existing, false);
  const parsed = JSON.parse(result!);
  assert.deepEqual(parsed, { sessionDir: '/tmp/sessions' });
});

test('malformed existing JSON is treated as empty rather than throwing', () => {
  const result = mergeApprovalGateSetting('{ not valid json', true);
  const parsed = JSON.parse(result!);
  assert.deepEqual(parsed.extensions, ['./extensions/pi-approval-gate.ts']);
});
