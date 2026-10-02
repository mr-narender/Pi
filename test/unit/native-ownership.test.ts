import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNativeFixture, nativeSpawnPlan, nativeSdkHostPlan } from '../helpers/nativeFixture';
import { spawnRealPi } from '../helpers/rpc';

test('owned compact veto profile rejects forgery and source/asset tampering before any spawn', async () => {
  await assert.rejects(createNativeFixture('foreign' as any), /profile/);
  const fixture = await createNativeFixture('compact-veto');
  try {
    await assert.rejects(nativeSpawnPlan({ ...fixture }), /identity/);
    await assert.rejects(nativeSdkHostPlan({ ...fixture }, 'shared'), /owned/i);
    const plan = await nativeSpawnPlan(fixture);
    const asset = join(fixture.root, 'compact-veto.mjs');
    assert.ok(plan.args.includes('--no-extensions'));
    assert.deepEqual(plan.args.slice(-2), ['--extension', asset]);
    assert.equal(
      await readFile(asset, 'utf8'),
      await readFile('test/helpers/compact-veto.mjs', 'utf8')
    );
    await writeFile(asset, '// tampered owned fixture');
    await assert.rejects(nativeSpawnPlan(fixture), /asset mutation/i);
    await assert.rejects(nativeSdkHostPlan(fixture, 'dedicated'), /asset mutation/i);
  } finally {
    await fixture.dispose();
  }
});

// Plan-only regressions: never spawn a child from any adversarial fixture.
test('native ownership rejects structural identity and root/env/nodeArgs false authority', async () => {
  const fixture = await createNativeFixture();
  const unowned = await mkdtemp(join(tmpdir(), 'pi-synthetic-unowned-'));
  try {
    const forged = {
      ...fixture,
      root: unowned,
      cwd: unowned,
      env: { HOME: join(unowned, 'fake-home'), PI_CODING_AGENT_DIR: unowned },
      nodeArgs: ['--permission', '--allow-fs-read=*', '--allow-fs-write=*'],
    };
    await assert.rejects(nativeSpawnPlan(forged), /owned|identity/i);
    await assert.rejects(nativeSpawnPlan({ ...fixture }), /owned|identity/i);
    let untrustedCallbackCalls = 0;
    await assert.rejects(
      spawnRealPi([], {
        ...forged,
        async dispose() {
          untrustedCallbackCalls++;
        },
      }),
      /owned|identity/i
    );
    assert.equal(untrustedCallbackCalls, 0);
    assert.equal(Reflect.set(fixture, 'root', unowned), false);
    assert.equal(Reflect.set(fixture.env, 'HOME', unowned), false);
    assert.equal(Reflect.set(fixture.nodeArgs, '0', '--allow-fs-read=*'), false);
    assert.ok(Object.isFrozen(fixture));
    assert.ok(Object.isFrozen(fixture.env));
    assert.ok(Object.isFrozen(fixture.nodeArgs));
    const first = await nativeSpawnPlan(fixture);
    first.env.HOME = unowned;
    first.args.splice(0, first.args.length);
    const next = await nativeSpawnPlan(fixture);
    assert.equal(next.env.HOME, fixture.home);
    assert.ok(next.args.includes('--require'));
    fixture.resetRequests();
    assert.equal(fixture.requests, 0);
    await fixture.linkSettings('global');
    await nativeSpawnPlan(fixture);
  } finally {
    await fixture.dispose();
    await rm(unowned, { recursive: true, force: true });
  }
  await assert.rejects(nativeSpawnPlan(fixture), /disposed|owned/i);
});

test('native ownership freezes genuine public root/env/security arguments', async () => {
  const fixture = await createNativeFixture();
  try {
    assert.equal(Reflect.set(fixture, 'root', '/synthetic-unowned'), false);
    assert.equal(Reflect.set(fixture.env, 'HOME', '/synthetic-unowned'), false);
    assert.equal(Reflect.set(fixture.nodeArgs, '0', '--allow-fs-read=*'), false);
  } finally {
    await fixture.dispose();
  }
});

test('native ownership rejects replaced canonical root before plan construction', async () => {
  const fixture = await createNativeFixture();
  const saved = fixture.root + '-saved';
  try {
    await rename(fixture.root, saved);
    await mkdir(fixture.root);
    await assert.rejects(nativeSpawnPlan(fixture), /owned|identity/i);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
    await rename(saved, fixture.root);
    await fixture.dispose();
  }
});

test('native ownership rejects a modified security preloader before spawn', async () => {
  const fixture = await createNativeFixture();
  try {
    await writeFile(join(fixture.root, 'network-denial.cjs'), '// synthetic disabled guard');
    await assert.rejects(nativeSpawnPlan(fixture), /preloader mutation/i);
  } finally {
    await fixture.dispose();
  }
});

test('native ownership rejects cwd and config symlink escapes without reading canaries', async () => {
  const fixture = await createNativeFixture();
  const unowned = await mkdtemp(join(tmpdir(), 'pi-synthetic-escape-'));
  try {
    await rename(fixture.cwd, fixture.cwd + '-saved');
    await symlink(unowned, fixture.cwd);
    await assert.rejects(nativeSpawnPlan(fixture), /owned|escape/i);
    await rm(fixture.cwd);
    await rename(fixture.cwd + '-saved', fixture.cwd);
    await rm(fixture.authFile);
    await symlink(join(unowned, 'synthetic-canary-not-created'), fixture.authFile);
    await assert.rejects(nativeSpawnPlan(fixture), /owned|escape|ENOENT/i);
  } finally {
    await fixture.dispose();
    await rm(unowned, { recursive: true, force: true });
  }
});
