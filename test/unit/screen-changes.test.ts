import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveScreenChanges } from '../../src/webview/editToolPath';

const editBlock = (callId: string, path: string, oldString: string, newString: string) => ({
  kind: 'tool' as const,
  name: 'edit',
  callId,
  args: JSON.stringify({ path, oldString, newString }),
});

test('changes come from the newest assistant turn only', () => {
  const changes = deriveScreenChanges([
    { role: 'assistant', blocks: [editBlock('old', 'a.ts', 'x', 'y')] },
    { role: 'user', blocks: [] },
    { role: 'assistant', blocks: [editBlock('c1', 'b.ts', 'foo', 'bar')] },
  ] as never);
  assert.equal(changes.length, 1);
  assert.equal(changes[0]?.path, 'b.ts');
  assert.equal(changes[0]?.oldText, 'foo');
  assert.equal(changes[0]?.newText, 'bar');
});

test('non-edit tools and turns without edits yield nothing', () => {
  assert.deepEqual(
    deriveScreenChanges([
      { role: 'assistant', blocks: [{ kind: 'tool', name: 'bash', callId: 'c', args: '{}' }] },
    ] as never),
    []
  );
  assert.deepEqual(deriveScreenChanges([] as never), []);
});
