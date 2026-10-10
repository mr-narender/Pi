import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inspectVsix, sha256, subprocessEnvironment } from './inspect-vsix.mjs';

const repository = 'mr-narender/Pi';
const stable = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export function previousVersionForPush(before, env = process.env) {
  assert.match(before, /^[a-f0-9]{40}$/, 'Trusted push requires its before commit');
  assert.notEqual(before, '0'.repeat(40), 'Initial/deleted main pushes require owner recovery');
  const childEnv = subprocessEnvironment(env);
  execFileSync('git', ['merge-base', '--is-ancestor', before, 'HEAD'], { env: childEnv });
  return JSON.parse(
    execFileSync('git', ['show', `${before}:package.json`], { encoding: 'utf8', env: childEnv })
  ).version;
}
export function compareVersions(a, b) {
  assert.match(a, stable, 'Only stable versions can be released');
  assert.match(b, stable, 'Only stable versions can be compared');
  const left = a.split('.').map(BigInt);
  const right = b.split('.').map(BigInt);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  return 0;
}

// Services are the two external boundaries, supplied by tests without real credentials or writes.
export async function release(receipt, previousVersion, services, credentials) {
  assert.equal(receipt.channel, 'stable');
  assert.equal(receipt.repository, repository);
  assert.equal(receipt.publisher, 'mr-narender');
  assert.equal(receipt.name, 'pi');
  assert.match(receipt.commit, /^[a-f0-9]{40}$/);
  assert.match(receipt.sha256, /^[a-f0-9]{64}$/);
  const change = compareVersions(receipt.version, previousVersion);
  if (!change) return 'Version unchanged; publication skipped.';
  assert.ok(change > 0, 'Version must increase on main');
  assert.ok(credentials.github, 'GH_TOKEN is required for GitHub release creation');
  assert.ok(credentials.marketplace, 'VSCE_PAT Actions secret is missing; owner setup required');
  const tag = `v${receipt.version}`;
  const tagSha = await services.tagSha(tag);
  assert.ok(!tagSha || tagSha === receipt.commit, 'Existing release tag points to another commit');
  const versions = await services.marketplaceVersions();
  for (const version of versions)
    if (stable.test(version.version))
      assert.ok(
        compareVersions(receipt.version, version.version) >= 0,
        'Marketplace already has a newer version'
      );
  const published = versions.find((v) => v.version === receipt.version);
  if (published) {
    assert.equal(published.prerelease, false, 'Marketplace channel mismatch');
    assert.equal(
      await services.marketplaceDigest(receipt.version),
      receipt.sha256,
      'Marketplace artifact mismatch'
    );
  }
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
  if (!published) {
    await services.publishMarketplace();
    assert.equal(
      await services.marketplaceDigest(receipt.version),
      receipt.sha256,
      'Published Marketplace artifact mismatch'
    );
  }
  if (github.draft) await services.completeGithub(github.id);
  return `Released stable mr-narender.pi ${receipt.version} from ${receipt.commit}.`;
}

async function request(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(60000) });
  if (response.status === 404 && options.allowMissing) return undefined;
  if (!response.ok) throw new Error(`Release service request failed (${response.status})`);
  return response;
}

export function productionServices(directory, receipt, env) {
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
    async marketplaceVersions() {
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
    async marketplaceDigest(version) {
      for (let attempt = 0; attempt < 12; attempt++) {
        const response = await request(
          `https://marketplace.visualstudio.com/_apis/public/gallery/publishers/mr-narender/vsextensions/pi/${version}/vspackage`,
          { allowMissing: true }
        );
        if (response) return sha256(Buffer.from(await response.arrayBuffer()));
        if (attempt < 11) await new Promise((done) => setTimeout(done, 5000));
      }
      throw new Error('Marketplace artifact propagation timed out; rerun failed jobs');
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
      try {
        execFileSync(
          process.execPath,
          [
            resolve('node_modules/@vscode/vsce/vsce'),
            'publish',
            '--packagePath',
            resolve(directory, receipt.file),
          ],
          {
            env: { ...subprocessEnvironment(env), VSCE_PAT: env.VSCE_PAT },
            stdio: 'pipe',
            timeout: 180000,
          }
        );
      } catch {
        // Child output stays private: it can contain authentication or service details.
        throw new Error(
          'Marketplace publication failed; rerun the failed release job with the same artifact'
        );
      }
    },
    completeGithub: (id) =>
      github(`releases/${id}`, { method: 'PATCH', body: JSON.stringify({ draft: false }) }),
  };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    assert.equal(process.env.GITHUB_EVENT_NAME, 'push', 'Publication requires a trusted main push');
    assert.equal(process.env.GITHUB_REF, 'refs/heads/main');
    assert.equal(process.env.GITHUB_REPOSITORY, repository);
    const directory = resolve(process.argv[2]);
    const receipt = JSON.parse(readFileSync(resolve(directory, 'receipt.json')));
    assert.equal(receipt.file, 'pi.vsix');
    assert.equal(receipt.commit, process.env.GITHUB_SHA, 'Artifact belongs to another commit');
    assert.equal(
      execFileSync('git', ['rev-parse', 'HEAD'], {
        encoding: 'utf8',
        env: subprocessEnvironment(),
      }).trim(),
      receipt.commit
    );
    assert.equal(
      execFileSync('git', ['status', '--porcelain'], {
        encoding: 'utf8',
        env: subprocessEnvironment(),
      }).trim(),
      '',
      'Release checkout is dirty'
    );
    assert.deepEqual(
      inspectVsix(resolve(directory, receipt.file), process.cwd(), receipt.bundles),
      receipt,
      'VSIX receipt mismatch'
    );
    const previous = previousVersionForPush(process.env.PI_PREVIOUS_SHA);
    console.log(
      await release(receipt, previous, productionServices(directory, receipt, process.env), {
        github: process.env.GH_TOKEN,
        marketplace: process.env.VSCE_PAT,
      })
    );
  } catch (error) {
    // Never print credential-bearing child errors, response bodies or assertions containing environment values.
    console.error(
      error.message.includes('VSCE_PAT Actions secret is missing')
        ? 'Pi release failed: VSCE_PAT Actions secret is missing. The owner must add the raw Marketplace PAT, then rerun failed jobs.'
        : 'Pi release failed. Check main/source/artifact/version and VSCE_PAT setup; rerun the failed release job after fixing the cause.'
    );
    process.exitCode = 1;
  }
}
