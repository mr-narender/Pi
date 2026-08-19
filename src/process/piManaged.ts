import * as vscode from 'vscode';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import type { DiagnosticsLogger } from '../diagnostics/logger';

const PI_PACKAGE = '@earendil-works/pi-coding-agent';

function managedDir(context: vscode.ExtensionContext): string {
  return join(context.globalStorageUri.fsPath, 'pi');
}

/** Root of the installed Pi package (what the shared host imports from). */
export function managedPiRoot(context: vscode.ExtensionContext): string {
  return join(managedDir(context), 'node_modules', '@earendil-works', 'pi-coding-agent');
}

export function managedPiCliPath(context: vscode.ExtensionContext): string {
  return join(managedPiRoot(context), 'dist', 'cli.js');
}

export function installedManagedVersion(context: vscode.ExtensionContext): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(join(managedPiRoot(context), 'package.json'), 'utf8')) as {
      version?: string;
    };
    return typeof pkg.version === 'string' ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}

// Single-flight per extension-host process: every caller (activation, first chat,
// parallel chats racing) awaits the SAME bootstrap/update pass.
let preparePromise: Promise<string | undefined> | undefined;

/**
 * #3 (managed, now the default): bootstrap Pi into globalStorage so the VSIX
 * stays tiny (~1 MB, no vendored agent). First run installs the LATEST Pi from
 * npm (needs npm + network once); later runs return instantly and check npm in
 * the same pass — if a newer Pi exists it is updated before the first session
 * starts. Returns the cli.js path, or undefined if bootstrap failed.
 */
export function ensureManagedPi(
  context: vscode.ExtensionContext,
  logger: DiagnosticsLogger
): Promise<string | undefined> {
  // (On bootstrap FAILURE prepareManagedPi resets this so a later chat retries.)
  preparePromise ??= prepareManagedPi(context, logger);
  return preparePromise;
}

async function prepareManagedPi(
  context: vscode.ExtensionContext,
  logger: DiagnosticsLogger
): Promise<string | undefined> {
  const cli = managedPiCliPath(context);
  const dir = managedDir(context);
  const installed = existsSync(cli) ? installedManagedVersion(context) : undefined;

  if (!installed) {
    logger.info(`Bootstrapping managed Pi (latest) into ${dir}…`);
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({ name: 'pi-managed', private: true, version: '0.0.0' })
      );
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Pi: installing the agent (first run)…',
          cancellable: false,
        },
        () => npmInstall(dir, 'latest', logger)
      );
    } catch (error) {
      logger.error(
        `Managed Pi bootstrap failed: ${error instanceof Error ? error.message : String(error)}`
      );
      preparePromise = undefined; // allow retry on next start attempt
      void vscode.window.showErrorMessage(
        `Pi: could not auto-install the agent. Ensure npm is on PATH and you're online once, or set piRpc.piSource to 'external'.`
      );
      return undefined;
    }
    const version = installedManagedVersion(context);
    logger.info(`Managed Pi installed: ${version ?? '(unknown version)'}`);
    return existsSync(cli) ? cli : undefined;
  }

  // Already installed: silently check npm for a newer release and update BEFORE
  // the first session starts (so running chats never have Pi swapped under them).
  const latest = await latestPiVersion(logger);
  if (latest && latest !== installed) {
    logger.info(`Managed Pi update available: ${installed} -> ${latest}. Updating…`);
    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Pi: updating the agent ${installed} → ${latest}…`,
          cancellable: false,
        },
        () => npmInstall(dir, latest, logger)
      );
      logger.info(`Managed Pi updated to ${latest}`);
    } catch (error) {
      // Keep using the working install — never block on a failed update.
      logger.warn(
        `Managed Pi update failed (staying on ${installed}): ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  } else {
    logger.info(`Managed Pi ${installed} is current${latest ? '' : ' (npm check unavailable)'}`);
  }
  return cli;
}

/** `npm view <pkg> version` with a hard timeout; undefined when offline/slow. */
function latestPiVersion(logger: DiagnosticsLogger, timeoutMs = 8000): Promise<string | undefined> {
  return new Promise((resolve) => {
    const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const child = spawn(npmCmd, ['view', PI_PACKAGE, 'version'], {
      shell: process.platform === 'win32',
      windowsHide: true,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve(undefined);
    }, timeoutMs);
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.once('error', () => {
      clearTimeout(timer);
      resolve(undefined);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      const version = out.trim();
      if (code === 0 && /^\d+\.\d+\.\d+/.test(version)) {
        resolve(version);
      } else {
        logger.warn(`npm view ${PI_PACKAGE} failed (code=${String(code)})`);
        resolve(undefined);
      }
    });
  });
}

function npmInstall(cwd: string, versionOrTag: string, logger: DiagnosticsLogger): Promise<void> {
  return new Promise((resolve, reject) => {
    const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const child = spawn(
      npmCmd,
      [
        'install',
        `${PI_PACKAGE}@${versionOrTag}`,
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
