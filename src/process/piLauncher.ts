import { existsSync, realpathSync, readFileSync, accessSync, constants, statSync } from 'node:fs';
import { delimiter, dirname, join, resolve, isAbsolute } from 'node:path';
import type { PiRpcSettings } from '../config/settings';

export interface PathPiInfo {
  binPath: string;
  /** npm package root (importable by the shared runtime); undefined when the
   * binary can't be traced to @earendil-works/pi-coding-agent (e.g. wrappers). */
  packageRoot?: string;
  version?: string;
}

// Exact audited contracts only: never admit a new minor/major by semver range.
export const TESTED_PI_VERSION = { major: 1, minor: 0 };
export const SUPPORTED_PI_SDK_VERSIONS = ['0.99.1', '0.99.2', '1.0.0', '1.0.4'] as const;
export function isSupportedPiSdkVersion(version: unknown): version is string {
  return SUPPORTED_PI_SDK_VERSIONS.includes(version as (typeof SUPPORTED_PI_SDK_VERSIONS)[number]);
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
  const root = verifiedSdkRoot(info.binPath);
  if (!root && !compatLogged) {
    compatLogged = true;
    logger?.warn(
      `PATH pi v${info.version} has no audited canonical SDK contract; using stock RPC only.`
    );
  }
  return root;
}

/** Resolve ONLY the chosen JavaScript CLI, never substitute an unrelated PATH SDK. */
export function selectedSdkRoot(settings: PiRpcSettings): string | undefined {
  return resolvePiLaunch(settings).sdkRoot;
}

function verifiedSdkRoot(cli: string): string | undefined {
  try {
    const realCli = realpathSync(cli);
    let dir = dirname(realCli);
    for (let i = 0; i < 6 && dir !== dirname(dir); i++, dir = dirname(dir)) {
      const pkgPath = join(dir, 'package.json');
      if (!existsSync(pkgPath)) continue;
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
        name?: string;
        version?: string;
        bin?: { pi?: string };
      };
      if (
        pkg.name === '@earendil-works/pi-coding-agent' &&
        isSupportedPiSdkVersion(pkg.version) &&
        pkg.bin?.pi &&
        realCli === realpathSync(join(dir, pkg.bin.pi))
      )
        return dir;
    }
  } catch {
    /* Unknown wrapper/binary remains stock-only. */
  }
  return undefined;
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
  readonly sdkRoot?: string;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly mode: PiLaunchMode;
  /** subprocess: executable to spawn. */
  readonly command: string;
  /** subprocess: args before the Pi args (e.g. the cli.js path for the bundled run). */
  readonly prefixArgs: readonly string[];
  /** worker: the cli.js to run in-process. */
  readonly cliPath?: string;
  readonly extraEnv: Readonly<Record<string, string>>;
  readonly usingBundled: boolean;
  readonly label: string;
}

function vendoredCli(): string | undefined {
  return bundledCliPath && existsSync(bundledCliPath) ? bundledCliPath : undefined;
}
function managedCli(): string | undefined {
  return managedCliPath && existsSync(managedCliPath) ? managedCliPath : undefined;
}

type LaunchChoice = Omit<PiLaunchPlan, 'sdkRoot' | 'env' | 'cwd'>;

function bundledSubprocess(cli: string, label: string): LaunchChoice {
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
function externalSubprocess(settings: PiRpcSettings): LaunchChoice {
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
export function resolvePiLaunch(
  settings: PiRpcSettings,
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd()
): PiLaunchPlan {
  const configuredExecutable = settings.executable !== 'pi';
  const pathExecutable = resolveExecutable(settings.executable, env, cwd);
  const existingPathPi =
    settings.piSource === 'managed' &&
    (() => {
      try {
        accessSync(pathExecutable, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
        return statSync(pathExecutable).isFile();
      } catch {
        return false;
      }
    })();
  const choice =
    configuredExecutable || existingPathPi
      ? externalSubprocess(settings)
      : choosePiLaunch(settings);
  const launchCwd = resolve(cwd);
  const launchEnv = Object.freeze({ ...env, ...choice.extraEnv });
  const cliPath = choice.cliPath ? realpathSync(choice.cliPath) : undefined;
  const prefixArgs = choice.prefixArgs.map((arg) => realpathSync(arg));
  const command = choice.usingBundled
    ? choice.command
    : resolveExecutable(choice.command, launchEnv, launchCwd);
  return Object.freeze({
    ...choice,
    command,
    cliPath,
    prefixArgs: Object.freeze(prefixArgs),
    extraEnv: Object.freeze({ ...choice.extraEnv }),
    env: launchEnv,
    cwd: launchCwd,
    sdkRoot: verifiedSdkRoot(cliPath ?? prefixArgs[0] ?? command),
  });
}

/** Launch discovery is deliberately uncached and uses the captured environment/cwd. */
function resolveExecutable(executable: string, env: NodeJS.ProcessEnv, cwd: string): string {
  if (isAbsolute(executable) || /[/\\\\]/.test(executable)) {
    const path = resolve(cwd, executable);
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  }
  const pathValue = env.PATH ?? (process.platform === 'win32' ? env.Path : undefined) ?? '';
  const extensions =
    process.platform === 'win32'
      ? ['', ...(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';')]
      : [''];
  for (const dir of pathValue.split(delimiter)) {
    for (const extension of extensions) {
      const candidate = resolve(cwd, dir, executable + extension);
      try {
        if (!statSync(candidate).isFile()) continue;
        accessSync(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
        return realpathSync(candidate);
      } catch {
        /* Continue PATH search. */
      }
    }
  }
  // Keep failure bound to this cwd, not a future PATH lookup after an async probe.
  return resolve(cwd, executable);
}

function choosePiLaunch(settings: PiRpcSettings): LaunchChoice {
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
