import test from 'node:test';
import assert from 'node:assert/strict';
import { shutdown, spawnMockPi } from '../helpers/rpc';

test('mock Pi child supports handshake and streaming prompt flow', async () => {
  const spawned = await spawnMockPi();
  const events: string[] = [];
  spawned.client.onEvent((event) => events.push(String(event.type)));
  try {
    const state = await spawned.client.getState();
    assert.equal(state?.sessionId, 'mock-session');
    const commands = await spawned.client.getCommands();
    assert.ok(Array.isArray(commands?.commands));
    await spawned.client.prompt('hello mock');
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(events.includes('agent_start'));
    assert.ok(events.includes('agent_settled'));
    const lastText = await spawned.client.getLastAssistantText();
    assert.equal(lastText?.text, 'hello from mock pi');
  } finally {
    await shutdown(spawned);
  }
});

test('mock Pi child queues steer and follow-up authoritatively', async () => {
  const spawned = await spawnMockPi();
  const queueUpdates: Array<{ steering: string[]; followUp: string[] }> = [];
  spawned.client.onEvent((event) => {
    if (event.type === 'queue_update') {
      queueUpdates.push({
        steering: Array.isArray(event.steering)
          ? event.steering.filter((item: unknown): item is string => typeof item === 'string')
          : [],
        followUp: Array.isArray(event.followUp)
          ? event.followUp.filter((item: unknown): item is string => typeof item === 'string')
          : [],
      });
    }
  });
  try {
    await spawned.client.steer('a');
    await spawned.client.followUp('b');
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(queueUpdates[0], { steering: ['a'], followUp: [] });
    assert.deepEqual(queueUpdates[1], { steering: [], followUp: ['b'] });
  } finally {
    await shutdown(spawned);
  }
});
