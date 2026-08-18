import { existsSync } from 'node:fs';
import type { PiRpcSettings } from '../config/settings';

// cli.js locations, set at activation. `bundled` = vendored in the VSIX;
// `managed` = auto-installed into the extension's globalStorage (#3).
let bundledCliPath: string | undefined;
let managedCliPath: string | undefined;

export function setBundledPiCliPath(path: string | undefined): void {
  bundledCliPath = path;
}
export function setManagedPiCliPath(path: string | undefined): void {
  managedCliPath = path;
}
export function bundledPiAvailable(): boolean {
  return typeof bundledCliPath === 'string' && existsSync(bundledCliPath);
}

export type PiLaunchMode = 'subprocess' | 'worker';

export interface PiLaunchPlan {
  mode: PiLaunchMode;
  /** subprocess: executable to spawn. */
  command: string;
  /** subprocess: args before the Pi args (e.g. the cli.js path for the bundled run). */
  prefixArgs: string[];
  /** worker: the cli.js to run in-process. */
  cliPath?: string;
  extraEnv: Record<string, string>;
  usingBundled: boolean;
  label: string;
}

function vendoredCli(): string | undefined {
  return bundledCliPath && existsSync(bundledCliPath) ? bundledCliPath : undefined;
}
function managedCli(): string | undefined {
  return managedCliPath && existsSync(managedCliPath) ? managedCliPath : undefined;
}

function bundledSubprocess(cli: string, label: string): PiLaunchPlan {
  // Run the vendored/managed cli.js with VS Code's own Node (Electron-as-node);
  // its Node 24 satisfies Pi's engines: node >=22.19.
  return {
    mode: 'subprocess',
    command: process.execPath,
    prefixArgs: [cli],
    extraEnv: { ELECTRON_RUN_AS_NODE: '1' },
    usingBundled: true,
    label,
  };
}
function externalSubprocess(settings: PiRpcSettings): PiLaunchPlan {
  return {
    mode: 'subprocess',
    command: settings.executable,
    prefixArgs: [],
    extraEnv: {},
    usingBundled: false,
    label: `external Pi ('${settings.executable}')`,
  };
}

/**
 * Decide how to launch Pi based on `piRpc.piSource`:
 * - `bundled` (default): vendored cli.js in an OS subprocess (VS Code Node).
 * - `inprocess`: vendored cli.js in an in-process worker thread (no subprocess).
 * - `managed`: cli.js auto-installed into globalStorage, in an OS subprocess.
 * - `external`: the user's `pi` on PATH / `piRpc.executable`.
 * Each falls back to the external `pi` if its target is unavailable.
 */
export function resolvePiLaunch(settings: PiRpcSettings): PiLaunchPlan {
  switch (settings.piSource) {
    case 'external':
      return externalSubprocess(settings);
    case 'inprocess': {
      const cli = vendoredCli() ?? managedCli();
      if (cli) {
        return {
          mode: 'worker',
          command: process.execPath,
          prefixArgs: [],
          cliPath: cli,
          extraEnv: {},
          usingBundled: true,
          label: `in-process worker (${cli})`,
        };
      }
      return externalSubprocess(settings);
    }
    case 'managed': {
      const managed = managedCli();
      if (managed) {
        return bundledSubprocess(managed, `managed Pi (${managed})`);
      }
      const vendored = vendoredCli();
      if (vendored) {
        return bundledSubprocess(vendored, `bundled Pi (managed not ready) (${vendored})`);
      }
      return externalSubprocess(settings);
    }
    case 'bundled':
    default: {
      const vendored = vendoredCli();
      if (vendored) {
        return bundledSubprocess(vendored, `bundled Pi (${vendored})`);
      }
      return externalSubprocess(settings);
    }
  }
}
