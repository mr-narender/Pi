import * as vscode from 'vscode';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import type { DiagnosticsLogger } from '../diagnostics/logger';

// Keep in sync with the vendored/tested Pi version.
const PINNED_PI_VERSION = '0.84.2';

function managedDir(context: vscode.ExtensionContext): string {
  return join(context.globalStorageUri.fsPath, 'pi');
}

export function managedPiCliPath(context: vscode.ExtensionContext): string {
  return join(
    managedDir(context),
    'node_modules',
    '@earendil-works',
    'pi-coding-agent',
    'dist',
    'cli.js'
  );
}

/**
 * #3 (managed): install Pi into the extension's globalStorage on demand so the
 * VSIX can stay tiny (no vendored agent) while still needing no manual `pi`
 * install. Returns the cli.js path, or undefined if the install failed. Requires
 * `npm` on PATH and network access on first run.
 */
export async function ensureManagedPi(
  context: vscode.ExtensionContext,
  logger: DiagnosticsLogger
): Promise<string | undefined> {
  const cli = managedPiCliPath(context);
  if (existsSync(cli)) {
    return cli;
  }
  const dir = managedDir(context);
  logger.info(`Installing managed Pi ${PINNED_PI_VERSION} into ${dir}…`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'pi-managed', private: true, version: '0.0.0' })
    );
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Pi: installing agent (${PINNED_PI_VERSION})…`,
        cancellable: false,
      },
      () => npmInstall(dir, PINNED_PI_VERSION, logger)
    );
  } catch (error) {
    logger.error(
      `Managed Pi install failed: ${error instanceof Error ? error.message : String(error)}`
    );
    void vscode.window.showErrorMessage(
      `Pi: could not auto-install the agent. Ensure npm is on PATH, or set piRpc.piSource to 'bundled'/'external'.`
    );
    return undefined;
  }
  return existsSync(cli) ? cli : undefined;
}

function npmInstall(cwd: string, version: string, logger: DiagnosticsLogger): Promise<void> {
  return new Promise((resolve, reject) => {
    const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const child = spawn(
      npmCmd,
      [
        'install',
        `@earendil-works/pi-coding-agent@${version}`,
        '--omit=dev',
        '--omit=optional',
        '--no-audit',
        '--no-fund',
      ],
      {
        cwd,
        shell: process.platform === 'win32',
        windowsHide: true,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    child.stdout.on('data', (d: Buffer) => logger.info(`[npm] ${d.toString().trim()}`));
    child.stderr.on('data', (d: Buffer) => logger.warn(`[npm] ${d.toString().trim()}`));
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`npm install exited ${String(code)}`))
    );
  });
}
