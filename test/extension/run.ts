import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
  execFileSync('node', ['./scripts/build.mjs'], { stdio: 'inherit' });
  const extensionDevelopmentPath = process.cwd();
  const extensionTestsPath = join(process.cwd(), 'test', 'extension', 'suite', 'index.cjs');
  const testWorkspace = join(process.cwd(), 'test', 'fixtures', 'workspace');
  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath,
    // --disable-workspace-trust: the fixture workspace opens fully TRUSTED
    // (the trust service reports isTrusted=true when the feature is off),
    // so trust-gated paths (context-item revalidation, activation) run for
    // real instead of silently testing the restricted mode.
    launchArgs: [testWorkspace, '--disable-extensions', '--disable-workspace-trust'],
  });
}

void main();
