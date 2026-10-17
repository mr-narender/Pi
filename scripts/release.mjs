import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inspectVsix, sha256, subprocessEnvironment } from './inspect-vsix.mjs';
import {
  compareVersions,
  planRelease,
  stampReleaseVersion,
  gitVersionCommand,
} from './release-version.mjs';
import { changeScope } from './ci-change-scope.mjs';
export { compareVersions } from './release-version.mjs';

const repository = 'mr-narender/Pi';
const stable = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const stages = new Set([
  'source-validation',
  'artifact-validation',
  'version-validation',
  'credentials',
  'marketplace-profile',
  'recovery-validation',
  'github-release',
  'marketplace-query',
  'github-assets',
  'marketplace-publish',
  'marketplace-verification',
  'github-completion',
]);
const categories = new Set([
  'validation-failed',
  'unexpected-error',
  'http-error',
  'missing-azure-session',
  'missing-github-token',
  'timeout',
  'child-failed',
]);
class HttpFailure extends Error {
  constructor(status) {
    super('Release service request failed');
    this.status = status;
  }
}
class CredentialFailure extends Error {
  constructor(marketplace) {
    super('Release credential unavailable');
    this.category = marketplace ? 'missing-azure-session' : 'missing-github-token';
  }
}
class MarketplaceFailure extends Error {
  constructor(error) {
    super('Marketplace command failed');
    this.exit =
      Number.isInteger(error?.status) && error.status >= 0 && error.status <= 255
        ? error.status
        : undefined;
    this.category = error?.code === 'ETIMEDOUT' ? 'timeout' : 'child-failed';
  }
}
export function formatReleaseFailure(error, stage) {
  const safeStage = stages.has(stage) ? stage : 'unknown';
  let category = error instanceof assert.AssertionError ? 'validation-failed' : 'unexpected-error';
  const details = [];
  if (error instanceof HttpFailure) {
    category = 'http-error';
    if (Number.isInteger(error.status) && error.status >= 100 && error.status <= 599)
      details.push(`HTTP ${error.status}`);
  } else if (error instanceof CredentialFailure) category = error.category;
  else if (error?.name === 'MarketplacePropagationTimeout') category = 'timeout';
  else if (error instanceof MarketplaceFailure) {
    category = error.category;
    if (Number.isInteger(error.status) && error.status >= 100 && error.status <= 599)
      details.push(`HTTP ${error.status}`);
    if (Number.isInteger(error.exit) && error.exit >= 0 && error.exit <= 255)
      details.push(`exit ${error.exit}`);
  }
  if (!categories.has(category)) category = 'unexpected-error';
  const guidance =
    safeStage === 'marketplace-profile'
      ? 'Check main-only OIDC login and Marketplace profile access.'
      : safeStage === 'marketplace-publish'
        ? 'Check Contributor access for the displayed profile ID, then retry the pending release.'
        : safeStage === 'marketplace-verification'
          ? 'Wait for Marketplace propagation, then rerun failed jobs; do not republish.'
          : 'Rerun the failed job after fixing this stage.';
  return `Pi release failed at ${safeStage}: ${category}${details.length ? ` (${details.join(', ')})` : ''}. ${guidance}`;
}
function azureEnvironment(env) {
  return {
    ...subprocessEnvironment(env),
    ...(env.AZURE_CONFIG_DIR ? { AZURE_CONFIG_DIR: env.AZURE_CONFIG_DIR } : {}),
    AZURE_CORE_OUTPUT: 'none',
  };
}
function invokeAzure(command, args, env) {
  try {
    return execFileSync(command, args, {
      env: azureEnvironment(env),
      stdio: 'pipe',
      timeout: 180000,
    });
  } catch (error) {
    // Never emit child output, credentials, service bodies or arbitrary error properties.
    throw new MarketplaceFailure(error);
  }
}
export function marketplaceProfile(env) {
  const profile = JSON.parse(
    invokeAzure(
      'az',
      [
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
      ],
      env
    ).toString()
  );
  assert.match(profile.id, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i);
  return profile.id;
}
export function previousVersionForPush(before, env = process.env) {
  assert.match(before, /^[a-f0-9]{40}$/, 'Trusted push requires its before commit');
  assert.notEqual(before, '0'.repeat(40), 'Initial/deleted main pushes require owner recovery');
  const childEnv = subprocessEnvironment(env);
  execFileSync('git', ['merge-base', '--is-ancestor', before, 'HEAD'], {
    env: childEnv,
    stdio: 'pipe',
  });
  return JSON.parse(
    execFileSync('git', ['show', `${before}:package.json`], {
      encoding: 'utf8',
      env: childEnv,
      stdio: 'pipe',
    })
  ).version;
}

