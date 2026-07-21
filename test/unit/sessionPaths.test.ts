import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { canonicalizeSessionPath } from '../../src/sessions/paths';

test('canonicalizeSessionPath returns an absolute path for an existing file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-paths-'));
  try {
    const file = join(dir, 'session.jsonl');
    await writeFile(file, '{}');
    const result = await canonicalizeSessionPath(dir, file);
    assert.ok(isAbsolute(result));
    assert.ok(result.endsWith('session.jsonl'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('canonicalizeSessionPath does not throw when realpath fails (missing path)', async () => {
  // Simulates the Windows ENOENT-on-realpath case: the resolved candidate is
  // returned instead of throwing, so loading the session still proceeds.
  const missing = resolve('/no/such/dir/--c--Users-asdada--/2026_abc.jsonl');
  const result = await canonicalizeSessionPath('/no/such/dir', missing);
  assert.equal(result, missing);
});

test('canonicalizeSessionPath resolves a relative path against the cwd', async () => {
  const result = await canonicalizeSessionPath('/work/space', 'sub/session.jsonl');
  assert.equal(result, resolve('/work/space', 'sub/session.jsonl'));
});
