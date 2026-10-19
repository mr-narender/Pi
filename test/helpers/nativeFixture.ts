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
import { pathToFileURL } from 'node:url';
import { isSupportedPiSdkVersion } from '../../src/process/piLauncher';

// Public package metadata only: never execute a wrapper or read user config.
export async function resolveNativeCli(selection: 'supported-sdk' | 'path-cli' = 'supported-sdk') {
  if (selection !== 'supported-sdk' && selection !== 'path-cli')
    throw new Error('Unowned native runtime selection');
  const candidates = [
    ...(selection === 'supported-sdk' ? [resolve('.github/pi-sdk/node_modules/.bin')] : []),
    ...(process.env.PATH || '').split(sep === '/' ? ':' : ';'),
  ];
  for (const directory of candidates) {
    try {
      const cli = await realpath(join(directory, 'pi'));
      const root = resolve(dirname(cli), '../..');
      const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
      if (
        pkg.name !== '@earendil-works/pi-coding-agent' ||
        (selection === 'supported-sdk' && !isSupportedPiSdkVersion(pkg.version)) ||
        pkg.bin?.pi !== 'dist/bundle/cli.js'
      )
        continue;
      if (cli !== join(root, pkg.bin.pi)) continue;
      return { root, cli, version: pkg.version as string };
    } catch {
      /* Not the selected public SDK package. */
    }
  }
  throw new Error('Requires an installed supported @earendil-works/pi-coding-agent JS CLI');
}

export async function readNativeRpcTypes(sdkRoot = process.env.PI_SRC) {
  const root = sdkRoot ?? (await resolveNativeCli()).root;
  return readFile(join(root, 'dist/modes/rpc/rpc-types.d.ts'), 'utf8');
}

