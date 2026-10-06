import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PiRpcSettings } from '../../src/config/settings';
import {
  detectPathPi,
  resolvePiLaunch,
  selectedSdkRoot,
  setManagedPiCliPath,
  setBundledPiCliPath,
} from '../../src/process/piLauncher';

test('launch provenance: cached A → PATH B; async drift and explicit/managed/worker/wrapper matrix', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pi-launch-metadata-')));
  const originalPath = process.env.PATH;
  const settings = { piSource: 'external', executable: 'pi' } as PiRpcSettings;
  const sdk = (name: string) => {
    const root = join(dir, name);
    mkdirSync(join(root, 'dist'), { recursive: true });
    mkdirSync(join(root, 'bin'));
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        name: '@earendil-works/pi-coding-agent',
        version: '0.99.1',
        bin: { pi: 'dist/cli.js' },
      }),
      { mode: 0o444 }
    );
    // Metadata only: empty CLI is NEVER spawned or passed to native helpers.
    writeFileSync(join(root, 'dist/cli.js'), '', { mode: 0o555 });
    symlinkSync(join(root, 'dist/cli.js'), join(root, 'bin/pi'));
    return realpathSync(root);
  };
  try {
    const a = sdk('a');
    const b = sdk('b');
    process.env.PATH = join(a, 'bin');
    assert.equal(detectPathPi()?.packageRoot, a);
    process.env.PATH = join(b, 'bin');
    const plan = resolvePiLaunch(settings);
    assert.equal(plan.command, join(b, 'dist/cli.js')); // Genuine pre-fix RED.
    assert.equal(selectedSdkRoot(settings), b);
    assert.equal((plan as any).sdkRoot, b);
    await Promise.resolve().then(() => {
      process.env.PATH = join(a, 'bin');
      settings.executable = join(a, 'bin/pi');
      settings.piSource = 'managed';
      setManagedPiCliPath(join(a, 'dist/cli.js'));
    });
    assert.equal(plan.command, join(b, 'dist/cli.js'));
    assert.equal((plan as any).sdkRoot, b);
    assert.equal((plan as any).env.PATH, join(b, 'bin'));
    assert.ok(Object.isFrozen(plan));
    assert.ok(Object.isFrozen((plan as any).env));
    assert.ok(Object.isFrozen(plan.prefixArgs));
    assert.equal((resolvePiLaunch(settings) as any).sdkRoot, a);
    settings.piSource = 'external';
    assert.equal((resolvePiLaunch(settings) as any).sdkRoot, a);
    settings.executable = './b/bin/pi';
    assert.equal((resolvePiLaunch as any)(settings, process.env, dir).sdkRoot, b);
    setBundledPiCliPath(join(b, 'dist/cli.js'));
    settings.executable = join(b, 'bin/pi');
    settings.piSource = 'managed';
    assert.equal(resolvePiLaunch(settings).command, join(b, 'dist/cli.js'));
    assert.equal((resolvePiLaunch(settings) as any).sdkRoot, b);
    settings.executable = 'pi';
    process.env.PATH = join(b, 'bin');
    assert.equal(resolvePiLaunch(settings).command, join(b, 'dist/cli.js'));
    assert.equal((resolvePiLaunch(settings) as any).sdkRoot, b);
    settings.piSource = 'bundled';
    assert.equal((resolvePiLaunch(settings) as any).sdkRoot, b);
    settings.piSource = 'inprocess';
    assert.equal(resolvePiLaunch(settings).cliPath, join(b, 'dist/cli.js'));
    assert.equal((resolvePiLaunch(settings) as any).sdkRoot, b);
    const wrapper = join(dir, 'wrapper');
    writeFileSync(wrapper, '', { mode: 0o555 });
    settings.piSource = 'external';
    settings.executable = wrapper;
    assert.equal(resolvePiLaunch(settings).command, wrapper);
    assert.equal((resolvePiLaunch(settings) as any).sdkRoot, undefined);
    assert.equal(selectedSdkRoot(settings), undefined);
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    setManagedPiCliPath(undefined);
    setBundledPiCliPath(undefined);
    rmSync(dir, { recursive: true, force: true });
  }
});
