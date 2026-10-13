import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import childProcess from 'node:child_process';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const releaseModule = import(pathToFileURL(resolve('scripts/release.mjs')).href);
const receipt = {
  schema: 1,
  repository: 'mr-narender/Pi',
  publisher: 'mr-narender',
  name: 'pi',
  commit: 'a'.repeat(40),
  version: '0.2.28',
  channel: 'stable',
  sha256: 'b'.repeat(64),
  file: 'pi.vsix',
  bundles: {},
};
const credentials = { github: 'fixture-github', marketplace: 'fixture-marketplace' };

function fixture() {
  const trace: string[] = [];
  let tag: string | undefined;
  let published = false;
  let clock = 0;
  let github: any;
  let fail: string | undefined;
  const services = {
    async tagSha() {
      return tag;
    },
    async marketplaceVersions() {
      return published
        ? [{ version: receipt.version, prerelease: false }]
        : [{ version: '0.2.27', prerelease: false }];
    },
    async marketplaceDigest() {
      return published ? receipt.sha256 : undefined;
    },
    async marketplaceReadmeMatches() {
      return true;
    },
    now() {
      return clock;
    },
    async sleep(ms: number) {
      clock += ms;
    },
    async githubRelease() {
      return github;
    },
    async createTag() {
      trace.push('tag');
      tag = receipt.commit;
    },
    async createDraft() {
      trace.push('draft');
      return (github = {
        id: 1,
        draft: true,
        prerelease: false,
        target_commitish: receipt.commit,
        assets: [],
      });
    },
    async upload(_id: number, name: string) {
      trace.push(name);
      const { sha256 } = await import(pathToFileURL(resolve('scripts/inspect-vsix.mjs')).href);
      github.assets.push({
        name,
        digest: name.endsWith('.vsix')
          ? receipt.sha256
          : sha256(Buffer.from(JSON.stringify(receipt, null, 2) + '\n')),
      });
    },
    async githubAssetDigest(asset: any) {
      return asset.digest;
    },
    async publishMarketplace() {
      trace.push('marketplace');
      if (fail === 'marketplace') throw new Error('owned failure');
      published = true;
    },
    async completeGithub() {
      trace.push('complete');
      if (fail === 'github') throw new Error('owned failure');
      github.draft = false;
    },
  };
  return {
    services,
    trace,
    setFail: (value?: string) => {
      fail = value;
    },
    setTag: (value: string) => {
      tag = value;
    },
  };
}

