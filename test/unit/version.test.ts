import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MIN_PI_VERSION,
  parsePiVersion,
  compareSemver,
  checkPiVersion,
} from '../../src/process/version';

test('parsePiVersion extracts x.y.z from varied output', () => {
  assert.equal(parsePiVersion('0.80.10'), '0.80.10');
  assert.equal(parsePiVersion('pi 0.80.10\n'), '0.80.10');
  assert.equal(parsePiVersion('version: v1.2.3 (build 9)'), '1.2.3');
  assert.equal(parsePiVersion('no numbers here'), undefined);
});

test('compareSemver orders versions numerically (not lexically)', () => {
  assert.equal(compareSemver('0.80.10', '0.80.10'), 0);
  assert.equal(compareSemver('0.80.9', '0.80.10'), -1); // 9 < 10 (not string compare)
  assert.equal(compareSemver('0.81.0', '0.80.10'), 1);
  assert.equal(compareSemver('1.0.0', '0.80.10'), 1);
});

test('checkPiVersion accepts the exact minimum and any newer version', () => {
  assert.deepEqual(checkPiVersion('0.80.10'), { ok: true, version: '0.80.10' });
  assert.deepEqual(checkPiVersion('0.80.11'), { ok: true, version: '0.80.11' });
  assert.deepEqual(checkPiVersion('0.90.0'), { ok: true, version: '0.90.0' });
  // Regression: a higher MAJOR must NOT be rejected.
  assert.deepEqual(checkPiVersion('1.5.0'), { ok: true, version: '1.5.0' });
});

test('checkPiVersion rejects only versions older than the minimum', () => {
  const result = checkPiVersion('0.80.9');
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.version, '0.80.9');
    assert.match(result.reason, new RegExp(MIN_PI_VERSION));
  }
});

test('checkPiVersion proceeds (with a note) when the version is unparseable', () => {
  const result = checkPiVersion('pi (dev build)');
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.ok(result.note && result.note.length > 0);
  }
});
