import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createNativeFixture } from '../helpers/nativeFixture';
import { shutdown, spawnRealPi } from '../helpers/rpc';

test('native fixture missing provider credentials fails locally without an HTTP request', async () => {
  const fixture = await createNativeFixture();
  const models = JSON.parse(await readFile(fixture.modelsFile, 'utf8'));
  for (const provider of Object.values(models.providers) as Array<{ apiKey?: string }>)
    delete provider.apiKey;
  await writeFile(fixture.modelsFile, JSON.stringify(models));
  const spawned = await spawnRealPi([], fixture);
  try {
    await assert.rejects(spawned.client.prompt('PING', []), /API key|credentials|authentication/i);
    assert.equal(fixture.requests, 0);
    assert.equal(await readFile(fixture.authFile, 'utf8'), '{}');
  } finally {
    await shutdown(spawned);
  }
});
