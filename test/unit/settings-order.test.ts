import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

for (const mutation of [
  'set_steering_mode',
  'set_follow_up_mode',
  'set_auto_compaction',
  'set_auto_retry',
]) {
  test(`settings dispatch serializes legacy default mutation ${mutation}; views bypass`, async () => {
    const { scopeCommandDispatcher } = await import(
      pathToFileURL(resolve('host/scoped-models.mjs')).href
    );
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const events: string[] = [];
    const dispatch = scopeCommandDispatcher(async (c: any) => {
      if (c.type === 'save_preference') {
        await gate;
        events.push('saved');
      } else if (c.type !== 'get_preferences') events.push(c.type);
    });
    const save = dispatch({ type: 'save_preference' });
    const change = dispatch({ type: mutation });
    await dispatch({ type: 'get_preferences' });
    assert.deepEqual(events, []);
    release();
    await save;
    await change;
    assert.deepEqual(events, ['saved', mutation]);
  });
}
