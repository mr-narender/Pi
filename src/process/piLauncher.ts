import { existsSync, realpathSync, readFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import type { PiRpcSettings } from '../config/settings';

export interface PathPiInfo {
  binPath: string;
  /** npm package root (importable by the shared runtime); undefined when the
   * binary can't be traced to @earendil-works/pi-coding-agent (e.g. wrappers). */
  packageRoot?: string;
  version?: string;
}

// #5 (hardening review): the shared-runtime host is a fork of Pi's rpc-mode,
// tested against THIS Pi line. A PATH install with a different MAJOR version
// may have moved internals — don't feed it to the host fork (chats still work
// via managed/per-chat paths). A newer MINOR is allowed with a warning.
export const TESTED_PI_VERSION = { major: 0, minor: 84 };

function parsePiVersion(version?: string): { major: number; minor: number } | undefined {
  const match = /^(\d+)\.(\d+)/.exec(version ?? '');
  return match ? { major: Number(match[1]), minor: Number(match[2]) } : undefined;
}

let compatLogged = false;

/** PATH pi's package root, gated on host-fork compatibility. */
export function usablePathPiRoot(logger?: {
  warn(message: string): void;
  info(message: string): void;
}): string | undefined {
  const info = detectPathPi();
  if (!info?.packageRoot) {
    return undefined;
  }
  const parsed = parsePiVersion(info.version);
  if (parsed && parsed.major !== TESTED_PI_VERSION.major) {
    if (!compatLogged) {
      compatLogged = true;
      logger?.warn(
        `PATH pi v${info.version} is a different MAJOR than the tested v${TESTED_PI_VERSION.major}.${TESTED_PI_VERSION.minor} — not using it for the shared runtime (falling back to managed/per-chat).`
      );
    }
    return undefined;
  }
  if (parsed && parsed.minor > TESTED_PI_VERSION.minor && !compatLogged) {
    compatLogged = true;
    logger?.info(
      `PATH pi v${info.version} is newer than the tested v${TESTED_PI_VERSION.major}.${TESTED_PI_VERSION.minor} — using it; if chats misbehave, set piRpc.piSource='external'.`
    );
  }
  return info.packageRoot;
}

let cachedPathPi: PathPiInfo | null | undefined;

/** Find an EXISTING `pi` on PATH and resolve its npm package root. Cached. */
export function detectPathPi(): PathPiInfo | undefined {
  if (cachedPathPi !== undefined) {
    return cachedPathPi ?? undefined;
  }
  const names = process.platform === 'win32' ? ['pi.cmd', 'pi.exe', 'pi'] : ['pi'];
  let bin: string | undefined;
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) {
      continue;
    }
    for (const name of names) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) {
        bin = candidate;
        break;
      }
    }
    if (bin) {
      break;
    }
  }
  if (!bin) {
    cachedPathPi = null;
    return undefined;
  }
  let packageRoot: string | undefined;
  let version: string | undefined;
  try {
    let dir = dirname(realpathSync(bin));
    for (let hop = 0; hop < 6 && dir !== dirname(dir); hop += 1) {
      const pkgPath = join(dir, 'package.json');
      if (existsSync(pkgPath)) {
        try {
          const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
            name?: string;
            version?: string;
          };
          if (pkg.name === '@earendil-works/pi-coding-agent') {
            packageRoot = dir;
            version = pkg.version;
            break;
          }
        } catch {
          /* unreadable package.json — keep walking */
        }
      }
      dir = dirname(dir);
    }
  } catch {
    /* realpath failed — binary still usable as an external subprocess */
  }
  cachedPathPi = { binPath: bin, packageRoot, version };
  return cachedPathPi;
}

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
