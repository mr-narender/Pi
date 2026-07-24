import assert from 'node:assert/strict';
import { test } from 'node:test';
import { editToolFilePath, editReplacements } from '../../src/webview/editToolPath';

test('editToolFilePath extracts path for edit/write tools', () => {
  assert.equal(editToolFilePath('edit', '{"path":"src/a.ts","diff":"..."}'), 'src/a.ts');
  assert.equal(editToolFilePath('write', '{"file_path":"b.txt","content":"x"}'), 'b.txt');
  assert.equal(editToolFilePath('edit', 'path: "src/c.ts" not json "path":"src/c.ts"'), 'src/c.ts');
});

test('editToolFilePath ignores non-edit tools and missing path', () => {
  assert.equal(editToolFilePath('bash', '{"cmd":"ls"}'), undefined);
  assert.equal(editToolFilePath('edit', '{"nope":1}'), undefined);
  assert.equal(editToolFilePath(undefined, '{"path":"x"}'), undefined);
});

test('editReplacements extracts oldText/newText hunks', () => {
  const reps = editReplacements(
    'edit',
    JSON.stringify({ path: 'a.ts', replacements: [{ oldText: 'let x=1', newText: 'const x = 1' }] })
  );
  assert.deepEqual(reps, [{ oldText: 'let x=1', newText: 'const x = 1' }]);
  assert.deepEqual(editReplacements('bash', '{"cmd":"ls"}'), []);
  assert.deepEqual(editReplacements('edit', '{"path":"a"}'), []);
});
