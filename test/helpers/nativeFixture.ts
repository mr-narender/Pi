import {
  chmod,
  copyFile,
  mkdir,
  lstat,
  readdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

// Public package metadata only: never execute the PATH wrapper or read user config.
export async function resolveNativeCli() {
  const candidates = (process.env.PATH || '').split(sep === '/' ? ':' : ';');
  for (const directory of candidates) {
    try {
      const cli = await realpath(join(directory, 'pi'));
      const root = resolve(dirname(cli), '../..');
      const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
      if (
        pkg.name !== '@earendil-works/pi-coding-agent' ||
        !['0.99.1', '0.99.2', '1.0.0', '1.0.1'].includes(pkg.version) ||
        pkg.bin?.pi !== 'dist/bundle/cli.js'
      )
        continue;
      if (cli !== join(root, pkg.bin.pi)) continue;
      return { root, cli, version: pkg.version as string };
    } catch {
      /* Not the selected public SDK package. */
    }
  }
  throw new Error(
    'Requires installed @earendil-works/pi-coding-agent 0.99.1, 0.99.2, 1.0.0 or 1.0.1 JS CLI'
  );
}

export interface NativeFixture {
  readonly root: string;
  readonly home: string;
  readonly cwd: string;
  readonly agentDir: string;
  readonly globalSettings: string;
  readonly projectSettings: string;
  readonly authFile: string;
  readonly modelsFile: string;
  readonly networkLog: string;
  readonly port: number;
  readonly requests: number;
  readonly summaryRequests: readonly unknown[];
  setSummaryOutcome(outcome: 'success' | 'failure' | 'hold'): void;
  readonly nodeArgs: readonly string[];
  readonly env: Readonly<NodeJS.ProcessEnv>;
  resetRequests(): void;
  linkSettings(scope: 'global' | 'project'): Promise<string>;
  dispose(): Promise<void>;
}

// Runtime identity, not TypeScript visibility or caller-controlled structural fields.
const ownedCompactVetoSource =
  "import { appendFileSync } from 'node:fs';\nimport { join } from 'node:path';\nexport default function ownedCompactVeto(pi) {\n  pi.on('session_before_compact', (event) => {\n    appendFileSync(\n      join(process.cwd(), 'compact-veto-trace.jsonl'),\n      JSON.stringify({\n        type: event.type,\n        reason: event.reason,\n        instructions: event.customInstructions,\n        cancel: true,\n      }) + '\\n'\n    );\n    return { cancel: true };\n  });\n}\n";

// Capture the selected package once; reject external replacement before any spawn.
// This is runtime identity, not an exemption from native fixture authority.
const sdkContractFiles = [
  'package.json',
  'dist/core/agent-session.js',
  'dist/core/agent-session-services.js',
  'dist/core/agent-session-runtime.js',
  'dist/core/model-runtime.js',
  'dist/core/auth-storage.js',
  'dist/core/session-manager.js',
  'dist/core/session-export.js',
  'dist/core/settings-manager.js',
  'dist/core/model-resolver.js',
  'dist/main.js',
  'dist/index.js',
  'dist/bundle/cli.js',
  'dist/extensions/index.js',
  'dist/core/output-guard.js',
  'dist/utils/shell.js',
  'dist/modes/interactive/theme/theme.js',
  'dist/modes/json-event.js',
  'dist/modes/rpc/jsonl.js',
  'node_modules/@earendil-works/pi-ai/dist/models.js',
];
async function sdkIdentity(sdk: Awaited<ReturnType<typeof resolveNativeCli>>) {
  const root = await lstat(sdk.root);
  const cli = await lstat(sdk.cli);
  const hashes = await Promise.all(
    sdkContractFiles.map(async (name) =>
      createHash('sha256')
        .update(await readFile(join(sdk.root, name)))
        .digest('hex')
    )
  );
  return JSON.stringify([
    await realpath(sdk.root),
    root.dev,
    root.ino,
    await realpath(sdk.cli),
    cli.dev,
    cli.ino,
    cli.size,
    cli.mtimeMs,
    hashes,
  ]);
}

const ownedLifecycleVetoSource =
  "export default function ownedLifecycleVeto(pi) {\n  pi.on('session_before_switch', () => ({ cancel: true }));\n  pi.on('session_before_fork', () => ({ cancel: true }));\n  pi.on('session_before_tree', () => ({ cancel: true }));\n  pi.on('session_shutdown', () => {\n    throw new Error('owned disposal failure');\n  });\n}\n";
type NativeProfile =
  | 'default'
  | 'scopes'
  | 'compact'
  | 'compact-veto'
  | 'image-effects'
  | 'lifecycle-veto';
interface OwnedState {
  readonly profile: NativeProfile;
  readonly vetoAsset?: string;
  root: string;
  cwd: string;
  dev: number;
  ino: number;
  sdk: Awaited<ReturnType<typeof resolveNativeCli>>;
  sdkIdentity: string;
  env: NodeJS.ProcessEnv;
  nodeArgs: string[];
  preload: string;
  preloadBytes: Buffer;
  requiredPaths: string[];
  disposed: boolean;
  hostAssets?: Map<string, Buffer>;
}
const ownedFixtures = new WeakMap<NativeFixture, OwnedState>();

async function validateOwned(state: OwnedState) {
  if (state.disposed) throw new Error('Disposed owned native fixture');
  if ((await sdkIdentity(state.sdk)) !== state.sdkIdentity)
    throw new Error('Selected native SDK identity changed');
  const rootStat = await lstat(state.root);
  if (
    !rootStat.isDirectory() ||
    rootStat.dev !== state.dev ||
    rootStat.ino !== state.ino ||
    (rootStat.mode & 0o777) !== 0o700 ||
    (await realpath(state.root)) !== state.root
  )
    throw new Error('Unowned native root identity');
  const check = async (path: string) => {
    const canonical = await realpath(path);
    const inside = relative(state.root, canonical);
    if (isAbsolute(inside) || inside === '..' || inside.startsWith('..' + sep))
      throw new Error('Unowned native symlink escape');
    return lstat(path);
  };
  // Inspect names/ownership only, never read an escaping symlink target's contents.
  const walk = async (path: string): Promise<void> => {
    const entry = await check(path);
    if (entry.isDirectory()) for (const name of await readdir(path)) await walk(join(path, name));
  };
  await walk(state.root);
  for (const path of state.requiredPaths) await check(path);
  for (const [asset, bytes] of state.hostAssets ?? [])
    if (!(await readFile(asset)).equals(bytes)) throw new Error('Unowned host asset mutation');
  if (!(await readFile(state.preload)).equals(state.preloadBytes))
    throw new Error('Unowned native security preloader mutation');
}

export async function createNativeFixture(
  profile: NativeProfile = 'default'
): Promise<NativeFixture> {
  if (
    !['default', 'scopes', 'compact', 'compact-veto', 'image-effects', 'lifecycle-veto'].includes(
      profile
    )
  )
    throw new Error('Unowned fixture profile');
  if (Number(process.versions.node.split('.')[0]) < 26)
    throw new Error('Native fixture requires Node 26 permission network controls');
  const sdk = await resolveNativeCli();
  const selectedIdentity = await sdkIdentity(sdk);
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pi-native-isolated-')));
  await chmod(root, 0o700);
  const home = join(root, 'home');
  const cwd = join(root, 'project');
  const agentDir = join(home, '.pi', 'agent');
  const dirs = [
    home,
    cwd,
    agentDir,
    join(cwd, '.pi'),
    join(cwd, '.git'), // Owned ancestor-discovery boundary; never inspect a parent repository.
    join(root, 'tmp'),
    join(root, 'config'),
    join(root, 'cache'),
    join(root, 'data'),
    join(root, 'state'),
    join(root, 'bin'),
  ];
  for (const path of dirs) await mkdir(path, { recursive: true, mode: 0o700 });
  const globalSettings = join(agentDir, 'settings.json');
  const projectSettings = join(cwd, '.pi', 'settings.json');
  const authFile = join(agentDir, 'auth.json');
  const modelsFile = join(agentDir, 'models.json');
  const networkLog = join(root, 'network.jsonl');
  const preload = join(root, 'network-denial.cjs');
  await copyFile(resolve('test/helpers/network-denial.cjs'), preload);
  await writeFile(networkLog, '');
  let requests = 0;
  const summaryRequests: unknown[] = [];
  let summaryOutcome: 'success' | 'failure' | 'hold' = 'success';
  const server = createServer((req, res) => {
    requests++;
    if (profile === 'compact' || profile === 'image-effects') {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        const payload = JSON.parse(body);
        summaryRequests.push(payload);
        if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
          res.writeHead(400).end();
          return;
        }
        if (summaryOutcome === 'hold') return;
        if (summaryOutcome === 'failure') {
          res.writeHead(400).end('owned synthetic failure');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const chunk = (delta: object, finish_reason: string | null = null) => ({
          id: 'owned-summary',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'ping',
          choices: [{ index: 0, delta, finish_reason }],
        });
        res.write(
          `data: ${JSON.stringify(chunk({ role: 'assistant', content: 'OWNED COMPACTION SUMMARY' }))}\n\n`
        );
        res.write(`data: ${JSON.stringify(chunk({}, 'stop'))}\n\n`);
        res.end('data: [DONE]\n\n');
      });
      return;
    }
    req.resume();
    if (profile === 'scopes') {
      res.writeHead(500).end('Scope operations must not call providers');
      return;
    }
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.writeHead(400).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunk = (delta: object, finish_reason: string | null = null) => ({
      id: 'fixture',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'ping',
      choices: [{ index: 0, delta, finish_reason }],
    });
    res.write(`data: ${JSON.stringify(chunk({ role: 'assistant', content: 'PING' }))}\n\n`);
    res.write(`data: ${JSON.stringify(chunk({}, 'stop'))}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  try {
    await new Promise<void>((ok, fail) => {
      server.once('error', fail);
      server.listen(0, '127.0.0.1', ok);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No fixture TCP port');
    const port = address.port;
    const provider = {
      api: 'openai-completions',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: 'fixture-dummy-nonsecret',
      models: [
        {
          id: 'ping',
          name: 'Fixture PING',
          reasoning: false,
          input: profile === 'image-effects' ? ['text', 'image'] : ['text'],
          contextWindow: 8192,
          maxTokens: 128,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ],
    };
    await writeFile(
      modelsFile,
      JSON.stringify({
        providers: {
          'fixture-alpha':
            profile === 'scopes'
              ? {
                  ...provider,
                  models: [
                    ...provider.models,
                    { ...provider.models[0], id: 'colon:id', name: 'Owned colon ID' },
                  ],
                }
              : provider,
          'fixture-beta': provider,
        },
      })
    );
    await writeFile(authFile, '{}');
    const settings = {
      packages: [],
      extensions: [],
      skills: [],
      prompts: [],
      defaultProvider: 'fixture-alpha',
      defaultModel: 'ping',
      compaction: { enabled: false },
      retry: { enabled: false },
    };
    await writeFile(globalSettings, JSON.stringify(settings));
    await writeFile(projectSettings, '{}');
    const env: NodeJS.ProcessEnv = {
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: join(root, 'config'),
      XDG_CACHE_HOME: join(root, 'cache'),
      XDG_DATA_HOME: join(root, 'data'),
      XDG_STATE_HOME: join(root, 'state'),
      TMPDIR: join(root, 'tmp'),
      TMP: join(root, 'tmp'),
      TEMP: join(root, 'tmp'),
      PATH: join(root, 'bin'),
      PI_CODING_AGENT_DIR: agentDir,
      PI_TELEMETRY: '0',
      PI_SKIP_VERSION_CHECK: '1',
      PI_OFFLINE: '1',
      PI_FIXTURE_PORT: String(port),
      PI_FIXTURE_NETWORK_LOG: networkLog,
      LANG: 'en_US.UTF-8',
      TZ: 'UTC',
    };
    // No subprocesses, workers, addons, inspector or WASI permissions. SDK is read-only.
    const nodeArgs = [
      '--permission',
      `--allow-fs-read=${root}`,
      `--allow-fs-read=${sdk.root}`,
      `--allow-fs-write=${root}`,
      '--allow-net',
      '--require',
      preload,
    ];
    const vetoName =
      profile === 'compact-veto'
        ? 'compact-veto.mjs'
        : profile === 'lifecycle-veto'
          ? 'lifecycle-veto.mjs'
          : undefined;
    const vetoAsset = vetoName ? join(root, vetoName) : undefined;
    const ownedAssets = new Map<string, Buffer>();
    if (vetoAsset) {
      const bytes = await readFile(resolve('test/helpers', vetoName!));
      if (
        !bytes.equals(
          Buffer.from(
            profile === 'lifecycle-veto' ? ownedLifecycleVetoSource : ownedCompactVetoSource
          )
        )
      )
        throw new Error('Unowned veto source mutation');
      await writeFile(vetoAsset, bytes, { mode: 0o600 });
      ownedAssets.set(vetoAsset, bytes);
    }
    const rootStat = await lstat(root);
    const state: OwnedState = {
      profile,
      vetoAsset,
      hostAssets: ownedAssets,
      root,
      cwd,
      dev: rootStat.dev,
      ino: rootStat.ino,
      sdk,
      sdkIdentity: selectedIdentity,
      env: { ...env },
      nodeArgs: [...nodeArgs],
      preload,
      preloadBytes: await readFile(preload),
      requiredPaths: [
        ...dirs,
        globalSettings,
        projectSettings,
        authFile,
        modelsFile,
        networkLog,
        preload,
      ],
      disposed: false,
    };
    const fixture: NativeFixture = {
      root,
      home,
      cwd,
      agentDir,
      globalSettings,
      projectSettings,
      authFile,
      modelsFile,
      networkLog,
      port,
      nodeArgs: Object.freeze([...nodeArgs]),
      env: Object.freeze({ ...env }),
      get requests() {
        return requests;
      },
      get summaryRequests() {
        return Object.freeze([...summaryRequests]);
      },
      setSummaryOutcome(outcome) {
        if (profile !== 'compact' || !['success', 'failure', 'hold'].includes(outcome))
          throw new Error('Unowned summary outcome');
        summaryOutcome = outcome;
      },
      resetRequests() {
        requests = 0;
      },
      async linkSettings(scope) {
        await validateOwned(state);
        if (scope !== 'global' && scope !== 'project') throw new Error('Unowned settings scope');
        const source = scope === 'global' ? globalSettings : projectSettings;
        const target = join(root, `${scope}-settings-target.json`);
        await copyFile(source, target);
        await rm(source);
        await symlink(target, source);
        return target;
      },
      async dispose() {
        if (state.disposed) return;
        state.disposed = true;
        server.closeAllConnections();
        await new Promise<void>((ok) => server.close(() => ok()));
        const current = await lstat(root);
        if (!current.isDirectory() || current.dev !== state.dev || current.ino !== state.ino)
          throw new Error('Unowned native root identity during disposal');
        await rm(root, { recursive: true, force: true });
      },
    };
    ownedFixtures.set(fixture, state);
    return Object.freeze(fixture);
  } catch (error) {
    server.closeAllConnections();
    server.close();
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

/** Named, branded capability: only repository-owned host assets, no arbitrary script/argv/env.
 * Permissions remain owned root + read-only SDK, no workers/subprocesses.
 */
export async function nativeSdkHostPlan(
  fixture: NativeFixture,
  mode: 'shared' | 'dedicated',
  scenario: 'default' | 'patterns' | 'project' | 'parity' | 'engine' = 'default'
) {
  const state = ownedFixtures.get(fixture);
  if (
    !state ||
    (mode !== 'shared' && mode !== 'dedicated') ||
    !['default', 'patterns', 'project', 'parity', 'engine'].includes(scenario)
  )
    throw new Error('Unowned SDK host fixture');
  await validateOwned(state);
  if (!state.hostAssets?.has(join(state.root, 'pi-multi-host.mjs'))) {
    const assets = state.hostAssets ?? new Map<string, Buffer>();
    for (const name of [
      'pi-multi-host.mjs',
      'scoped-models.mjs',
      'startup-adapter.mjs',
      'preferences.mjs',
      'auth-commands.mjs',
      'import-commands.mjs',
      'import-validation.mjs',
    ]) {
      const source = resolve('host', name);
      const target = join(state.root, name);
      const original = await readFile(source);
      // The bundled SDK loader embeds dependency aliases; the unbundled loader
      // probes sibling package roots outside this read-only SDK authority.
      // Fixed veto profile only: no filesystem permission widening.
      const bytes =
        ['compact-veto', 'lifecycle-veto'].includes(state.profile) && name === 'pi-multi-host.mjs'
          ? Buffer.from(
              original
                .toString()
                .replace("piImport('dist/index.js')", "piImport('dist/bundle/index.js')")
            )
          : original;
      await writeFile(target, bytes, { mode: 0o600 });
      assets.set(target, bytes);
      state.requiredPaths.push(target);
    }
    state.hostAssets = assets;
  }
  await validateOwned(state);
  const openArgs = [
    '--mode',
    'rpc',
    '--offline',
    scenario === 'project' ? '--approve' : '--no-approve',
    '--no-session',
    '--no-extensions',
    '--no-skills',
    '--no-prompt-templates',
    '--no-context-files',
    '--no-tools',
  ];
  if (state.vetoAsset) openArgs.push('--extension', state.vetoAsset);
  if (scenario === 'patterns')
    openArgs.push(
      '--models',
      'fixture-beta/*:high,fixture-alpha/colon:id,fixture-alpha/ping:invalid,fixture-beta/ping,missing/*'
    );
  if (scenario === 'parity')
    openArgs.push(
      '--model',
      'fixture-beta/ping',
      '--thinking',
      'medium',
      '--system-prompt',
      'Owned fixture system',
      '--append-system-prompt',
      'Owned fixture append',
      '--name',
      'Owned parity'
    );
  return Object.freeze({
    command: process.execPath,
    args: Object.freeze([...state.nodeArgs, join(state.root, 'pi-multi-host.mjs')]),
    cwd: state.cwd,
    env: Object.freeze({
      ...state.env,
      PI_HOST_PI_ROOT: state.sdk.root,
      PI_HOST_DEDICATED: scenario === 'engine' && mode === 'dedicated' ? '1' : '0',
    }),
    open: Object.freeze({ type: 'open', cwd: state.cwd, args: Object.freeze(openArgs) }),
    mode,
  });
}

export async function nativePublicAuthPlan(fixture: NativeFixture, callbackBarrier = false) {
  const state = ownedFixtures.get(fixture);
  if (!state || state.profile !== 'scopes') throw new Error('Unowned public auth fixture');
  const host = await nativeSdkHostPlan(fixture, 'shared');
  const target = join(state.root, 'native-public-auth.mjs');
  if (!state.hostAssets!.has(target)) {
    const bytes = await readFile(resolve('test/helpers/native-public-auth.mjs'));
    await writeFile(target, bytes, { mode: 0o600 });
    state.hostAssets!.set(target, bytes);
    state.requiredPaths.push(target);
  }
  await validateOwned(state);
  return Object.freeze({
    ...host,
    args: Object.freeze([
      ...state.nodeArgs,
      target,
      ...(callbackBarrier ? ['--owned-callback-barrier'] : []),
    ]),
  });
}

export async function spawnNativePublicAuth(fixture: NativeFixture, callbackBarrier = false) {
  const plan = await nativePublicAuthPlan(fixture, callbackBarrier);
  return spawn(plan.command, [...plan.args], {
    cwd: plan.cwd,
    env: { ...plan.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

// Spawn internally from the branded identity; no mutable foreign plan is accepted.
export async function spawnNativeSdkHost(
  fixture: NativeFixture,
  mode: 'shared' | 'dedicated',
  scenario: 'default' | 'patterns' | 'project' | 'parity' | 'engine' = 'default'
) {
  const plan = await nativeSdkHostPlan(fixture, mode, scenario);
  return {
    child: spawn(plan.command, [...plan.args], {
      cwd: plan.cwd,
      env: { ...plan.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    }),
    open: plan.open,
  };
}

export async function nativeSpawnPlan(fixture: NativeFixture, extraArgs: string[] = []) {
  // No arbitrary CLI override can weaken resource, filesystem, auth or network isolation.
  if (extraArgs.length)
    throw new Error(
      'Native fixture disallows unowned CLI overrides; explicit owned extensions need a reviewed fixture API'
    );
  const state = ownedFixtures.get(fixture);
  if (!state) throw new Error('Unowned native fixture identity');
  await validateOwned(state);
  const sdk = state.sdk;
  return {
    command: process.execPath,
    args: [
      ...state.nodeArgs,
      sdk.cli,
      '--mode',
      'rpc',
      '--offline',
      '--no-approve',
      '--no-session',
      '--no-extensions',
      '--no-skills',
      '--no-prompt-templates',
      '--no-context-files',
      '--no-tools',
      ...(state.vetoAsset ? ['--extension', state.vetoAsset] : []),
    ],
    cwd: state.cwd,
    env: { ...state.env },
  };
}