test('Pi CI has one exact required aggregate covering every quality gate with pinned dependencies and fork-safe permissions', () => {
  const yaml = createRequire(resolve('package.json'))('js-yaml');
  const workflow = yaml.load(readFileSync('.github/workflows/pi.yml', 'utf8'));
  assert.deepEqual(workflow.on.pull_request.branches, ['main']);
  assert.deepEqual(workflow.on.push.branches, ['main']);
  assert.equal(workflow.on.pull_request_target, undefined);
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  const quality = workflow.jobs['pi-quality'];
  assert.equal(quality.name, 'pi-quality');
  assert.equal(quality.permissions, undefined);
  assert.ok(!JSON.stringify(quality).includes('secrets.'));
  const commands = quality.steps.map((step: any) => step.run ?? '').join('\n');
  for (const command of [
    'npm run format:check',
    'npm run lint',
    'tsc -p tsconfig.json',
    'tsc -p test/tsconfig.json',
    'node scripts/build.mjs',
    'npm run validate:coverage',
    'npm run test:unit',
    'npm run test:integration',
    'npm run smoke:real-pi',
    'xvfb-run -a npm run test:extension',
    'node scripts/inspect-vsix.mjs',
  ])
    assert.ok(commands.includes(command), command);
  assert.ok(commands.includes('npm ci --prefix .github/pi-sdk'));
  assert.equal(
    JSON.parse(readFileSync('.github/pi-sdk/package.json', 'utf8')).dependencies[
      '@earendil-works/pi-coding-agent'
    ],
    '1.2.0'
  );
  for (const job of Object.values(workflow.jobs) as any[]) {
    for (const step of job.steps.filter((s: any) => s.uses))
      assert.match(step.uses, /^(?:actions|azure)\/[\w-]+@[a-f0-9]{40}$/);
    const checkout = job.steps.find((s: any) => s.uses.startsWith('actions/checkout@'));
    assert.equal(checkout.with['persist-credentials'], false);
    assert.equal(
      job.steps.find((s: any) => s.uses?.startsWith('actions/setup-node@')).with['node-version'],
      '26.11.1'
    );
  }
  const publisher = workflow.jobs.release;
  assert.equal(publisher.needs, 'pi-quality');
  for (const condition of [
    "github.event_name == 'push'",
    "github.ref == 'refs/heads/main'",
    "github.repository == 'mr-narender/Pi'",
  ])
    assert.ok(publisher.if.includes(condition));
  assert.deepEqual(publisher.permissions, {
    contents: 'write',
    'id-token': 'write',
    actions: 'read',
  });
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.operation.options, [
    'profile',
    'retry-pending-release',
  ]);
  assert.equal(workflow.on.workflow_dispatch.inputs.operation.default, 'profile');
  const login = publisher.steps.find((step: any) => step.uses?.startsWith('azure/login@'));
  assert.equal(login.uses, 'azure/login@a641126d1b8aa4d1fa005f4f92df94a3a4c4c906');
  assert.deepEqual(login.with, {
    'client-id': '${{ secrets.AZURE_CLIENT_ID }}',
    'tenant-id': '${{ secrets.AZURE_TENANT_ID }}',
    'allow-no-subscriptions': true,
  });
  assert.equal(login.with['enable-AzPSSession'], undefined);
  assert.equal(login.env.AZURE_CONFIG_DIR, '${{ runner.temp }}/pi-azure');
  assert.equal(publisher.steps.at(-1).env.AZURE_CONFIG_DIR, login.env.AZURE_CONFIG_DIR);
  assert.equal(publisher.env.AZURE_CORE_OUTPUT, 'none');
  assert.ok(!JSON.stringify(workflow).includes('VSCE_PAT'));
  assert.ok(!JSON.stringify(quality).includes('azure/login'));
  assert.ok(publisher.if.includes("github.event_name == 'workflow_dispatch'"));
  assert.ok(!JSON.stringify(publisher).includes('vsce package'));
  assert.ok(JSON.stringify(publisher).includes('needs.pi-quality.outputs.source-sha'));
  assert.ok(JSON.stringify(publisher).includes('github.event.before'));
  for (const job of [quality, publisher]) assert.equal(job.steps[0].with['fetch-depth'], 0);
  assert.equal(workflow.concurrency['cancel-in-progress'], false);
  assert.equal(workflow.concurrency.queue, 'max');
  const owners = readFileSync('.github/CODEOWNERS', 'utf8');
  for (const file of ['/package.json', '/package-lock.json'])
    assert.ok(owners.split('\n').includes(`${file} @mr-narender`), file);
});

