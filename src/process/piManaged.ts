import * as vscode from 'vscode';
import { existsSync, mkdirSync, writeFileSync, readFileSync, renameSync } from 'node:fs';
import { rm } from 'node:fs/promises';
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
  // A previously staged update applies NOW (fast dir renames), before anything
  // has imported Pi in this window — the running window is never hot-swapped.
  applyStagedUpdate(context, logger);
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

  // Already installed: resolve INSTANTLY (opening a chat must never wait on the
  // network). The latest-version check + download run in the background and are
  // STAGED to a side directory; the staged copy is applied on the next window
  // (re)load by applyStagedUpdate above.
  void backgroundUpdateCheck(context, logger, installed);
  return cli;
}

function stagingDir(context: vscode.ExtensionContext): string {
  return join(managedDir(context), 'staging');
}

function stagedCliPath(context: vscode.ExtensionContext): string {
  return join(
    stagingDir(context),
    'node_modules',
    '@earendil-works',
    'pi-coding-agent',
    'dist',
    'cli.js'
  );
}

/** Swap a fully staged update into place via dir renames (ms, no network). */
function applyStagedUpdate(context: vscode.ExtensionContext, logger: DiagnosticsLogger): void {
  if (!existsSync(stagedCliPath(context))) {
    return;
  }
  const liveModules = join(managedDir(context), 'node_modules');
  const stagedModules = join(stagingDir(context), 'node_modules');
  const oldModules = join(managedDir(context), `node_modules.old-${Date.now()}`);
  try {
    if (existsSync(liveModules)) {
      renameSync(liveModules, oldModules);
    }
    renameSync(stagedModules, liveModules);
    logger.info(`Applied staged Pi update → ${installedManagedVersion(context) ?? 'unknown'}`);
  } catch (error) {
    logger.warn(
      `Could not apply staged Pi update: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  // Old tree + staging leftovers are big (thousands of files) — clean up async.
  void rm(oldModules, { recursive: true, force: true }).catch(() => undefined);
  void rm(stagingDir(context), { recursive: true, force: true }).catch(() => undefined);
}

let updateCheckStarted = false;
async function backgroundUpdateCheck(
  context: vscode.ExtensionContext,
  logger: DiagnosticsLogger,
  installed: string
): Promise<void> {
  if (updateCheckStarted) {
    return;
  }
  updateCheckStarted = true;
  const latest = await latestPiVersion(logger);
  if (!latest || latest === installed) {
    logger.info(
      `Managed Pi ${installed} is current${latest ? '' : ' (npm check unavailable/offline)'}`
    );
    return;
  }
  if (existsSync(stagedCliPath(context))) {
    logger.info(`Pi update already staged; applies on next reload.`);
    return;
  }
  logger.info(`Managed Pi update ${installed} → ${latest}: downloading in background…`);
  const dir = stagingDir(context);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'pi-managed-staging', private: true, version: '0.0.0' })
    );
    await npmInstall(dir, latest, logger);
    logger.info(`Pi ${latest} staged — it will activate on the next VS Code reload.`);
  } catch (error) {
    logger.warn(
      `Background Pi update failed (staying on ${installed}): ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    void rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
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
