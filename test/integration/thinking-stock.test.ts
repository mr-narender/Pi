import assert from 'node:assert/strict';
import test from 'node:test';
import { createNativeFixture } from '../helpers/nativeFixture';
import { spawnRealPi, shutdown } from '../helpers/rpc';

test(
  'thinking stock backend: unknown handshake is unsupported without assuming a getter endpoint',
  { timeout: 30000 },
  async () => {
    const fixture = await createNativeFixture('scopes');
    const spawned = await spawnRealPi([], fixture);
    try {
      await assert.rejects(spawned.client.getThinkingCapabilities(), /unsupported by this backend/);
      assert.equal((await spawned.client.getState())?.thinkingLevel, 'off');
      assert.equal(fixture.requests, 0);
    } finally {
      await shutdown(spawned);
    }
  }
);
