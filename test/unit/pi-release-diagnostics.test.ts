import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const secret = 'OWNED-CREDENTIAL-DO-NOT-PRINT';
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
  const version: string = JSON.parse(originalRead('package.json', 'utf8')).version;
  const laterVersion = `${BigInt(version.split('.')[0]!) + 1n}.0.0`;
  const directory = '/owned-release-fixture';
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
    ...['extension.js', 'sessionIndexWorker.js', 'chat.js', 'chatList.js'].map(
      (name) => `extension/dist/${name}`
    ),
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
  const env: NodeJS.ProcessEnv = {
    ...runtime,
    GITHUB_EVENT_NAME: 'push',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_REPOSITORY: 'mr-narender/Pi',
    GITHUB_SHA: receipt.commit,
    PI_PREVIOUS_SHA: 'b'.repeat(40),
    GH_TOKEN: secret,
    VSCE_PAT: secret,
  };
  if (scenario === 'source') env.GITHUB_REF = secret;
  if (scenario === 'missing-pat') delete env.VSCE_PAT;
  if (scenario === 'unchanged-missing-pat') {
    delete env.VSCE_PAT;
    delete env.GH_TOKEN;
  }
  const errors: string[] = [];
  const logs: string[] = [];
  const children: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const inspections: NodeJS.ProcessEnv[] = [];
  mock.method(fs, 'readFileSync', (file: any, options: any) => {
    if (file === `${directory}/receipt.json`)
      return JSON.stringify(
        scenario === 'artifact' ? { ...receipt, sha256: 'c'.repeat(64) } : receipt
      );
    if (file === `${directory}/pi.vsix`) return bytes;
    return originalRead(file, options);
  });
  mock.method(childProcess, 'execFileSync', (command: string, args: string[], options: any) => {
    if (command === 'git') {
      inspections.push(options.env);
      if (args[0] === 'rev-parse') return receipt.commit;
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
      if (args[0] === '-Z1') return ['extension.vsixmanifest', ...entries].join('\n');
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
    assert.equal(command, process.execPath, 'No unexpected child may execute');
    assert.ok(args[0]?.endsWith('/@vscode/vsce/vsce'));
    children.push({ args: args.slice(1), env: options.env });
    if (args[1] === 'verify-pat' && !scenario.startsWith('verify-')) return secret;
    const restStatus = scenario.endsWith('rest-auth')
      ? 401
      : scenario.endsWith('rest-permission')
        ? 403
        : scenario === 'rest-unknown'
          ? 418
          : undefined;
    const message = restStatus
      ? `Failed request: (${restStatus})`
      : scenario === 'auth' || scenario === 'verify-auth'
        ? 'Unauthorized(401)'
        : scenario === 'service'
          ? 'Internal Server Error(500)'
          : secret;
    throw Object.assign(new Error(secret), {
      status: scenario === 'verify-bounds' ? 999999 : 7,
      stderr: Buffer.from(`${message} ${secret}`),
      stdout: secret,
    });
  });
  mock.method(globalThis, 'fetch', async (input: any) => {
    const url = new URL(input);
    if (scenario === 'http') return new Response(secret, { status: 403 });
    if (scenario === 'unknown')
      throw Object.assign(new Error(secret), { status: 401, exitCode: 7 });
    if (url.pathname.includes('/git/ref/'))
      return Response.json({ object: { type: 'commit', sha: receipt.commit } });
    if (url.pathname.endsWith('/extensionquery'))
      return Response.json({
        results: [
          {
            extensions: [
              {
                publisher: { publisherName: 'mr-narender' },
                extensionName: 'pi',
                versions: [{ version: '0.0.0' }],
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
          target_commitish: receipt.commit,
          assets: [],
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
    return { status, errors, logs, children };
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
  }
}

for (const [scenario, expected] of [
  ['source', 'source-validation: validation-failed'],
  ['artifact', 'artifact-validation: validation-failed'],
  ['version', 'version-validation: validation-failed'],
  ['missing-pat', 'credentials: missing-marketplace-pat'],
  ['http', 'github-release: http-error (HTTP 403)'],
  ['auth', 'marketplace-publish: authentication-failed (HTTP 401, exit 7)'],
  ['service', 'marketplace-publish: service-failed (HTTP 500, exit 7)'],
  ['child', 'marketplace-publish: child-failed (exit 7)'],
  ['unknown', 'github-release: unexpected-error'],
  ['verify-auth', 'marketplace-credentials: authentication-failed (HTTP 401, exit 7)'],
  ['verify-bounds', 'marketplace-credentials: child-failed'],
  ['verify-rest-auth', 'marketplace-credentials: authentication-failed (HTTP 401, exit 7)'],
  ['verify-rest-permission', 'marketplace-credentials: permission-denied (HTTP 403, exit 7)'],
  ['rest-auth', 'marketplace-publish: authentication-failed (HTTP 401, exit 7)'],
  ['rest-permission', 'marketplace-publish: permission-denied (HTTP 403, exit 7)'],
  ['rest-unknown', 'marketplace-publish: child-failed (exit 7)'],
])
  test(`release catch reports only the safe ${scenario} stage/category`, async () => {
    const result = await runFixture(scenario!);
    assert.equal(result.status, 1);
    assert.deepEqual(result.errors, [
      `Pi release failed at ${expected}. Rerun the failed job after fixing this stage.`,
    ]);
    if (scenario === 'source' || scenario === 'artifact' || scenario === 'missing-pat')
      assert.deepEqual(result.children, []);
    for (const child of result.children)
      assert.deepEqual(child.env, { ...runtime, VSCE_PAT: secret });
  });

test('unchanged version verifies only the available Marketplace credential and never publishes', async () => {
  const result = await runFixture('unchanged');
  assert.equal(result.status, 0);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.children, [
    { args: ['verify-pat', 'mr-narender'], env: { ...runtime, VSCE_PAT: secret } },
  ]);
  assert.deepEqual(result.logs, [
    'Marketplace credential verification succeeded.',
    'Version unchanged; publication skipped.',
  ]);
  const missing = await runFixture('unchanged-missing-pat');
  assert.equal(missing.status, 0);
  assert.deepEqual(missing.children, []);
  assert.deepEqual(missing.logs, ['Version unchanged; publication skipped.']);
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
      productionServices('/owned', { file: 'pi.vsix' }, { VSCE_PAT: secret }).publishMarketplace(),
      (error: any) => {
        error.category = secret;
        error.status = secret;
        error.exit = secret;
        assert.equal(
          formatReleaseFailure(error, 'marketplace-publish'),
          'Pi release failed at marketplace-publish: unexpected-error. Rerun the failed job after fixing this stage.'
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
