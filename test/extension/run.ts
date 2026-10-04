import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
  execFileSync('node', ['./scripts/build.mjs'], { stdio: 'inherit' });
  const extensionDevelopmentPath = process.cwd();
  const extensionTestsPath = join(process.cwd(), 'test', 'extension', 'suite', 'index.cjs');
  const testWorkspace = join(process.cwd(), 'test', 'fixtures', 'workspace');
  // Electron uses a Unix socket beneath user-data-dir on macOS. A long
  // worktree path exceeds the socket limit before the extension tests start.
  const profile = mkdtempSync(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'pi-test-'));
  try {
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      // --disable-workspace-trust: the fixture workspace opens fully TRUSTED
      // (the trust service reports isTrusted=true when the feature is off),
      // so trust-gated paths (context-item revalidation, activation) run for
      // real instead of silently testing the restricted mode.
      launchArgs: [
        testWorkspace,
        '--disable-extensions',
        '--disable-workspace-trust',
        `--user-data-dir=${join(profile, 'user')}`,
        `--extensions-dir=${join(profile, 'extensions')}`,
      ],
    });
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
}

void main();
