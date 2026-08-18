import { existsSync } from 'node:fs';
import type { PiRpcSettings } from '../config/settings';

// Absolute path to the bundled Pi CLI entry (vendor/pi/dist/cli.js), resolved
// from the extension install location at activation. Undefined until set (or if
// the extension was built without the vendored Pi).
let bundledCliPath: string | undefined;

export function setBundledPiCliPath(path: string | undefined): void {
  bundledCliPath = path;
}

export function bundledPiAvailable(): boolean {
  return typeof bundledCliPath === 'string' && existsSync(bundledCliPath);
}

export interface PiLaunchPlan {
  /** Executable to spawn. */
  command: string;
  /** Args inserted BEFORE the normal Pi args (e.g. the cli.js path). */
  prefixArgs: string[];
  /** Extra env for the child (e.g. ELECTRON_RUN_AS_NODE for the bundled run). */
  extraEnv: Record<string, string>;
  /** Whether the child is a direct binary (no shell) vs. the external `pi` shim. */
  usingBundled: boolean;
  /** For logging. */
  label: string;
}

/**
 * Decide how to launch Pi.
 *
 * - `bundled` (default): run the vendored `dist/cli.js` with VS Code's OWN Node
 *   runtime (`process.execPath` + ELECTRON_RUN_AS_NODE=1). VS Code 1.9x ships
 *   Node 24, which satisfies Pi's `engines: node >=22.19`, so no external `pi`
 *   install and no bundled Node binary are needed.
 * - `external`: run the user's `pi` on PATH (or the `piRpc.executable` override).
 *
 * Falls back to external automatically if the bundle is missing.
 */
export function resolvePiLaunch(settings: PiRpcSettings): PiLaunchPlan {
  const preferExternal = settings.piSource === 'external';
  if (!preferExternal && bundledPiAvailable() && bundledCliPath) {
    return {
      command: process.execPath,
      prefixArgs: [bundledCliPath],
      extraEnv: { ELECTRON_RUN_AS_NODE: '1' },
      usingBundled: true,
      label: `bundled Pi (${bundledCliPath})`,
    };
  }
  return {
    command: settings.executable,
    prefixArgs: [],
    extraEnv: {},
    usingBundled: false,
    label: `external Pi ('${settings.executable}')`,
  };
}