export async function resolveNativeSdkDependency(sdkRoot: string, dependencyFile: string) {
  const { resolveSdkDependencyFile } = await import(
    pathToFileURL(resolve('host/startup-adapter.mjs')).href
  );
  return resolveSdkDependencyFile(sdkRoot, dependencyFile) as string;
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
  setSummaryOutcome(outcome: 'success' | 'failure' | 'hold' | 'tool'): void;
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
];
async function sdkIdentity(sdk: Awaited<ReturnType<typeof resolveNativeCli>>) {
  const root = await lstat(sdk.root);
  const cli = await lstat(sdk.cli);
  const files = [
    ...sdkContractFiles.map((name) => join(sdk.root, name)),
    await resolveNativeSdkDependency(sdk.root, '@earendil-works/pi-ai/dist/models.js'),
  ];
  const hashes = await Promise.all(
    files.map(async (file) =>
      createHash('sha256')
        .update(await readFile(file))
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
const ownedStartupLifecycleSource =
  "import { appendFileSync, existsSync } from 'node:fs';\nimport { join } from 'node:path';\nexport default function ownedStartupLifecycle(pi) {\n  const trace = (data) =>\n    appendFileSync(join(process.cwd(), 'startup-trace.jsonl'), JSON.stringify(data) + '\\n');\n  pi.on('input', (event) => {\n    trace({ type: 'input', source: event.source, text: event.text });\n  });\n  pi.on('before_agent_start', async (event, ctx) => {\n    trace({\n      type: event.type,\n      messageType: event.messageType,\n      idle: ctx.isIdle(),\n      hasPrompt: 'prompt' in event,\n    });\n    if (event.messageType === 'user' && event.prompt.startsWith('owned start-block')) {\n      const deadline = Date.now() + 8000;\n      while (!existsSync(join(process.cwd(), 'startup-release'))) {\n        if (Date.now() > deadline) throw new Error('owned startup release timed out');\n        await new Promise((resolve) => setTimeout(resolve, 10));\n      }\n    }\n    return { message: { customType: 'owned-setup', content: 'OWNED RUN SETUP', display: false } };\n  });\n  pi.registerCommand('owned-custom', {\n    handler: async () => {\n      pi.sendMessage(\n        { customType: 'owned-pending', content: 'OWNED NEXT TURN', display: false },\n        { deliverAs: 'nextTurn' }\n      );\n      pi.sendMessage(\n        { customType: 'owned-custom', content: 'OWNED CUSTOM START', display: true },\n        { triggerTurn: true }\n      );\n    },\n  });\n}\n";

const ownedIdeDriverSource = `import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
export default function ownedIdeDriver(pi) {
  const trace = (event) => appendFileSync(join(process.cwd(), 'ide-native-trace.jsonl'), JSON.stringify(event) + '\\n');
  pi.on('input', (event) => trace({ type: 'input', source: event.source, text: event.text }));
  pi.registerCommand('owned-ide-tools', { handler: async (_args, ctx) => {
    ctx.ui.notify(JSON.stringify({ tools: pi.getAllTools().map((tool) => tool.name), active: pi.getActiveTools() }));
  } });
  pi.registerCommand('owned-ide-widget', { handler: async (_args, ctx) => {
    ctx.ui.setWidget('owned-passive-status', ['Owned passive status']);
  } });
  pi.registerCommand('owned-ide-question', { handler: async (_args, ctx) => {
    const answer = await ctx.ui.input('Owned ordinary question', 'ordinary placeholder');
    trace({ type: 'ordinary', answer });
  } });
}
`;

const ownedModelToolsDriverSource = `import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
export default function ownedModelTools(pi) {
  pi.on('input', event => appendFileSync(join(process.cwd(), 'model-tools-trace.jsonl'), JSON.stringify({ source: event.source, text: event.text }) + '\\n'));
  for (const exposure of ['direct', 'model-only', 'deferred', 'codemode', 'hidden']) {
    pi.registerTool({
      name: 'owned_' + exposure.replace('-', '_'), label: 'Owned ' + exposure,
      description: 'Owned fixed ' + exposure + ' tool', exposure,
      parameters: { type: 'object', properties: {} },
      execute: async () => ({ content: [{ type: 'text', text: 'Owned fixed tool result' }], details: {} }),
    });
  }
  pi.registerTool({ name: 'owned_excluded', label: 'Owned excluded', description: 'Excluded by the fixed CLI profile', parameters: { type: 'object', properties: {} }, execute: async () => ({ content: [{ type: 'text', text: 'Owned excluded result' }], details: {} }) });
  pi.registerCommand('owned-clear-model-tools', { handler: async () => { pi.setActiveTools([]); } });
  pi.registerCommand('owned-model-tools-widget', { handler: async (_args, ctx) => { ctx.ui.setWidget('owned-model-tools-status', ['Owned passive status']); } });
}
`;

const ownedExtensionUiDriverSource = `import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
export default function ownedExtensionUi(pi) {
  const trace = data => appendFileSync(join(process.cwd(), 'extension-ui-trace.jsonl'), JSON.stringify(data) + '\\n');
  pi.on('input', event => trace({ kind: 'input', source: event.source, text: event.text }));
  pi.registerCommand('owned-ui-input', { handler: async (_args, ctx) => { trace({ kind: 'input-result', value: await ctx.ui.input('Owned input', 'Owned placeholder') ?? null }); } });
  pi.registerCommand('owned-ui-input-timeout', { handler: async (_args, ctx) => { trace({ kind: 'input-result', value: await ctx.ui.input('Owned timeout input', 'Owned placeholder', { timeout: 100 }) ?? null }); } });
  pi.registerCommand('owned-ui-input-abort', { handler: async (_args, ctx) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30);
    try { trace({ kind: 'abort-result', value: await ctx.ui.input('Owned abort input', 'Owned placeholder', { signal: controller.signal }) ?? null }); }
    finally { clearTimeout(timer); }
  } });
  pi.registerCommand('owned-ui-input-pre-aborted', { handler: async (_args, ctx) => {
    const controller = new AbortController();
    controller.abort();
    trace({ kind: 'pre-aborted-result', value: await ctx.ui.input('Owned pre-aborted input', 'Owned placeholder', { signal: controller.signal }) ?? null });
  } });
  pi.registerCommand('owned-ui-select', { handler: async (_args, ctx) => { trace({ kind: 'select-result', value: await ctx.ui.select('Owned select', ['Owned A', 'Owned B']) ?? null }); } });
  pi.registerCommand('owned-ui-select-timeout', { handler: async (_args, ctx) => { trace({ kind: 'select-result', value: await ctx.ui.select('Owned timeout select', ['Owned A', 'Owned B'], { timeout: 100 }) ?? null }); } });
  pi.registerCommand('owned-ui-editor', { handler: async (_args, ctx) => { trace({ kind: 'editor-result', value: await ctx.ui.editor('Owned editor', 'Owned prefill') ?? null }); } });
  pi.registerCommand('owned-ui-write', { handler: async (_args, ctx) => {
    const before = ctx.ui.getEditorText();
    ctx.ui.setEditorText('Owned proposed text');
    trace({ kind: 'editor-write', before, after: ctx.ui.getEditorText() });
  } });
  pi.registerCommand('owned-ui-read', { handler: async (_args, ctx) => { trace({ kind: 'editor-read', text: ctx.ui.getEditorText() }); } });
  pi.registerCommand('owned-ui-custom', { handler: async (_args, ctx) => {
    const value = await ctx.ui.custom(() => { trace({ kind: 'custom-factory-executed' }); throw new Error('Owned terminal factory must not execute'); });
    trace({ kind: 'custom-result', value: value ?? null });
  } });
  pi.registerCommand('owned-ui-status', { handler: async (_args, ctx) => {
    ctx.ui.setStatus('owned-status', 'Owned status');
    ctx.ui.setWidget('owned-widget', ['Owned widget']);
    ctx.ui.setTitle('Owned title');
  } });
  pi.registerCommand('owned-ui-widget-factory', { handler: async (_args, ctx) => {
    ctx.ui.setWidget('owned-widget', () => { trace({ kind: 'widget-factory-executed' }); throw new Error('Owned widget factory must not execute'); });
  } });
}
`;

const ownedStartupUiDriverSource = `import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
export default function ownedStartupUi(pi) {
  pi.on('session_start', async (_event, ctx) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 500);
    try {
      const value = await ctx.ui.input('Owned startup input', 'Owned startup placeholder', { signal: controller.signal });
      appendFileSync(join(process.cwd(), 'startup-ui-trace.jsonl'), JSON.stringify({ value: value ?? null }) + '\\n');
    } finally { clearTimeout(timer); }
  });
}
`;

type NativeProfile =
  | 'default'
  | 'scopes'
  | 'compact'
  | 'compact-veto'
  | 'image-effects'
  | 'lifecycle-veto'
  | 'startup'
  | 'openrouter'
  | 'ide-tools'
  | 'model-tools'
  | 'extension-ui'
  | 'startup-ui'
  | 'mcp-status'
  | 'mcp-status-empty';
interface OwnedState {
  readonly profile: NativeProfile;
  readonly selectedSdk: boolean;
  readonly vetoAsset?: string;
  readonly ideAssets?: readonly string[];
  readonly modelToolsAsset?: string;
  readonly extensionUiAsset?: string;
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
  profile: NativeProfile = 'default',
  runtime: 'supported-sdk' | 'path-cli' | 'selected-sdk' = 'supported-sdk'
): Promise<NativeFixture> {
  if (
    ![
      'default',
      'scopes',
      'compact',
      'compact-veto',
      'image-effects',
      'lifecycle-veto',
      'startup',
      'openrouter',
      'ide-tools',
      'model-tools',
      'extension-ui',
      'startup-ui',
      'mcp-status',
      'mcp-status-empty',
    ].includes(profile)
  )
    throw new Error('Unowned fixture profile');
  if (
    runtime !== 'supported-sdk' &&
    runtime !== 'selected-sdk' &&
    (runtime !== 'path-cli' || !['ide-tools', 'mcp-status'].includes(profile))
  )
    throw new Error('Unowned fixture runtime selection');
  if (Number(process.versions.node.split('.')[0]) < 26)
    throw new Error('Native fixture requires Node 26 permission network controls');
  if (
    runtime === 'selected-sdk' &&
    ![
      'scopes',
      'startup',
      'openrouter',
      'ide-tools',
      'mcp-status',
      'model-tools',
      'extension-ui',
      'startup-ui',
    ].includes(profile)
  )
    throw new Error('Unowned selected SDK profile');
  const sdk = await resolveNativeCli(runtime === 'selected-sdk' ? 'path-cli' : runtime);
  if (
    runtime === 'selected-sdk' &&
    (sdk.version !== '1.3.0' || !isSupportedPiSdkVersion(sdk.version))
  )
    throw new Error('Selected SDK fixture requires the audited Pi 1.3.0 candidate');
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
  let summaryOutcome: 'success' | 'failure' | 'hold' | 'tool' = 'success';
  const server = createServer((req, res) => {
    requests++;
    if (profile === 'mcp-status') {
      if (req.method !== 'POST' || req.url !== '/mcp') {
        req.resume();
        res.writeHead(req.url === '/mcp-failed' ? 503 : 405).end();
        return;
      }
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const request = JSON.parse(body);
        if (request.id === undefined) {
          res.writeHead(202).end();
          return;
        }
        const result =
          request.method === 'initialize'
            ? {
                protocolVersion: request.params.protocolVersion,
                capabilities: { tools: {} },
                serverInfo: { name: 'owned-mcp-fixture', version: '1' },
              }
            : request.method === 'tools/list'
              ? {
                  tools: [
                    {
                      name: 'owned_read',
                      description: 'Owned fixture read-only tool; never executed',
                      inputSchema: { type: 'object', properties: {} },
                    },
                  ],
                }
              : {};
        res
          .writeHead(200, { 'Content-Type': 'application/json' })
          .end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
      });
      return;
    }
    if (profile === 'openrouter') {
      req.resume();
      const endpoint = req.url?.split('?')[0];
      if (req.method === 'GET' && endpoint === '/api/models/providers/openrouter') {
        res.writeHead(404).end();
      } else if (req.method === 'GET' && endpoint === '/v1/models/user') {
        const first = req.headers.authorization === 'Bearer owned-openrouter-key-one';
        const second = req.headers.authorization === 'Bearer owned-openrouter-key-two';
        if (!first && !second) {
          res.writeHead(401).end();
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(
          JSON.stringify({
            data: [
              {
                id: first ? 'openai/gpt-5-mini' : 'openai/gpt-5-nano',
                context_length: 24000,
                top_provider: { context_length: 32000, max_completion_tokens: 777 },
                pricing: {
                  prompt: '0.000002',
                  completion: '0.000004',
                  input_cache_read: '0.000001',
                },
              },
            ],
          })
        );
      } else res.writeHead(400).end();
      return;
    }
    if (['compact', 'image-effects', 'startup', 'ide-tools', 'model-tools'].includes(profile)) {
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
        if (
          profile === 'ide-tools' &&
          !payload.messages.some((message: any) => message.role === 'tool')
        ) {
          const operations = ['diagnostics', 'document_symbols', 'definitions', 'references'];
          const tool_calls = operations.map((operation, index) => ({
            index,
            id: `owned_ide_${operation}`,
            type: 'function',
            function: {
              name: `vscode_${operation}`,
              arguments: JSON.stringify({
                path: 'owned.ts',
                ...(index > 1 ? { line: 1, character: 1 } : {}),
              }),
            },
          }));
          res.write(`data: ${JSON.stringify(chunk({ role: 'assistant', tool_calls }))}\n\n`);
          res.write(`data: ${JSON.stringify(chunk({}, 'tool_calls'))}\n\n`);
          res.end('data: [DONE]\n\n');
          return;
        }
        if (
          summaryOutcome === 'tool' &&
          !payload.messages.some((message: any) => message.role === 'tool')
        ) {
          res.write(
            `data: ${JSON.stringify(chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'owned_ls', type: 'function', function: { name: 'ls', arguments: '{"path":"."}' } }] }))}\n\n`
          );
          res.write(`data: ${JSON.stringify(chunk({}, 'tool_calls'))}\n\n`);
          res.end('data: [DONE]\n\n');
          return;
        }
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
          ...(profile === 'openrouter'
            ? { openrouter: { baseUrl: `http://127.0.0.1:${port}/v1` } }
            : {}),
        },
      })
    );
    await writeFile(
      authFile,
      profile === 'openrouter'
        ? JSON.stringify({ openrouter: { type: 'api_key', key: 'owned-openrouter-key-one' } })
        : '{}'
    );
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
    if (profile === 'openrouter') delete env.PI_OFFLINE;
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
          : profile === 'startup'
            ? 'startup-lifecycle.mjs'
            : undefined;
    const vetoAsset = vetoName ? join(root, vetoName) : undefined;
    const ownedAssets = new Map<string, Buffer>();
    if (profile === 'mcp-status') {
      const config = join(agentDir, 'mcp.json');
      const bytes = Buffer.from(
        JSON.stringify({
          autoEnableCodemode: false,
          mcpServers: {
            'owned-connected': { url: `http://127.0.0.1:${port}/mcp`, exposure: 'hidden' },
            'owned-failed': { url: `http://127.0.0.1:${port}/mcp-failed`, exposure: 'hidden' },
            'owned-disabled': {
              url: `http://127.0.0.1:${port}/mcp-disabled`,
              enabled: false,
              exposure: 'hidden',
            },
            'owned-invalid': 'invalid fixed fixture configuration',
          },
        })
      );
      await writeFile(config, bytes, { mode: 0o600 });
      ownedAssets.set(config, bytes);
      const projectConfig = join(cwd, '.pi', 'mcp.json');
      const projectBytes = Buffer.from(
        JSON.stringify({
          mcpServers: {
            'owned-project-only': {
              url: `http://127.0.0.1:${port}/mcp`,
              enabled: false,
              exposure: 'hidden',
            },
          },
        })
      );
      await writeFile(projectConfig, projectBytes, { mode: 0o600 });
      ownedAssets.set(projectConfig, projectBytes);
    }
    const ideAssets =
      profile === 'ide-tools'
        ? [join(root, 'pi-vscode-ide.mjs'), join(root, 'ide-native-driver.mjs')]
        : [];
    if (ideAssets.length) {
      const resource = await readFile(resolve('resources/pi-vscode-ide.mjs'));
      for (const [index, target] of ideAssets.entries()) {
        const bytes = index === 0 ? resource : Buffer.from(ownedIdeDriverSource);
        await writeFile(target, bytes, { mode: 0o600 });
        ownedAssets.set(target, bytes);
      }
    }
    const modelToolsAsset =
      profile === 'model-tools' ? join(root, 'model-tools-driver.mjs') : undefined;
    if (modelToolsAsset) {
      const bytes = Buffer.from(ownedModelToolsDriverSource);
      await writeFile(modelToolsAsset, bytes, { mode: 0o600 });
      ownedAssets.set(modelToolsAsset, bytes);
    }
    const extensionUiAsset = ['extension-ui', 'startup-ui'].includes(profile)
      ? join(root, 'extension-ui-driver.mjs')
      : undefined;
    if (extensionUiAsset) {
      const bytes = Buffer.from(
        profile === 'startup-ui' ? ownedStartupUiDriverSource : ownedExtensionUiDriverSource
      );
      await writeFile(extensionUiAsset, bytes, { mode: 0o600 });
      ownedAssets.set(extensionUiAsset, bytes);
    }
    if (vetoAsset) {
      const bytes = await readFile(resolve('test/helpers', vetoName!));
      if (
        !bytes.equals(
          Buffer.from(
            profile === 'lifecycle-veto'
              ? ownedLifecycleVetoSource
              : profile === 'startup'
                ? ownedStartupLifecycleSource
                : ownedCompactVetoSource
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
      selectedSdk: runtime === 'selected-sdk',
      vetoAsset,
      ideAssets,
      modelToolsAsset,
      extensionUiAsset,
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
        if (
          !(
            (profile === 'compact' && ['success', 'failure', 'hold', 'tool'].includes(outcome)) ||
            (profile === 'model-tools' && ['success', 'hold'].includes(outcome))
          )
        )
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
  scenario:
    | 'default'
    | 'patterns'
    | 'project'
    | 'parity'
    | 'engine'
    | 'tool-modifiers'
    | 'openrouter-offline'
    | 'loadout-default'
    | 'loadout-modifiers'
    | 'loadout-explicit'
    | 'loadout-none'
    | 'loadout-no-builtin'
    | 'loadout-excluded'
    | 'model-ambiguous'
    | 'model-tools-filtered' = 'default'
) {
  const state = ownedFixtures.get(fixture);
  if (
    !state ||
    (mode !== 'shared' && mode !== 'dedicated') ||
    ![
      'default',
      'patterns',
      'project',
      'parity',
      'engine',
      'tool-modifiers',
      'openrouter-offline',
      'loadout-default',
      'loadout-modifiers',
      'loadout-explicit',
      'loadout-none',
      'loadout-no-builtin',
      'loadout-excluded',
      'model-ambiguous',
      'model-tools-filtered',
    ].includes(scenario) ||
    (scenario === 'openrouter-offline' && state.profile !== 'openrouter') ||
    (scenario.startsWith('loadout-') && (!state.selectedSdk || state.profile !== 'ide-tools')) ||
    (scenario === 'model-ambiguous' && (!state.selectedSdk || state.profile !== 'scopes')) ||
    (scenario === 'model-tools-filtered' && state.profile !== 'model-tools')
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
      'model-discovery.mjs',
      'import-commands.mjs',
      'import-validation.mjs',
      'mcp-status.mjs',
      'model-tools.mjs',
    ]) {
      const source = resolve('host', name);
      const target = join(state.root, name);
      const original = await readFile(source);
      // The bundled SDK loader embeds dependency aliases; the unbundled loader
      // probes sibling package roots outside this read-only SDK authority.
      // Fixed veto profile only: no filesystem permission widening.
      const bytes =
        (state.selectedSdk ||
          [
            'compact-veto',
            'lifecycle-veto',
            'startup',
            'ide-tools',
            'model-tools',
            'extension-ui',
            'startup-ui',
            'mcp-status',
            'mcp-status-empty',
          ].includes(state.profile)) &&
        name === 'pi-multi-host.mjs'
          ? Buffer.from(
              original
                .toString()
                .replace("piImport('dist/index.js')", "piImport('dist/bundle/index.js')")
            )
          : original;
      const sealedBytes =
        state.profile === 'openrouter' && name === 'startup-adapter.mjs'
          ? Buffer.from(
              bytes
                .toString()
                .replace(
                  'allowModelNetwork: false,',
                  `allowModelNetwork: false, catalogBaseUrl: 'http://127.0.0.1:${fixture.port}',`
                )
            )
          : bytes;
      await writeFile(target, sealedBytes, { mode: 0o600 });
      assets.set(target, sealedBytes);
      state.requiredPaths.push(target);
    }
    state.hostAssets = assets;
  }
  await validateOwned(state);
  const loadoutSelections: Record<string, string[]> = {
    'loadout-default': [],
    'loadout-modifiers': ['--tools', '+ls,-read'],
    'loadout-explicit': ['--tools', 'read'],
    'loadout-none': ['--no-tools'],
    'loadout-no-builtin': ['--no-builtin-tools'],
    'loadout-excluded': ['--exclude-tools', 'vscode_diagnostics'],
  };
  const openArgs = [
    '--mode',
    'rpc',
    ...(state.profile !== 'openrouter' || scenario === 'openrouter-offline' ? ['--offline'] : []),
    scenario === 'project' ? '--approve' : '--no-approve',
    '--no-session',
    ...(['mcp-status', 'mcp-status-empty'].includes(state.profile) ? [] : ['--no-extensions']),
    '--no-skills',
    '--no-prompt-templates',
    '--no-context-files',
    ...(loadoutSelections[scenario] ??
      (state.profile === 'model-tools'
        ? scenario === 'model-tools-filtered'
          ? [
              '--tools',
              'owned_direct,owned_model_only,owned_deferred,owned_codemode,owned_hidden,owned_excluded',
              '--exclude-tools',
              'owned_excluded',
            ]
          : ['--exclude-tools', 'owned_excluded']
        : state.profile === 'ide-tools'
          ? [
              '--tools',
              'vscode_diagnostics,vscode_document_symbols,vscode_definitions,vscode_references',
            ]
          : ['--no-tools'])),
  ];
  if (state.vetoAsset) openArgs.push('--extension', state.vetoAsset);
  for (const asset of state.ideAssets ?? []) openArgs.push('--extension', asset);
  if (state.modelToolsAsset) openArgs.push('--extension', state.modelToolsAsset);
  if (state.extensionUiAsset) openArgs.push('--extension', state.extensionUiAsset);
  // Fixed read-only selection; tests inspect the tools without executing them.
  if (scenario === 'tool-modifiers') openArgs.push('--tools', '+ls,-read');
  if (scenario === 'model-ambiguous') openArgs.push('--model', 'ping');
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
      PI_HOST_DEDICATED:
        mode === 'dedicated' &&
        (scenario === 'engine' ||
          state.selectedSdk ||
          state.profile === 'model-tools' ||
          state.profile === 'extension-ui' ||
          state.profile === 'startup-ui')
          ? '1'
          : '0',
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
  scenario:
    | 'default'
    | 'patterns'
    | 'project'
    | 'parity'
    | 'engine'
    | 'tool-modifiers'
    | 'openrouter-offline'
    | 'loadout-default'
    | 'loadout-modifiers'
    | 'loadout-explicit'
    | 'loadout-none'
    | 'loadout-no-builtin'
    | 'loadout-excluded'
    | 'model-ambiguous'
    | 'model-tools-filtered' = 'default'
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
      ...(['mcp-status', 'mcp-status-empty'].includes(state.profile) ? [] : ['--no-extensions']),
      '--no-skills',
      '--no-prompt-templates',
      '--no-context-files',
      ...(state.profile === 'ide-tools'
        ? [
            '--tools',
            'vscode_diagnostics,vscode_document_symbols,vscode_definitions,vscode_references',
          ]
        : ['--no-tools']),
      ...(state.vetoAsset ? ['--extension', state.vetoAsset] : []),
      ...(state.ideAssets ?? []).flatMap((asset) => ['--extension', asset]),
    ],
    cwd: state.cwd,
    env: { ...state.env },
  };
}
