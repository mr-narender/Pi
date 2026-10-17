import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const secret = 'OWNED-CREDENTIAL-DO-NOT-PRINT';
const profileId = '01234567-89ab-cdef-0123-456789abcdef';
const runtime = {
  PATH: '/owned/runtime-bin',
  HOME: '/owned/runtime-home',
  HTTPS_PROXY: 'http://owned-proxy:8080',
};
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const releaseModule = import(pathToFileURL(resolve('scripts/release.mjs')).href);

async function runFixture(scenario: string) {
  const { runRelease } = await releaseModule;
  const originalRead = fs.readFileSync;
  const originalReaddir = fs.readdirSync;
  const version: string = JSON.parse(originalRead('package.json', 'utf8')).version;
  const laterVersion = `${BigInt(version.split('.')[0]!) + 1n}.0.0`;
  const root = fs.mkdtempSync(resolve(tmpdir(), 'pi-release-oidc-'));
  const directory = resolve(root, 'current');
  fs.mkdirSync(directory);
  const bytes = Buffer.from('owned VSIX fixture');
  const bundle = Buffer.from('owned bundle fixture');
  const entries = [
    'extension/package.json',
    'extension/readme.md',
    'extension/NOTICE',
    'extension/LICENSE.txt',
    'extension/changelog.md',
    ...fs
      .readdirSync('host')
      .filter((name) => name.endsWith('.mjs'))
      .map((name) => `extension/host/${name}`),
    ...[
      'extension.js',
      'sessionIndexWorker.js',
      'chat.js',
      'chatList.js',
      'mermaid.js',
      'highlight.js',
      'qrcode.js',
    ].map((name) => `extension/dist/${name}`),
  ];
  const receipt = {
    schema: 1,
    repository: 'mr-narender/Pi',
    commit: 'a'.repeat(40),
    publisher: 'mr-narender',
    name: 'pi',
    version,
    channel: 'stable',
    file: 'pi.vsix',
    sha256: digest(bytes),
    bundles: Object.fromEntries(
      entries
        .filter((name) => name.includes('/dist/'))
        .map((name) => [name.slice('extension/'.length), digest(bundle)])
    ),
  };
  const pending = { ...receipt, commit: 'c'.repeat(40) };
  const pendingBytes = Buffer.from(JSON.stringify(pending, null, 2) + '\n');
  const env: NodeJS.ProcessEnv = {
    ...runtime,
    GITHUB_EVENT_NAME: 'push',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_REPOSITORY: 'mr-narender/Pi',
    GITHUB_SHA: receipt.commit,
    PI_PREVIOUS_SHA: 'b'.repeat(40),
    GH_TOKEN: secret,
    AZURE_CONFIG_DIR: '/owned/azure-config',
    AZURE_CLIENT_SECRET: secret,
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: secret,
    VSCE_PAT: secret,
  };
  const automatic = scenario === 'automatic-unchanged';
  if (automatic) env.PI_AUTOMATIC_RELEASE = 'true';
  if (scenario === 'source') env.GITHUB_REF = secret;
  if (scenario === 'missing-session') delete env.AZURE_CONFIG_DIR;
  if (scenario === 'pull-request') env.GITHUB_EVENT_NAME = 'pull_request';
  if (scenario === 'foreign-repo') env.GITHUB_REPOSITORY = secret;
  if (scenario === 'push-operation') env.PI_RELEASE_OPERATION = 'profile';
  if (scenario === 'invalid-before') env.PI_PREVIOUS_SHA = secret;
  if (scenario.startsWith('dispatch-')) {
    env.GITHUB_EVENT_NAME = 'workflow_dispatch';
    env.PI_RELEASE_OPERATION =
      scenario === 'dispatch-profile'
        ? 'profile'
        : scenario === 'dispatch-retry'
          ? 'retry-pending-release'
          : secret;
    delete env.PI_PREVIOUS_SHA;
  }
  const errors: string[] = [];
  let published = false;
  const logs: string[] = [];
  const children: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const inspections: NodeJS.ProcessEnv[] = [];
  const stamped: string[] = [];
  const originalWrite = fs.writeFileSync;
  mock.method(fs, 'writeFileSync', (file: any, data: any, options: any) => {
    if (
      automatic &&
      ['package.json', 'package-lock.json', 'CHANGELOG.md'].some(
        (name) => String(file) === resolve(name)
      )
    ) {
      assert.equal(data, originalRead(file, 'utf8'));
      stamped.push(String(file));
      return;
    }
    return originalWrite(file, data, options);
  });
  mock.method(fs, 'readFileSync', (file: any, options: any) => {
    if (file === `${directory}/receipt.json`)
      return JSON.stringify(
        scenario === 'artifact' ? { ...receipt, sha256: 'c'.repeat(64) } : receipt
      );
    if (file === `${directory}/pi.vsix`) return bytes;
    if (String(file).includes('/source/'))
      return originalRead(resolve(String(file).split('/source/')[1]!), options);
    return originalRead(file, options);
  });
  mock.method(fs, 'readdirSync', (file: any, options: any) =>
    String(file).endsWith('/source/host')
      ? originalReaddir('host', options)
      : originalReaddir(file, options)
  );
  mock.method(childProcess, 'execFileSync', (command: string, args: string[], options: any) => {
    if (command === 'git') {
      inspections.push(options.env);
      if (automatic && args[0] === 'tag') return 'v0.0.0';
      if (automatic && args[0] === 'diff') return args.includes('-z') ? 'src/extension.ts\0' : '';
      if (automatic && args[0] === 'show')
        return args[1]!.startsWith('HEAD:')
          ? originalRead(resolve(args[1]!.slice(5)), 'utf8')
          : JSON.stringify({ version });
      if (automatic && args[0] === 'rev-parse' && args[1]!.startsWith('v')) return 'b'.repeat(40);
      if (args[0] === 'rev-parse')
        return args[1]!.endsWith('^')
          ? (env.PI_PREVIOUS_SHA ?? 'b'.repeat(40))
          : options.cwd?.endsWith('/source')
            ? pending.commit
            : receipt.commit;
      if (args[0] === 'show')
        return JSON.stringify({
          version:
            scenario === 'version'
              ? laterVersion
              : scenario.startsWith('unchanged')
                ? version
                : '0.0.0',
        });
      return '';
    }
    if (command === 'unzip') {
      inspections.push(options.env);
      if (args[0] === '-Z1') return ['extension.vsixmanifest', ...entries].join('\n') + '\n';
      if (args[2] === 'extension.vsixmanifest')
        return Buffer.from(`<Identity Version="${version}" Publisher="mr-narender"/>`);
      const file = args[2]!.slice('extension/'.length);
      if (file.startsWith('dist/')) return bundle;
      const alias: Record<string, string> = {
        'readme.md': 'README.md',
        'LICENSE.txt': 'LICENSE',
        'changelog.md': 'CHANGELOG.md',
      };
      return originalRead(resolve(alias[file] ?? file));
    }
    if (command === 'az') {
      children.push({ args, env: options.env });
      assert.deepEqual(args, [
        'rest',
        '--method',
        'GET',
        '--url',
        'https://app.vssps.visualstudio.com/_apis/profile/profiles/me',
        '--resource',
        '499b84ac-1321-427f-aa17-267ca6975798',
        '--output',
        'json',
        '--only-show-errors',
      ]);
      if (scenario === 'profile-invalid') return JSON.stringify({ id: secret, other: secret });
      if (scenario !== 'profile-child') return JSON.stringify({ id: profileId, other: secret });
    } else {
      assert.equal(command, process.execPath, 'No unexpected child may execute');
      assert.ok(args[0]?.endsWith('/@vscode/vsce/vsce'));
      children.push({ args: args.slice(1), env: options.env });
      assert.deepEqual(args.slice(1, 4), ['publish', '--azure-credential', '--packagePath']);
      assert.ok(args[4]!.endsWith('/pi.vsix'));
      if (scenario === 'dispatch-retry' || automatic) {
        published = true;
        return secret;
      }
    }
    throw Object.assign(new Error(secret), {
      status: scenario === 'bounds' ? 999999 : 7,
      stderr: Buffer.from(`Failed request: (401) ${secret}`),
      stdout: secret,
    });
  });
  mock.method(globalThis, 'fetch', async (input: any, options: any) => {
    const url = new URL(input);
    if (scenario === 'http') return new Response(secret, { status: 403 });
    if (scenario === 'unknown')
      throw Object.assign(new Error(secret), { status: 401, exitCode: 7 });
    if (url.pathname.includes('/git/ref/'))
      return Response.json({
        object: {
          type: 'commit',
          sha: scenario === 'dispatch-retry' ? pending.commit : receipt.commit,
        },
      });
    if (url.pathname.endsWith('/actions/runs'))
      return Response.json({
        workflow_runs: [
          {
            id: 1,
            head_sha: pending.commit,
            head_branch: 'main',
            event: 'push',
            path: '.github/workflows/pi.yml',
          },
        ],
      });
    if (url.pathname.endsWith('/jobs'))
      return Response.json({
        jobs: [{ name: 'pi-quality', head_sha: pending.commit, conclusion: 'success' }],
      });
    if (url.pathname.endsWith('/releases/assets/1'))
      return new Response(new Uint8Array(pendingBytes));
    if (url.pathname.endsWith('/vspackage') && !published) return new Response('', { status: 404 });
    if (url.pathname.endsWith('/Microsoft.VisualStudio.Services.Content.Details'))
      return new Response(new Uint8Array(originalRead('README.md')));
    if (url.pathname.endsWith('/releases/assets/2') || url.pathname.endsWith('/vspackage'))
      return new Response(new Uint8Array(bytes));
    if (url.pathname.endsWith('/releases/1')) {
      assert.equal(options.method, 'PATCH');
      return Response.json({});
    }
    if (url.pathname.endsWith('/extensionquery'))
      return Response.json({
        results: [
          {
            extensions: [
              {
                publisher: { publisherName: 'mr-narender' },
                extensionName: 'pi',
                versions: [{ version: published ? version : '0.0.0' }],
              },
            ],
          },
        ],
      });
    if (url.pathname.endsWith('/releases'))
      return Response.json([
        {
          id: 1,
          tag_name: `v${version}`,
          draft: true,
          prerelease: false,
          target_commitish: scenario === 'dispatch-retry' ? pending.commit : receipt.commit,
          assets:
            scenario === 'dispatch-retry'
              ? [
                  { id: 1, name: 'receipt.json', digest: `sha256:${digest(pendingBytes)}` },
                  { id: 2, name: `pi-${version}.vsix`, digest: `sha256:${pending.sha256}` },
                ]
              : [],
        },
      ]);
    assert.equal(url.hostname, 'uploads.github.com', 'No unexpected service may execute');
    return Response.json({});
  });
  mock.method(console, 'error', (message: string) => errors.push(message));
  mock.method(console, 'log', (message: string) => logs.push(message));
  syncBuiltinESMExports();
  try {
    const status = await runRelease(directory, env);
    for (const inspection of inspections) assert.deepEqual(inspection, runtime);
    assert.ok(![...errors, ...logs].join('\n').includes(secret));
    return { status, errors, logs, children, stamped };
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

for (const [scenario, expected] of [
  ['source', 'source-validation: validation-failed'],
  ['artifact', 'artifact-validation: validation-failed'],
  ['version', 'version-validation: validation-failed'],
  ['pull-request', 'source-validation: validation-failed'],
  ['foreign-repo', 'source-validation: validation-failed'],
  ['push-operation', 'source-validation: validation-failed'],
  ['dispatch-invalid', 'source-validation: validation-failed'],
  ['invalid-before', 'version-validation: validation-failed'],
  ['missing-session', 'marketplace-profile: missing-azure-session'],
  ['profile-invalid', 'marketplace-profile: validation-failed'],
  ['profile-child', 'marketplace-profile: child-failed (exit 7)'],
  ['http', 'github-release: http-error (HTTP 403)'],
  ['child', 'marketplace-publish: child-failed (exit 7)'],
  ['bounds', 'marketplace-publish: child-failed'],
  ['unknown', 'github-release: unexpected-error'],
])
  test(`release catch reports only the safe ${scenario} stage/category`, async () => {
    const result = await runFixture(scenario!);
    assert.equal(result.status, 1);
    const guidance = expected!.startsWith('marketplace-profile:')
      ? 'Check main-only OIDC login and Marketplace profile access.'
      : expected!.startsWith('marketplace-publish:')
        ? 'Check Contributor access for the displayed profile ID, then retry the pending release.'
        : 'Rerun the failed job after fixing this stage.';
    assert.deepEqual(result.errors, [`Pi release failed at ${expected}. ${guidance}`]);
    if (
      [
        'source',
        'artifact',
        'pull-request',
        'foreign-repo',
        'push-operation',
        'dispatch-invalid',
        'invalid-before',
        'version',
        'missing-session',
      ].includes(scenario!)
    )
      assert.deepEqual(result.children, []);
    for (const child of result.children)
      assert.deepEqual(child.env, {
        ...runtime,
        AZURE_CONFIG_DIR: '/owned/azure-config',
        AZURE_CORE_OUTPUT: 'none',
      });
  });

test('unchanged push and explicit profile dispatch perform only readonly profile lookup and show only the UUID', async () => {
  const result = await runFixture('unchanged');
  assert.equal(result.status, 0);
  assert.deepEqual(result.errors, []);
  assert.equal(result.children.length, 1);
  assert.equal(result.children[0]!.args[0], 'rest');
  assert.deepEqual(result.logs, [
    `Marketplace profile ID: ${profileId}`,
    'Version unchanged; publication skipped.',
  ]);
  const profile = await runFixture('dispatch-profile');
  assert.equal(profile.status, 0);
  assert.equal(profile.children.length, 1);
  assert.deepEqual(profile.logs, [`Marketplace profile ID: ${profileId}`]);
  assert.deepEqual(profile.errors, []);
});

test('automatic main publication validates tag ledger and metadata even when source version did not change', async () => {
  const result = await runFixture('automatic-unchanged');
  assert.equal(result.status, 0, result.errors.join('\n'));
  assert.equal(result.children.length, 2);
  assert.equal(result.stamped.length, 3);
  assert.ok(result.logs.at(-1)!.startsWith('Released stable mr-narender.pi '));
});

test('main retry dispatch publishes the original verified draft artifact, not the new quality package', async () => {
  const result = await runFixture('dispatch-retry');
  assert.equal(result.status, 0);
  assert.deepEqual(result.errors, []);
  assert.equal(result.children.length, 2);
  assert.deepEqual(result.children[1]!.args.slice(0, 3), [
    'publish',
    '--azure-credential',
    '--packagePath',
  ]);
  assert.ok(result.children[1]!.args[3]!.includes('/pi-recovery-'));
  assert.ok(result.logs[1]!.endsWith(`from ${'c'.repeat(40)}.`));
});

test('arbitrary errors and unknown stages cannot smuggle message, status or credential values into diagnostics', async () => {
  const { formatReleaseFailure } = await releaseModule;
  assert.equal(
    formatReleaseFailure(
      Object.assign(new Error(secret), { status: 401, exit: 7, category: secret }),
      secret
    ),
    'Pi release failed at unknown: unexpected-error. Rerun the failed job after fixing this stage.'
  );
});

test('even a mutated recognized failure cannot inject categories or numeric details', async () => {
  const { productionServices, formatReleaseFailure } = await releaseModule;
  mock.method(childProcess, 'execFileSync', () => {
    throw Object.assign(new Error(secret), { status: 7 });
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      productionServices(
        '/owned',
        { file: 'pi.vsix' },
        { AZURE_CONFIG_DIR: '/owned/azure-config' }
      ).publishMarketplace(),
      (error: any) => {
        error.category = secret;
        error.status = secret;
        error.exit = secret;
        assert.equal(
          formatReleaseFailure(error, 'marketplace-publish'),
          'Pi release failed at marketplace-publish: unexpected-error. Check Contributor access for the displayed profile ID, then retry the pending release.'
        );
        return true;
      }
    );
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test('real CLI source rejection uses the same redacted diagnostic catch', () => {
  const result = childProcess.spawnSync(
    process.execPath,
    ['scripts/release.mjs', '/owned-missing-artifact'],
    {
      encoding: 'utf8',
      env: { GITHUB_EVENT_NAME: secret },
    }
  );
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(
    result.stderr.trim(),
    'Pi release failed at source-validation: validation-failed. Rerun the failed job after fixing this stage.'
  );
  assert.ok(!result.stderr.includes(secret));
});
