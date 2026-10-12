import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const releaseModule = import(pathToFileURL(resolve('scripts/release.mjs')).href);
const source = 'a'.repeat(40);
const currentCommit = 'b'.repeat(40);
const privateMarker = 'OWNED-PRIVATE-MARKER';

async function recoveryFixture(scenario: string, onExtraction?: (entry: string) => void) {
  const { recoverPendingRelease, release } = await releaseModule;
  const { sha256 } = await import(pathToFileURL(resolve('scripts/inspect-vsix.mjs')).href);
  const root = fs.mkdtempSync(join(tmpdir(), 'pi-recovery-test-'));
  const directory = join(root, 'current');
  fs.mkdirSync(directory);
  const originalRead = fs.readFileSync;
  const originalReaddir = fs.readdirSync;
  const version = JSON.parse(originalRead('package.json', 'utf8')).version;
  const archive = Buffer.from('owned archive bytes');
  const bundle = Buffer.from('owned compiled bundle');
  const entries = [
    'extension/package.json',
    'extension/readme.md',
    'extension/NOTICE',
    'extension/LICENSE.txt',
    'extension/changelog.md',
    ...originalReaddir('host')
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
    commit: source,
    publisher: 'mr-narender',
    name: 'pi',
    version,
    channel: 'stable',
    file: 'pi.vsix',
    sha256: sha256(archive),
    bundles: Object.fromEntries(
      entries
        .filter((name) => name.includes('/dist/'))
        .map((name) => [name.slice(10), sha256(bundle)])
    ),
  };
  const receiptBytes = Buffer.from(JSON.stringify(receipt, null, 2) + '\n');
  const draft = {
    id: 1,
    tag_name: `v${version}`,
    draft: true,
    prerelease: false,
    target_commitish: source,
    assets: [
      { id: 1, name: 'receipt.json', digest: `sha256:${sha256(receiptBytes)}` },
      { id: 2, name: `pi-${version}.vsix`, digest: `sha256:${receipt.sha256}` },
    ],
  };
  if (scenario === 'published') draft.draft = false;
  if (scenario === 'duplicate') draft.assets.push(draft.assets[0]!);
  if (scenario === 'extra-release-asset')
    draft.assets.push({ id: 3, name: 'unreviewed.bin', digest: `sha256:${'c'.repeat(64)}` });
  if (scenario === 'missing-digest') draft.assets[0]!.digest = '';
  if (scenario === 'asset-digest') draft.assets[1]!.digest = `sha256:${'c'.repeat(64)}`;
  const current = { ...receipt, commit: currentCommit };
  if (scenario === 'bundles')
    current.bundles = { ...current.bundles, 'dist/chat.js': 'c'.repeat(64) };
  const events: string[] = [];
  let marketplacePublished = false;
  const commands: string[][] = [];
  const runtime = { PATH: '/owned/bin', HOME: '/owned/home' };
  const env = {
    ...runtime,
    GH_TOKEN: privateMarker,
    AZURE_CONFIG_DIR: '/owned/azure',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: privateMarker,
  };
  const services = {
    async githubRelease(tag: string) {
      assert.equal(tag, `v${version}`);
      return draft;
    },
    async tagSha() {
      return scenario === 'tag' ? 'c'.repeat(40) : source;
    },
    async qualitySucceeded(sha: string) {
      assert.equal(sha, source);
      return scenario !== 'quality';
    },
    async downloadAsset(asset: { id: number }) {
      if (scenario === 'receipt-bytes' && asset.id === 1) return Buffer.from(privateMarker);
      if (scenario === 'vsix-bytes' && asset.id === 2) return Buffer.from(privateMarker);
      return asset.id === 1 ? receiptBytes : archive;
    },
    async marketplaceVersions() {
      return [{ version: marketplacePublished ? receipt.version : '0.2.27', prerelease: false }];
    },
    async marketplaceDigest() {
      return marketplacePublished ? receipt.sha256 : undefined;
    },
    async marketplaceReadmeMatches() {
      return true;
    },
    async githubAssetDigest(asset: { digest: string }) {
      return asset.digest.slice(7);
    },
    async createTag() {
      assert.fail('Verified recovery must never create a tag');
    },
    async createDraft() {
      assert.fail('Verified recovery must never create a draft');
    },
    async upload() {
      assert.fail('Verified recovery must never replace assets');
    },
    async publishMarketplace() {
      events.push('publish');
      marketplacePublished = true;
    },
    async completeGithub() {
      events.push('complete');
    },
  };
  mock.method(fs, 'readFileSync', (file: any, options: any) => {
    if (String(file).includes('/source/')) {
      const relative = String(file).split('/source/')[1]!;
      if (relative === 'README.md' && scenario === 'packaged-source')
        return Buffer.from('old packaged README');
      if (relative === 'CHANGELOG.md' && scenario === 'changelog')
        return Buffer.from('old changelog');
      return originalRead(resolve(relative), options);
    }
    return originalRead(file, options);
  });
  mock.method(fs, 'readdirSync', (file: any, options: any) => {
    if (String(file).endsWith('/source/host')) return originalReaddir('host', options);
    return originalReaddir(file, options);
  });
  mock.method(childProcess, 'execFileSync', (command: string, args: string[], options: any) => {
    assert.deepEqual(options.env, runtime);
    assert.equal(options.stdio, 'pipe');
    if (command === 'git') {
      commands.push(args);
      if (args[0] === 'merge-base' && scenario === 'ancestor') throw new Error(privateMarker);
      if (args[0] === 'rev-parse')
        return args[1]!.endsWith('^')
          ? 'd'.repeat(40)
          : options.cwd?.endsWith('/source')
            ? source
            : currentCommit;
      if (args[0] === 'show')
        return JSON.stringify({ version: scenario === 'version' ? version : '0.2.27' });
      return '';
    }
    assert.equal(command, 'unzip');
    const recovered = args[1] !== join(directory, 'pi.vsix');
    if (args[0] === '-Z1') {
      const listing =
        [
          '[Content_Types].xml',
          'extension.vsixmanifest',
          ...entries,
          ...(recovered && scenario === 'root-payload' ? ['unreviewed-root-payload.bin'] : []),
          ...(recovered && scenario === 'option-entry' ? ['-unreviewed-option'] : []),
          ...(recovered && scenario === 'dist-entry' ? ['extension/dist/unreviewed.js'] : []),
          ...(recovered && scenario === 'whitespace-entry' ? [' '] : []),
        ].join('\n') + '\n';
      if (recovered && scenario === 'nonterminated-listing') return listing.slice(0, -1);
      if (recovered && scenario === 'malformed-listing') return listing + '\n';
      return listing;
    }
    const entry = args[2]!.replace(/\\([*?\[\]\\])/g, '$1');
    onExtraction?.(entry);
    if (entry.startsWith('-')) return Buffer.from('unreviewed option payload');
    if (entry === '[Content_Types].xml') {
      assert.equal(
        args[2],
        '\\[Content_Types\\].xml',
        'Unzip must read the literal bracketed entry'
      );
      return Buffer.from(
        recovered && scenario === 'content-types' ? 'unreviewed types' : 'owned content types'
      );
    }
    if (entry === 'unreviewed-root-payload.bin') return Buffer.from('unreviewed payload');
    if (entry === 'extension.vsixmanifest')
      return Buffer.from(
        `<Identity Version="${version}" Publisher="mr-narender"${recovered && scenario === 'manifest-target' ? ' TargetPlatform="linux-x64"' : ''}/>`
      );
    const file = entry.slice(10);
    if (file.startsWith('dist/')) return bundle;
    if (file === 'changelog.md' && recovered && scenario === 'nonbundle-content')
      return Buffer.concat([originalRead('CHANGELOG.md'), Buffer.from('\n<!-- unreviewed -->')]);
    if (file === 'readme.md' && scenario === 'packaged-source')
      return Buffer.from('old packaged README');
    const aliases: Record<string, string> = {
      'readme.md': 'README.md',
      'LICENSE.txt': 'LICENSE',
      'changelog.md': 'CHANGELOG.md',
    };
    return originalRead(resolve(aliases[file] ?? file));
  });
  syncBuiltinESMExports();
  try {
    const recovery = await recoverPendingRelease(directory, current, services, env);
    assert.deepEqual(recovery.receipt, receipt);
    assert.deepEqual(originalRead(join(recovery.directory, 'receipt.json')), receiptBytes);
    assert.deepEqual(originalRead(join(recovery.directory, 'pi.vsix')), archive);
    assert.ok(
      commands.some((args) =>
        args.join(' ').includes('core.hooksPath=/dev/null worktree add --detach')
      )
    );
    assert.ok(commands.some((args) => args[0] === 'worktree' && args[1] === 'remove'));
    await release(recovery.receipt, recovery.previous, services, {
      github: privateMarker,
      marketplace: '/owned/azure',
    });
    assert.deepEqual(events, ['publish', 'complete']);
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('pending draft recovery retains original bytes/source, checks current quality and uses no old scripts/hooks', async () => {
  await recoveryFixture('valid');
});

for (const scenario of [
  'published',
  'duplicate',
  'extra-release-asset',
  'missing-digest',
  'asset-digest',
  'tag',
  'quality',
  'ancestor',
  'receipt-bytes',
  'vsix-bytes',
  'bundles',
  'packaged-source',
  'changelog',
  'version',
  'root-payload',
  'dist-entry',
  'manifest-target',
  'content-types',
  'nonbundle-content',
])
  test(`pending draft recovery refuses ${scenario} before publishing`, async () => {
    await assert.rejects(recoveryFixture(scenario));
  });

test('recovery rejects unexpected option-like entry names before passing them to unzip extraction', async () => {
  const extracted: string[] = [];
  await assert.rejects(recoveryFixture('option-entry', (entry) => extracted.push(entry)));
  assert.ok(!extracted.includes('-unreviewed-option'));
});

for (const scenario of ['whitespace-entry', 'nonterminated-listing', 'malformed-listing'])
  test(`recovery rejects ${scenario} before any entry extraction`, async () => {
    const extracted: string[] = [];
    await assert.rejects(recoveryFixture(scenario, (entry) => extracted.push(entry)));
    assert.deepEqual(extracted, []);
  });

test('original quality proof requires canonical main push workflow, exact source and successful aggregate', async () => {
  const { productionServices } = await releaseModule;
  for (const scenario of [
    'valid',
    'branch',
    'event',
    'path',
    'source',
    'job-source',
    'job-status',
    'job-name',
  ]) {
    const run = {
      id: 1,
      head_sha: source,
      head_branch: 'main',
      event: 'push',
      path: '.github/workflows/pi.yml',
    };
    const job = { name: 'pi-quality', head_sha: source, conclusion: 'success' };
    if (scenario === 'branch') run.head_branch = 'feature';
    if (scenario === 'event') run.event = 'pull_request';
    if (scenario === 'path') run.path = 'untrusted.yml';
    if (scenario === 'source') run.head_sha = 'c'.repeat(40);
    if (scenario === 'job-source') job.head_sha = 'c'.repeat(40);
    if (scenario === 'job-status') job.conclusion = 'failure';
    if (scenario === 'job-name') job.name = 'untrusted';
    mock.method(globalThis, 'fetch', async (url: string, options: any) => {
      assert.ok(url.startsWith('https://api.github.com/repos/mr-narender/Pi/actions/runs'));
      assert.equal(options.headers.Authorization, `Bearer ${privateMarker}`);
      assert.equal(options.method, undefined);
      return Response.json(url.includes('/jobs?') ? { jobs: [job] } : { workflow_runs: [run] });
    });
    try {
      assert.equal(
        await productionServices('/owned', {}, { GH_TOKEN: privateMarker }).qualitySucceeded(
          source
        ),
        scenario === 'valid'
      );
    } finally {
      mock.restoreAll();
    }
  }
});
