import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createNativeFixture, nativeSdkHostPlan, nativeSpawnPlan } from '../helpers/nativeFixture';

test('fixed owned image-effects profile has no extra script, process, worker or destination authority', async () => {
  const f = await createNativeFixture('image-effects');
  try {
    await assert.rejects(nativeSdkHostPlan({ ...f }, 'shared'), /Unowned/);
    await assert.rejects(nativeSpawnPlan(f, ['--extension', '/tmp/foreign']), /Unowned|unowned/);
    const plan = await nativeSdkHostPlan(f, 'shared');
    assert.equal(
      plan.args.some(
        (a) =>
          /allow-(child-process|worker|addons|inspector)|allow-fs-read=\//.test(a) &&
          !a.includes(f.root) &&
          !a.includes('@earendil-works/pi-coding-agent')
      ),
      false
    );
    assert.equal(plan.open.args.includes('--extension'), false);
    assert.equal(f.env.PI_FIXTURE_PORT, String(f.port));
    assert.equal(f.requests, 0);
    assert.equal(await readFile(f.networkLog, 'utf8'), '');
  } finally {
    await f.dispose();
  }
});
