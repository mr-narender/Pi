import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import {
  createNativeFixture,
  nativePublicAuthPlan,
  spawnNativePublicAuth,
} from '../helpers/nativeFixture';
test('fixed public-auth asset rejects forged fixtures and mutation before any SDK execution', async () => {
  await assert.rejects(nativePublicAuthPlan({} as any), /Unowned/);
  const fixture = await createNativeFixture('scopes');
  try {
    await nativePublicAuthPlan(fixture);
    await writeFile(join(fixture.root, 'native-public-auth.mjs'), 'throw new Error("unowned")');
    await assert.rejects(spawnNativePublicAuth(fixture), /asset|changed|modified/i);
    assert.equal(fixture.requests, 0);
  } finally {
    await fixture.dispose();
  }
});