// Services are the two external boundaries, supplied by tests without real credentials or writes.
export async function release(receipt, previousVersion, services, credentials, onStage = () => {}) {
  onStage('version-validation');
  assert.equal(receipt.channel, 'stable');
  assert.equal(receipt.repository, repository);
  assert.equal(receipt.publisher, 'mr-narender');
  assert.equal(receipt.name, 'pi');
  assert.match(receipt.commit, /^[a-f0-9]{40}$/);
  assert.match(receipt.sha256, /^[a-f0-9]{64}$/);
  const change = compareVersions(receipt.version, previousVersion);
  if (!change) return 'Version unchanged; publication skipped.';
  assert.ok(change > 0, 'Version must increase on main');
  onStage('credentials');
  if (!credentials.github) throw new CredentialFailure(false);
  if (!credentials.marketplace) throw new CredentialFailure(true);
  const tag = `v${receipt.version}`;
  onStage('github-release');
  const tagSha = await services.tagSha(tag);
  assert.ok(!tagSha || tagSha === receipt.commit, 'Existing release tag points to another commit');
  onStage('marketplace-query');
  const versions = await services.marketplaceVersions();
  const published = validateMarketplaceVersions(receipt, versions);
  const existingDigest = await services.marketplaceDigest(receipt.version);
  if (existingDigest !== undefined) {
    assert.equal(existingDigest, receipt.sha256, 'Marketplace artifact mismatch');
  }
  onStage('github-release');
  let github = await services.githubRelease(tag);
  if (github) {
    assert.equal(github.prerelease, false, 'GitHub channel mismatch');
    if (github.draft)
      assert.equal(github.target_commitish, receipt.commit, 'Draft source mismatch');
    assert.equal(await services.tagSha(tag), receipt.commit, 'GitHub release tag mismatch');
  }
  if (!tagSha) await services.createTag(tag, receipt.commit);
  if (!github) github = await services.createDraft(tag, receipt.commit);
  assert.equal(await services.tagSha(tag), receipt.commit, 'Created release tag mismatch');
  onStage('github-assets');
  const assets = [
    [`pi-${receipt.version}.vsix`, receipt.sha256],
    ['receipt.json', sha256(Buffer.from(JSON.stringify(receipt, null, 2) + '\n'))],
  ];
  for (const [name, digest] of assets) {
    const asset = github.assets.find((a) => a.name === name);
    if (asset)
      assert.equal(await services.githubAssetDigest(asset), digest, 'GitHub artifact mismatch');
    else await services.upload(github.id, name);
  }
  if (!published && existingDigest === undefined) {
    onStage('marketplace-publish');
    await services.publishMarketplace();
  }
  onStage('marketplace-verification');
  await verifyMarketplacePublication(receipt, services);
  onStage('github-completion');
  if (github.draft) await services.completeGithub(github.id);
  return `Released stable mr-narender.pi ${receipt.version} from ${receipt.commit}.`;
}

function validateMarketplaceVersions(receipt, versions) {
  for (const version of versions)
    if (stable.test(version.version))
      assert.ok(
        compareVersions(receipt.version, version.version) >= 0,
        'Marketplace already has a newer version'
      );
  const published = versions.find((version) => version.version === receipt.version);
  if (published) assert.equal(published.prerelease, false, 'Marketplace channel mismatch');
  return published;
}

