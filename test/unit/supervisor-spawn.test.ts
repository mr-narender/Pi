import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The supervisor imports `vscode`, so it can't be imported in a plain unit test.
// Guard the cross-platform spawn requirement at the source level instead: on
// Windows the npm-installed `pi` is a `.cmd` shim that requires a shell.
test('supervisor spawns pi through a shell only on win32', () => {
  const src = readFileSync('src/process/supervisor.ts', 'utf8');
  assert.match(src, /const SPAWN_WITH_SHELL = process\.platform === 'win32'/);
  // Both spawn sites must use the platform-aware flag, never a hard-coded false.
  const shellUsages = src.match(/shell: SPAWN_WITH_SHELL/g) ?? [];
  assert.equal(shellUsages.length, 2);
  assert.doesNotMatch(src, /shell: false/);
});
