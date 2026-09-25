import assert from 'node:assert/strict';
import { test } from 'node:test';
import { revealNeedle, toolActivity } from '../../src/live/toolActivity';

test('edit tools classify as editing with the target path', () => {
  const activity = toolActivity('edit', JSON.stringify({ path: 'src/a.ts', oldString: 'x' }));
  assert.deepEqual(activity, { kind: 'editing', path: 'src/a.ts' });
});

test('write tools count as editing', () => {
  const activity = toolActivity('write', JSON.stringify({ path: 'b.md', content: 'hello' }));
  assert.equal(activity?.kind, 'editing');
  assert.equal(activity?.path, 'b.md');
});

test('read tools classify as reading across arg spellings', () => {
  assert.deepEqual(toolActivity('read', JSON.stringify({ path: 'c.py' })), {
    kind: 'reading',
    path: 'c.py',
  });
  assert.deepEqual(toolActivity('read_file', JSON.stringify({ file_path: 'd.go' })), {
    kind: 'reading',
    path: 'd.go',
  });
});

test('non-file tools and malformed args yield nothing', () => {
  assert.equal(toolActivity('bash', JSON.stringify({ command: 'ls' })), undefined);
  assert.equal(toolActivity('read', '{"path": tru'), undefined); // streaming JSON
  assert.equal(toolActivity(undefined, undefined), undefined);
});

test('revealNeedle picks the first substantial changed line', () => {
  const needle = revealNeedle(
    JSON.stringify({ path: 'x.ts', newString: '\n  const value = 42;\n  more();' })
  );
  assert.equal(needle, 'const value = 42;');
  assert.equal(revealNeedle(JSON.stringify({ path: 'x.ts' })), undefined);
});
