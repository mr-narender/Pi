import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeHunks, parseUnifiedZero } from '../../src/review/hunks';

test('parseUnifiedZero: modify, insert, delete', () => {
  const diff = [
    '@@ -2,1 +2,2 @@',
    '-old line',
    '+new line',
    '+extra line',
    '@@ -5,0 +7,1 @@',
    '+pure insert',
    '@@ -9,2 +11,0 @@',
    '-gone a',
    '-gone b',
  ].join('\n');
  const hunks = parseUnifiedZero(diff);
  assert.equal(hunks.length, 3);
  assert.deepEqual(hunks[0], {
    afterStart: 1,
    afterCount: 2,
    beforeText: 'old line',
    removed: 1,
    added: 2,
  });
  assert.equal(hunks[1]?.afterStart, 6);
  assert.equal(hunks[1]?.beforeText, '');
  assert.equal(hunks[2]?.afterCount, 0);
  assert.equal(hunks[2]?.beforeText, 'gone a\ngone b');
});

test('computeHunks end-to-end via git', async () => {
  const before = 'a\nb\nc\nd\n';
  const after = 'a\nB\nc\nd\nE\n';
  const hunks = await computeHunks(before, after);
  assert.equal(hunks.length, 2);
  assert.equal(hunks[0]?.afterStart, 1);
  assert.equal(hunks[0]?.beforeText, 'b');
  assert.equal(hunks[1]?.added, 1);
  assert.deepEqual(await computeHunks('same\n', 'same\n'), []);
});
