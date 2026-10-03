import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createNativeFixture, nativeSdkHostPlan } from '../helpers/nativeFixture';

test('owned lifecycle veto profile denies forged identity and mutated assets before native execution', async () => {
  const fixture = await createNativeFixture('lifecycle-veto');
  try {
    await assert.rejects(nativeSdkHostPlan({ ...fixture } as any, 'shared'), /Unowned/);
    const plan = await nativeSdkHostPlan(fixture, 'shared');
    assert.ok(plan.open.args.includes(join(fixture.root, 'lifecycle-veto.mjs')));
    assert.ok(!plan.args.some((arg) => /allow-child-process|allow-worker/.test(arg)));
    await writeFile(join(fixture.root, 'lifecycle-veto.mjs'), 'throw new Error("tampered")');
    await assert.rejects(nativeSdkHostPlan(fixture, 'shared'), /asset mutation/);
    assert.equal(fixture.requests, 0);
  } finally {
    await fixture.dispose();
  }
});
