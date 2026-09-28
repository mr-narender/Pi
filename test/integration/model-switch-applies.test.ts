import test from 'node:test';
import assert from 'node:assert/strict';
import { shutdown, spawnRealPi } from '../helpers/rpc';

// Direct response to a real bug report: "changing the model doesn't affect
// the model being selected, it still uses the old model". Uses the REAL Pi
// CLI (not a mock) to prove, end to end, that setModel() actually takes
// effect and a subsequent prompt() genuinely uses the new model — not just
// that the RPC calls resolve without throwing.
test('setModel() actually applies: getState reflects it, and a subsequent prompt uses it', async () => {
  const spawned = await spawnRealPi();
  const assistantMessages: Array<{ provider?: string; model?: string }> = [];
  spawned.client.onEvent((event) => {
    const record = event as { type?: string; message?: { role?: string; provider?: string; model?: string } };
    if (record.type === 'message_end' && record.message?.role === 'assistant') {
      assistantMessages.push({ provider: record.message.provider, model: record.message.model });
    }
  });
  try {
    const initial = await spawned.client.getState();
    const initialKey = `${initial?.model?.provider}/${initial?.model?.id}`;

    const modelsResp = await spawned.client.getAvailableModels();
    const models = (Array.isArray(modelsResp?.models) ? modelsResp.models : []) as Array<{
      provider?: unknown;
      id?: unknown;
    }>;
    // A DIFFERENT provider, not just a different model on the same provider —
    // the strongest possible check that the switch really took.
    const target = models.find(
      (m) => typeof m.provider === 'string' && m.provider !== initial?.model?.provider
    ) as { provider: string; id: string } | undefined;
    assert.ok(target, 'test environment must have models from at least 2 providers configured');

    await spawned.client.setModel(target!.provider, target!.id);
    const afterSwitch = await spawned.client.getState();
    assert.equal(afterSwitch?.model?.provider, target!.provider);
    assert.equal(afterSwitch?.model?.id, target!.id);
    assert.notEqual(`${afterSwitch?.model?.provider}/${afterSwitch?.model?.id}`, initialKey);

    await spawned.client.prompt('PING', []);
    await new Promise((resolve) => setTimeout(resolve, 4000));

    assert.ok(assistantMessages.length > 0, 'expected at least one assistant message after prompt()');
    // The API call itself may fail offline (no real network/credentials) —
    // that's expected and irrelevant here. What matters: it was ATTRIBUTED
    // to the model we just switched to, not the one we started on.
    for (const message of assistantMessages) {
      assert.equal(message.provider, target!.provider);
      assert.equal(message.model, target!.id);
    }
  } finally {
    await shutdown(spawned);
  }
});
