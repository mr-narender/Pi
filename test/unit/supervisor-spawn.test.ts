import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The supervisor imports `vscode`, so it can't be imported in a plain unit test.
// Guard the cross-platform spawn requirement at the source level instead: on
// Windows the npm-installed external `pi` is a `.cmd` shim that requires a shell;
// the bundled cli.js is a direct binary launched via VS Code's Node, so it needs
// NO shell. Both subprocess spawn sites must use `usingBundled ? false : shell`.
test('external Pi uses a shell only on win32; bundled runs shell-free', () => {
  const sup = readFileSync('src/process/supervisor.ts', 'utf8');
  assert.match(sup, /const SPAWN_WITH_SHELL = process\.platform === 'win32'/);
  // Both spawn sites (main launch + version probe) decide the shell from the
  // launch plan: external -> platform shell, bundled -> no shell.
  const decisions = sup.match(/launch\.usingBundled \? false : SPAWN_WITH_SHELL/g) ?? [];
  assert.equal(decisions.length, 2);
  // The actual spawn wrapper must honor the passed-through flag, never hard-code.
  const proc = readFileSync('src/process/piProcess.ts', 'utf8');
  assert.match(proc, /shell: opts\.useShell/);
});