test('Pi release subprocesses isolate Azure CLI state and exclude all PAT, GitHub, Entra and Actions credentials', async () => {
  const { productionServices, previousVersionForPush } = await releaseModule;
  const { inspectVsix } = await import(pathToFileURL(resolve('scripts/inspect-vsix.mjs')).href);
  const env = Object.freeze({
    PATH: '/owned/runtime/bin',
    HOME: '/owned/runtime/home',
    HTTPS_PROXY: 'http://owned-proxy:8080',
    NO_PROXY: 'localhost',
    GH_TOKEN: 'fixture-github-write',
    GITHUB_TOKEN: 'fixture-github-other',
    VSCE_PAT: 'fixture-marketplace-only',
    AZURE_CONFIG_DIR: '/owned/runtime/azure',
    AZURE_CLIENT_ID: 'fixture-client-id',
    AZURE_CLIENT_SECRET: 'fixture-client-secret',
    AZURE_TENANT_ID: 'fixture-tenant',
    ACTIONS_RUNTIME_TOKEN: 'fixture-runtime',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'fixture-oidc',
    ACTIONS_ID_TOKEN_REQUEST_URL: 'https://owned.invalid/oidc',
    NODE_OPTIONS: '--require /owned/unreviewed-hook.cjs',
    UNRELATED_SECRET: 'fixture-other',
  });
  const calls: { command: string; options: any }[] = [];
  mock.method(childProcess, 'execFileSync', (command: string, args: string[], options: any) => {
    calls.push({ command, options });
    if (command === 'git' && args[0] === 'show') return '{"version":"0.2.27"}';
    if (command === 'unzip') return '../unsafe-entry';
    return '';
  });
  syncBuiltinESMExports();
  try {
    await productionServices('/owned/artifacts', receipt, env).publishMarketplace();
    assert.equal(previousVersionForPush('c'.repeat(40), env), '0.2.27');
    assert.throws(() => inspectVsix('/owned/artifacts/pi.vsix', process.cwd(), undefined, env));
    assert.deepEqual(
      calls.map((call) => call.command),
      [process.execPath, 'git', 'git', 'unzip']
    );
    const runtime = {
      PATH: env.PATH,
      HOME: env.HOME,
      HTTPS_PROXY: env.HTTPS_PROXY,
      NO_PROXY: env.NO_PROXY,
    };
    assert.deepEqual(calls[0]!.options.env, {
      ...runtime,
      AZURE_CONFIG_DIR: env.AZURE_CONFIG_DIR,
      AZURE_CORE_OUTPUT: 'none',
    });
    for (const call of calls.slice(1)) assert.deepEqual(call.options.env, runtime);
    assert.equal(env.GH_TOKEN, 'fixture-github-write');
    assert.equal(env.VSCE_PAT, 'fixture-marketplace-only');
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test('Pi stable release stages exact artifacts, publishes Marketplace, then completes GitHub, and retries are idempotent', async () => {
  const { release } = await releaseModule;
  const f = fixture();
  await release(receipt, '0.2.27', f.services, credentials);
  assert.deepEqual(f.trace, [
    'tag',
    'draft',
    'pi-0.2.28.vsix',
    'receipt.json',
    'marketplace',
    'complete',
  ]);
  f.trace.length = 0;
  await release(receipt, '0.2.27', f.services, credentials);
  assert.deepEqual(f.trace, []);
});

test('Pi release waits for stable metadata and exact README after package visibility without republishing', async () => {
  const { release } = await releaseModule;
  const f = fixture();
  let listings = 0;
  let readmes = 0;
  const delays: number[] = [];
  const sleep = f.services.sleep;
  f.services.sleep = async (ms) => {
    delays.push(ms);
    await sleep(ms);
  };
  f.services.marketplaceDigest = async () => receipt.sha256;
  f.services.marketplaceVersions = async () =>
    ++listings < 3
      ? [{ version: '0.2.27', prerelease: false }]
      : [{ version: receipt.version, prerelease: false }];
  f.services.marketplaceReadmeMatches = async () => ++readmes >= 3;
  await release(receipt, '0.2.27', f.services, credentials);
  assert.ok(!f.trace.includes('marketplace'), 'approved package already visible; never republish');
  assert.deepEqual(delays, [2000, 4000]);
  assert.equal(f.trace.at(-1), 'complete');
});

test('Pi release propagation timeout retains the draft, reports verification timeout and can recover', async () => {
  const { release, formatReleaseFailure } = await releaseModule;
  const f = fixture();
  f.services.marketplaceReadmeMatches = async () => false;
  let stage = '';
  await assert.rejects(
    release(receipt, '0.2.27', f.services, credentials, (value: string) => {
      stage = value;
    }),
    (error: any) => {
      assert.equal(stage, 'marketplace-verification');
      assert.match(formatReleaseFailure(error, stage), /timeout/);
      return true;
    }
  );
  assert.equal(f.services.now(), 600000);
  assert.ok(!f.trace.includes('complete'));
  assert.equal(f.trace.filter((value) => value === 'marketplace').length, 1);
  f.services.marketplaceReadmeMatches = async () => true;
  await release(receipt, '0.2.27', f.services, credentials);
  assert.equal(f.trace.filter((value) => value === 'marketplace').length, 1);
  assert.equal(f.trace.at(-1), 'complete');
});

test('Pi release retries transient service failures and missing package propagation', async () => {
  const { release } = await releaseModule;
  const f = fixture();
  const versions = f.services.marketplaceVersions;
  let transient = true;
  f.services.marketplaceVersions = async () => {
    if (f.trace.includes('marketplace') && transient) {
      transient = false;
      throw Object.assign(new Error('private transient response'), { status: 503 });
    }
    return versions();
  };
  const digest = f.services.marketplaceDigest;
  let missing = true;
  f.services.marketplaceDigest = async () => {
    if (f.trace.includes('marketplace') && missing) {
      missing = false;
      return undefined;
    }
    return digest();
  };
  await release(receipt, '0.2.27', f.services, credentials);
  assert.equal(f.services.now(), 6000);
  assert.equal(f.trace.filter((value) => value === 'marketplace').length, 1);
  assert.equal(f.trace.at(-1), 'complete');
});

test('production Marketplace Details verification hashes the approved VSIX README, handles stale bytes and missing assets', async () => {
  const { productionServices } = await releaseModule;
  const approved = Buffer.from('owned approved README bytes');
  let remote = approved;
  let missing = false;
  let reads = 0;
  mock.method(childProcess, 'execFileSync', (command: string, args: string[], options: any) => {
    assert.equal(command, 'unzip');
    assert.deepEqual(args, ['-p', '/owned/approved/pi.vsix', 'extension/readme.md']);
    assert.equal(options.env.GH_TOKEN, undefined);
    reads++;
    return approved;
  });
  mock.method(globalThis, 'fetch', async (url: any, options: any) => {
    assert.equal(
      String(url),
      `https://mr-narender.gallery.vsassets.io/_apis/public/gallery/publisher/mr-narender/extension/pi/${receipt.version}/assetbyname/Microsoft.VisualStudio.Services.Content.Details`
    );
    assert.ok(options.signal instanceof AbortSignal);
    return missing ? new Response('', { status: 404 }) : new Response(new Uint8Array(remote));
  });
  syncBuiltinESMExports();
  try {
    const service = productionServices('/owned/approved', receipt, { GH_TOKEN: 'fixture-only' });
    assert.equal(await service.marketplaceReadmeMatches(receipt.version), true);
    remote = Buffer.from('owned stale README');
    assert.equal(await service.marketplaceReadmeMatches(receipt.version), false);
    missing = true;
    assert.equal(await service.marketplaceReadmeMatches(receipt.version), false);
    assert.equal(reads, 1);
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test('Pi release fails immediately on wrong artifact or authorization without completing GitHub', async () => {
  const { release } = await releaseModule;
  for (const scenario of ['digest', 'auth']) {
    const f = fixture();
    let requests = 0;
    const original = f.services.marketplaceDigest;
    f.services.marketplaceDigest = async () => {
      if (!f.trace.includes('marketplace')) return original();
      requests++;
      if (scenario === 'auth')
        throw Object.assign(new Error('private service body'), { status: 401 });
      return 'c'.repeat(64);
    };
    await assert.rejects(release(receipt, '0.2.27', f.services, credentials));
    assert.equal(requests, 1);
    assert.equal(f.services.now(), 0);
    assert.ok(!f.trace.includes('complete'));
  }
});

test('Pi multi-commit push compares the trusted before SHA, even when the final docs commit parent has the new version', async () => {
  const { previousVersionForPush, release } = await releaseModule;
  const before = 'c'.repeat(40);
  const commands: string[][] = [];
  mock.method(childProcess, 'execFileSync', (_command: string, args: string[]) => {
    commands.push(args);
    if (args[0] === 'show')
      return JSON.stringify({
        version: args[1] === `${before}:package.json` ? '0.2.27' : '0.2.28',
      });
    return '';
  });
  syncBuiltinESMExports();
  try {
    const previous = previousVersionForPush(before);
    assert.equal(previous, '0.2.27');
    assert.deepEqual(commands, [
      ['merge-base', '--is-ancestor', before, 'HEAD'],
      ['show', `${before}:package.json`],
    ]);
    const f = fixture();
    await release(receipt, previous, f.services, credentials);
    assert.ok(f.trace.includes('marketplace'));
    assert.throws(() => previousVersionForPush('0'.repeat(40)), /owner recovery/);
    assert.throws(() => previousVersionForPush('HEAD^;untrusted'), /before commit/);
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
  }
});

for (const failure of ['marketplace', 'github'])
  test(`Pi release resumes ${failure} partial failure with the original assets`, async () => {
    const { release } = await releaseModule;
    const f = fixture();
    f.setFail(failure);
    await assert.rejects(release(receipt, '0.2.27', f.services, credentials), /owned failure/);
    f.setFail();
    f.trace.length = 0;
    await release(receipt, '0.2.27', f.services, credentials);
    assert.deepEqual(
      f.trace,
      failure === 'marketplace' ? ['marketplace', 'complete'] : ['complete']
    );
  });

test('Pi unchanged versions never write; new versions require the Azure session without disclosing values', async () => {
  const { release } = await releaseModule;
  const f = fixture();
  assert.match(await release(receipt, receipt.version, f.services, {}), /unchanged/);
  await assert.rejects(
    release(receipt, '0.2.27', f.services, { github: 'DO-NOT-LOG' }),
    (error: any) => {
      assert.equal(error.category, 'missing-azure-session');
      assert.ok(!error.message.includes('DO-NOT-LOG'));
      return true;
    }
  );
  assert.deepEqual(f.trace, []);
});

test('Pi release refuses version rollback, prerelease, wrong tag, remote artifact drift and channel conflict before writes', async () => {
  const { release, compareVersions } = await releaseModule;
  assert.equal(compareVersions('0.10.0', '0.2.28'), 1);
  assert.equal(compareVersions('9007199254740993.0.0', '9007199254740992.0.0'), 1);
  for (const version of ['0.2.28-next', '0.02.28', 'v0.2.28'])
    assert.throws(() => compareVersions(version, '0.2.27'));
  await assert.rejects(release(receipt, '0.2.29', fixture().services, credentials), /increase/);
  const f = fixture();
  f.setTag('c'.repeat(40));
  await assert.rejects(release(receipt, '0.2.27', f.services, credentials), /another commit/);
  f.setTag(receipt.commit);
  f.services.marketplaceVersions = async () => [{ version: receipt.version, prerelease: false }];
  f.services.marketplaceDigest = async () => 'c'.repeat(64);
  await assert.rejects(release(receipt, '0.2.27', f.services, credentials), /artifact mismatch/);
  f.services.marketplaceVersions = async () => [{ version: receipt.version, prerelease: true }];
  await assert.rejects(release(receipt, '0.2.27', f.services, credentials), /channel mismatch/);
  f.services.marketplaceVersions = async () => [{ version: '0.2.29', prerelease: false }];
  await assert.rejects(release(receipt, '0.2.27', f.services, credentials), /newer version/);
  assert.deepEqual(f.trace, []);
});

test('Pi VSIX inspection rejects prerelease flags in either XML attribute order and README source drift', async () => {
  const { inspectVsix } = await import(pathToFileURL(resolve('scripts/inspect-vsix.mjs')).href);
  const directory = mkdtempSync(join(tmpdir(), 'pi-vsix-inspection-'));
  const extension = join(directory, 'extension');
  mkdirSync(extension);
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  writeFileSync(join(extension, 'package.json'), readFileSync('package.json'));
  writeFileSync(join(extension, 'readme.md'), 'owned altered README');
  const identity = `<Identity Publisher="mr-narender" Version="${pkg.version}"/>`;
  try {
    for (const [index, property] of [
      '<Property Id="Microsoft.VisualStudio.Code.PreRelease" Value="true"/>',
      '<Property Value="true" Id="Microsoft.VisualStudio.Code.PreRelease"/>',
      '',
    ].entries()) {
      writeFileSync(
        join(directory, 'extension.vsixmanifest'),
        `<PackageManifest>${identity}${property}</PackageManifest>`
      );
      const file = join(directory, `owned-${index}.vsix`);
      childProcess.execFileSync(
        'zip',
        ['-q', file, 'extension/package.json', 'extension/readme.md', 'extension.vsixmanifest'],
        { cwd: directory }
      );
      assert.throws(
        () => inspectVsix(file),
        property ? /Prerelease VSIX/ : /VSIX source mismatch: README.md/
      );
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
