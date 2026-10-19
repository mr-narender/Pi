import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Behavioral Windows quoting coverage lives in windows-pi-spawn.test.ts.
test('external Pi uses a shell only on win32; bundled runs shell-free', () => {
  const sup = readFileSync('src/process/supervisor.ts', 'utf8');
  assert.match(sup, /const SPAWN_WITH_SHELL = process\.platform === 'win32'/);
  assert.match(sup, /const useShell = launch\.usingBundled \? false : SPAWN_WITH_SHELL/);
  assert.match(sup, /launch\.usingBundled \|\| !SPAWN_WITH_SHELL \? spawn : spawnExternalPi/);
  const proc = readFileSync('src/process/piProcess.ts', 'utf8');
  assert.match(proc, /opts\.useShell \? spawnExternalPi : spawn/);
  assert.match(proc, /shell: false/);
});
