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
    launchArgs: [testWorkspace, '--disable-extensions'],
  });
}

void main();
