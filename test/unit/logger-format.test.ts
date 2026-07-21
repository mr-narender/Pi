import test from 'node:test';
import assert from 'node:assert/strict';
import { formatError } from '../../src/diagnostics/errorFormat';

test('formatError includes message and Node error code for clear diagnostics', () => {
  const err = Object.assign(new Error('spawn pi ENOENT'), { code: 'ENOENT', errno: -2 });
  const out = formatError(err);
  assert.match(out, /spawn pi ENOENT/);
  assert.match(out, /code=ENOENT/);
  assert.match(out, /errno=-2/);
});

test('formatError handles strings and unknown values', () => {
  assert.equal(formatError('boom'), 'boom');
  assert.equal(formatError({ a: 1 }), '{"a":1}');
});
