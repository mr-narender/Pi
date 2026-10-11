import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createTestDirectory } from '../helpers/temp';

test('test directories bootstrap their project parent on a clean runner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-clean-runner-'));
  const variable = process.platform === 'win32' ? 'TEMP' : 'TMPDIR';
  const previous = process.env[variable];
  process.env[variable] = root;
  try {
    const directory = await createTestDirectory('fixture-');
    assert.equal(directory.startsWith(join(root, 'pi-extension', 'fixture-')), true);
  } finally {
    if (previous === undefined) delete process.env[variable];
    else process.env[variable] = previous;
    await rm(root, { recursive: true, force: true });
  }
});
