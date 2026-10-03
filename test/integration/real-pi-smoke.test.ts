import test from 'node:test';
import assert from 'node:assert/strict';
import { shutdown, spawnRealPi } from '../helpers/rpc';

test('real Pi 0.99.1 responds to isolated offline state and command queries', async () => {
  const spawned = await spawnRealPi();
  try {
    const state = await spawned.client.getState();
    assert.equal(typeof state?.sessionId, 'string');
    const commands = await spawned.client.getCommands();
    assert.ok(Array.isArray(commands?.commands));
    const stats = await spawned.client.getSessionStats();
    assert.ok(typeof stats === 'object');
    assert.equal(spawned.fixture?.requests, 0, 'state/command queries never invoke the provider');
  } finally {
    await shutdown(spawned);
  }
});