async function verifyMarketplacePublication(receipt, services) {
  const now = services.now ?? Date.now;
  const sleep = services.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
  const deadline = now() + 600000;
  let delay = 2000;
  while (now() < deadline) {
    const signal = AbortSignal.timeout(Math.max(1, Math.ceil(deadline - now())));
    try {
      const published = validateMarketplaceVersions(
        receipt,
        await services.marketplaceVersions(signal)
      );
      const digest = await services.marketplaceDigest(receipt.version, signal);
      if (digest !== undefined)
        assert.equal(digest, receipt.sha256, 'Published Marketplace artifact mismatch');
      const readmeMatches = await services.marketplaceReadmeMatches(receipt.version, signal);
      if (published && digest === receipt.sha256 && readmeMatches) return;
    } catch (error) {
      const transient =
        error?.status === 429 ||
        (error?.status >= 500 && error?.status <= 599) ||
        ['TimeoutError', 'AbortError'].includes(error?.name) ||
        [
          'ECONNRESET',
          'ECONNREFUSED',
          'ETIMEDOUT',
          'EAI_AGAIN',
          'UND_ERR_CONNECT_TIMEOUT',
        ].includes(error?.cause?.code);
      if (!transient) throw error;
    }
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await sleep(Math.min(delay, remaining));
    delay = Math.min(delay * 2, 30000);
  }
  const error = new Error('Marketplace version, approved package and README propagation timed out');
  error.name = 'MarketplacePropagationTimeout';
  throw error;
}

async function request(url, options = {}) {
  const timeout = AbortSignal.timeout(60000);
  const response = await fetch(url, {
    ...options,
    signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
  });
  if (response.status === 404 && options.allowMissing) return undefined;
  if (!response.ok) throw new HttpFailure(response.status);
  return response;
}

export function productionServices(directory, receipt, env) {
  let approvedReadmeDigest;
  const github = async (path, options = {}) => {
    const response = await request(`https://api.github.com/repos/${repository}/${path}`, {
      ...options,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${env.GH_TOKEN}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...options.headers,
      },
    });
    return response?.json();
  };
  return {
    async tagSha(tag) {
      const ref = await github(`git/ref/tags/${tag}`, { allowMissing: true });
      if (!ref) return undefined;
      let object = ref.object;
      for (let i = 0; object.type === 'tag' && i < 5; i++)
        object = (await github(`git/tags/${object.sha}`)).object;
      assert.equal(object.type, 'commit', 'Release tag does not resolve to a commit');
      return object.sha;
    },
    async marketplaceVersions(signal) {
      const response = await request(
        'https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery',
        {
          method: 'POST',
          headers: {
            Accept: 'application/json;api-version=3.0-preview.1',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            filters: [
              {
                criteria: [{ filterType: 7, value: 'mr-narender.pi' }],
                pageNumber: 1,
                pageSize: 1,
              },
            ],
            flags: 17,
          }),
          signal,
        }
      );
      const body = await response.json();
      const extension = body.results?.[0]?.extensions?.find(
        (e) => e.publisher.publisherName === 'mr-narender' && e.extensionName === 'pi'
      );
      assert.ok(extension, 'Marketplace extension metadata unavailable');
      return extension.versions.map((v) => ({
        version: v.version,
        prerelease:
          v.properties?.some(
            (p) => p.key === 'Microsoft.VisualStudio.Code.PreRelease' && p.value === 'true'
          ) ?? false,
      }));
    },
    async marketplaceDigest(version, signal) {
      const response = await request(
        `https://marketplace.visualstudio.com/_apis/public/gallery/publishers/mr-narender/vsextensions/pi/${version}/vspackage`,
        { allowMissing: true, signal }
      );
      return response ? sha256(Buffer.from(await response.arrayBuffer())) : undefined;
    },
    async marketplaceReadmeMatches(version, signal) {
      approvedReadmeDigest ??= sha256(
        execFileSync('unzip', ['-p', resolve(directory, receipt.file), 'extension/readme.md'], {
          env: subprocessEnvironment(env),
          stdio: 'pipe',
          maxBuffer: 8 * 1024 * 1024,
        })
      );
      const response = await request(
        `https://mr-narender.gallery.vsassets.io/_apis/public/gallery/publisher/mr-narender/extension/pi/${version}/assetbyname/Microsoft.VisualStudio.Services.Content.Details`,
        { allowMissing: true, signal }
      );
      return response
        ? sha256(Buffer.from(await response.arrayBuffer())) === approvedReadmeDigest
        : false;
    },
    async githubRelease(tag) {
      for (let page = 1; page <= 10; page++) {
        const releases = await github(`releases?per_page=100&page=${page}`);
        const found = releases.find((entry) => entry.tag_name === tag);
        if (found) return found;
        if (releases.length < 100) return undefined;
      }
      throw new Error('GitHub release lookup exceeds reviewed pagination bound');
    },
    createTag: (tag, sha) =>
      github('git/refs', {
        method: 'POST',
        body: JSON.stringify({ ref: `refs/tags/${tag}`, sha }),
      }),
    createDraft: (tag, sha) =>
      github('releases', {
        method: 'POST',
        body: JSON.stringify({
          tag_name: tag,
          target_commitish: sha,
          name: `Pi ${receipt.version}`,
          draft: true,
          prerelease: false,
          body: `Stable Marketplace release from ${sha}. Exact package checksum: ${receipt.sha256}.`,
        }),
      }),
    async githubAssetDigest(asset) {
      if (asset.digest?.startsWith('sha256:')) return asset.digest.slice(7);
      const response = await request(
        `https://api.github.com/repos/${repository}/releases/assets/${asset.id}`,
        { headers: { Accept: 'application/octet-stream', Authorization: `Bearer ${env.GH_TOKEN}` } }
      );
      return sha256(Buffer.from(await response.arrayBuffer()));
    },
    async downloadAsset(asset) {
      const response = await request(
        `https://api.github.com/repos/${repository}/releases/assets/${asset.id}`,
        { headers: { Accept: 'application/octet-stream', Authorization: `Bearer ${env.GH_TOKEN}` } }
      );
      return Buffer.from(await response.arrayBuffer());
    },
    async qualitySucceeded(source) {
      const result = await github(`actions/runs?head_sha=${source}&per_page=100`);
      for (const run of result.workflow_runs) {
        if (
          run.head_sha !== source ||
          run.head_branch !== 'main' ||
          run.event !== 'push' ||
          run.path !== '.github/workflows/pi.yml'
        )
          continue;
        const result = await github(`actions/runs/${run.id}/jobs?filter=all&per_page=100`);
        if (
          result.jobs.some(
            (job) =>
              job.name === 'pi-quality' && job.head_sha === source && job.conclusion === 'success'
          )
        )
          return true;
      }
      return false;
    },
    async upload(id, name) {
      const bytes =
        name === 'receipt.json'
          ? readFileSync(resolve(directory, name))
          : readFileSync(resolve(directory, receipt.file));
      await request(
        `https://uploads.github.com/repos/${repository}/releases/${id}/assets?name=${encodeURIComponent(name)}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${env.GH_TOKEN}`,
            'Content-Type': 'application/octet-stream',
          },
          body: bytes,
        }
      );
    },
    async publishMarketplace() {
      invokeAzure(
        process.execPath,
        [
          resolve('node_modules/@vscode/vsce/vsce'),
          'publish',
          '--azure-credential',
          '--packagePath',
          resolve(directory, receipt.file),
        ],
        env
      );
    },
    completeGithub: (id) =>
      github(`releases/${id}`, { method: 'PATCH', body: JSON.stringify({ draft: false }) }),
  };
}

