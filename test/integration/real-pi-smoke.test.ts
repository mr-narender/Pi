import test from 'node:test';
import assert from 'node:assert/strict';
import { shutdown, spawnRealPi } from '../helpers/rpc';

test('real Pi 0.80.10 responds to offline state and command queries', async () => {
  const spawned = await spawnRealPi();
  try {
    const state = await spawned.client.getState();
    assert.equal(typeof state?.sessionId, 'string');
    const commands = await spawned.client.getCommands();
    assert.ok(Array.isArray(commands?.commands));
    const stats = await spawned.client.getSessionStats();
    assert.ok(typeof stats === 'object');
  } finally {
    await shutdown(spawned);
  }
});