function assertSameArchiveContents(recovered, current, env) {
  const options = { env: subprocessEnvironment(env), stdio: 'pipe', maxBuffer: 32 * 1024 * 1024 };
  const entries = (file) => {
    const listing = execFileSync('unzip', ['-Z1', file], options).toString();
    assert.ok(listing.endsWith('\n'), 'Nonterminated VSIX entry listing');
    const names = listing.slice(0, -1).split('\n');
    assert.ok(
      names.every((name) => /\S/.test(name) && !/[\r\0]/.test(name)),
      'Malformed VSIX entry listing'
    );
    return names.sort();
  };
  const expected = entries(current);
  assert.deepEqual(
    entries(recovered),
    expected,
    'Recovered archive entries differ from current quality'
  );
  for (const name of expected) {
    // Unzip entry operands are patterns; escape metacharacters without invoking a shell.
    const literal = name.replace(/[*?\[\]\\]/g, (character) => `\\${character}`);
    assert.equal(
      sha256(execFileSync('unzip', ['-p', recovered, literal], options)),
      sha256(execFileSync('unzip', ['-p', current, literal], options)),
      'Recovered archive entry contents differ from current quality'
    );
  }
}

// Only the existing current-version draft is recoverable; callers cannot select a source or artifact.
export async function recoverPendingRelease(directory, current, services, env, automatic = false) {
  const draft = await services.githubRelease(`v${current.version}`);
  assert.ok(
    draft && (draft.draft || automatic) && !draft.prerelease,
    'Current-version draft required'
  );
  assert.equal(draft.tag_name, `v${current.version}`);
  const source = draft.target_commitish;
  assert.match(source, /^[a-f0-9]{40}$/);
  assert.equal(await services.tagSha(`v${current.version}`), source);
  const childEnv = subprocessEnvironment(env);
  execFileSync('git', ['merge-base', '--is-ancestor', source, 'HEAD'], {
    env: childEnv,
    stdio: 'pipe',
  });
  assert.ok(await services.qualitySucceeded(source), 'Original main quality must have succeeded');
  const permittedAssets = ['receipt.json', `pi-${current.version}.vsix`];
  if (automatic)
    assert.ok(
      draft.assets.every((entry) => permittedAssets.includes(entry.name)),
      'Unexpected release asset'
    );
  else
    assert.deepEqual(
      draft.assets.map((entry) => entry.name).sort(),
      permittedAssets.sort(),
      'Only the two reviewed release assets are allowed'
    );
  const asset = (name) => {
    const matches = draft.assets.filter((entry) => entry.name === name);
    assert.equal(matches.length, 1, 'Unique existing release asset required');
    assert.match(matches[0].digest, /^sha256:[a-f0-9]{64}$/);
    return matches[0];
  };
  const vsixAsset = asset(`pi-${current.version}.vsix`);
  const vsix = await services.downloadAsset(vsixAsset);
  assert.equal(`sha256:${sha256(vsix)}`, vsixAsset.digest);
  const receiptAsset = draft.assets.some((entry) => entry.name === 'receipt.json')
    ? asset('receipt.json')
    : undefined;
  assert.ok(receiptAsset || automatic, 'Existing receipt required');
  const bytes = receiptAsset
    ? await services.downloadAsset(receiptAsset)
    : Buffer.from(
        JSON.stringify({ ...current, commit: source, sha256: sha256(vsix) }, null, 2) + '\n'
      );
  if (receiptAsset) assert.equal(sha256(bytes), receiptAsset.digest.slice(7));
  const receipt = JSON.parse(bytes);
  assert.equal(receipt.commit, source);
  assert.equal(receipt.version, current.version);
  assert.equal(receipt.file, 'pi.vsix');
  assert.deepEqual(receipt.bundles, current.bundles, 'Current quality bundles differ');
  assert.equal(vsixAsset.digest, `sha256:${receipt.sha256}`);
  assert.equal(sha256(vsix), receipt.sha256);
  const recovery = mkdtempSync(join(dirname(directory), 'pi-recovery-'));
  const original = join(recovery, 'source');
  let checkedOut = false;
  try {
    try {
      writeFileSync(join(recovery, 'receipt.json'), bytes);
      writeFileSync(join(recovery, 'pi.vsix'), vsix);
      assertSameArchiveContents(join(recovery, 'pi.vsix'), resolve(directory, current.file), env);
      execFileSync(
        'git',
        ['-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '--detach', original, source],
        { env: childEnv, stdio: 'pipe' }
      );
      checkedOut = true;
      const versionGit = (args, root) => gitVersionCommand(args, root, env);
      if (automatic) stampReleaseVersion(receipt.version, original, versionGit);
      // Execute this reviewed inspector, never scripts or hooks from the old checkout.
      assert.deepEqual(
        inspectVsix(join(recovery, 'pi.vsix'), original, receipt.bundles, env),
        receipt
      );
      // VSCE transforms CHANGELOG Markdown; compare its original/current source separately.
      assert.equal(
        sha256(readFileSync(join(original, 'CHANGELOG.md'))),
        sha256(readFileSync(resolve('CHANGELOG.md'))),
        'CHANGELOG source differs from reviewed main'
      );
      assert.deepEqual(
        inspectVsix(join(recovery, 'pi.vsix'), process.cwd(), receipt.bundles, env),
        { ...receipt, commit: current.commit },
        'Packaged source differs from reviewed main'
      );
      const parent = execFileSync('git', ['rev-parse', `${source}^`], {
        encoding: 'utf8',
        env: childEnv,
        stdio: 'pipe',
      }).trim();
      const previous = automatic
        ? planRelease(source, (args) => versionGit(args, original)).previous
        : previousVersionForPush(parent, env);
      assert.ok(
        compareVersions(receipt.version, previous) > 0,
        'Draft must originate at a version increase'
      );
      return { directory: recovery, receipt, previous };
    } finally {
      if (checkedOut)
        execFileSync('git', ['worktree', 'remove', '--force', original], {
          env: childEnv,
          stdio: 'pipe',
        });
    }
  } catch (error) {
    rmSync(recovery, { recursive: true, force: true });
    throw error;
  }
}

export async function runRelease(directory, env = process.env) {
  let stage = 'source-validation';
  try {
    assert.ok(
      ['push', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME),
      'Trusted main event required'
    );
    const operation = env.GITHUB_EVENT_NAME === 'push' ? 'push' : env.PI_RELEASE_OPERATION;
    if (operation === 'push') assert.ok(!env.PI_RELEASE_OPERATION);
    assert.ok(['push', 'profile', 'retry-pending-release'].includes(operation));
    assert.equal(env.GITHUB_REF, 'refs/heads/main');
    assert.equal(env.GITHUB_REPOSITORY, repository);
    directory = resolve(directory);
    stage = 'artifact-validation';
    let receipt = JSON.parse(readFileSync(resolve(directory, 'receipt.json')));
    assert.equal(receipt.file, 'pi.vsix');
    assert.equal(receipt.commit, env.GITHUB_SHA, 'Artifact belongs to another commit');
    assert.equal(
      execFileSync('git', ['rev-parse', 'HEAD'], {
        encoding: 'utf8',
        env: subprocessEnvironment(env),
        stdio: 'pipe',
      }).trim(),
      receipt.commit
    );
    assert.equal(
      execFileSync('git', ['status', '--porcelain'], {
        encoding: 'utf8',
        env: subprocessEnvironment(env),
        stdio: 'pipe',
      }).trim(),
      '',
      'Release checkout is dirty'
    );
    let automaticPlan;
    const versionGit = (args, root) => gitVersionCommand(args, root, env);
    if (env.PI_AUTOMATIC_RELEASE === 'true' && operation !== 'profile') {
      automaticPlan = planRelease(receipt.commit, versionGit, operation);
      if (!automaticPlan.release) {
        console.log('Newer released source supersedes this run; publication skipped.');
        return 0;
      }
      assert.equal(
        receipt.version,
        automaticPlan.version,
        'Artifact version differs from tag ledger'
      );
      stampReleaseVersion(receipt.version, process.cwd(), versionGit, automaticPlan.source);
    }
    assert.deepEqual(
      inspectVsix(resolve(directory, receipt.file), process.cwd(), receipt.bundles, env),
      receipt,
      'VSIX receipt mismatch'
    );
    stage = 'version-validation';
    const pushPrevious =
      operation === 'push' ? previousVersionForPush(env.PI_PREVIOUS_SHA, env) : undefined;
    if (automaticPlan && operation === 'push')
      assert.ok(
        changeScope(
          'push',
          { before: env.PI_PREVIOUS_SHA, after: receipt.commit },
          receipt.commit,
          versionGit
        ).release,
        'Push has no releasable changes'
      );
    let previous = automaticPlan?.previous ?? pushPrevious;
    if (operation === 'push') assert.ok(compareVersions(receipt.version, previous) >= 0);
    stage = 'marketplace-profile';
    if (!env.AZURE_CONFIG_DIR) throw new CredentialFailure(true);
    console.log(`Marketplace profile ID: ${marketplaceProfile(env)}`);
    if (operation === 'profile') return 0;
    let recovery;
    if (
      operation === 'retry-pending-release' ||
      (automaticPlan?.existing &&
        (await productionServices(directory, receipt, env).githubRelease(`v${receipt.version}`))
          ?.assets.length)
    ) {
      stage = 'recovery-validation';
      recovery = await recoverPendingRelease(
        directory,
        receipt,
        productionServices(directory, receipt, env),
        env,
        !!automaticPlan
      );
      ({ directory, receipt, previous } = recovery);
    }
    try {
      console.log(
        await release(
          receipt,
          previous,
          productionServices(directory, receipt, env),
          {
            github: env.GH_TOKEN,
            marketplace: env.AZURE_CONFIG_DIR,
          },
          (next) => {
            stage = next;
          }
        )
      );
      return 0;
    } finally {
      if (recovery) rmSync(recovery.directory, { recursive: true, force: true });
    }
  } catch (error) {
    console.error(formatReleaseFailure(error, stage));
    return 1;
  }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  process.exitCode = await runRelease(process.argv[2]);
