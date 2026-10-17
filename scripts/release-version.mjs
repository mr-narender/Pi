import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { subprocessEnvironment } from './inspect-vsix.mjs';

export const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export function compareVersions(a, b) {
  assert.match(a, stableVersion, 'Only stable versions can be released');
  assert.match(b, stableVersion, 'Only stable versions can be compared');
  const left = a.split('.').map(BigInt);
  const right = b.split('.').map(BigInt);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  return 0;
}

export const gitVersionCommand = (args, root = process.cwd(), env = process.env) => {
  const bytes = execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: 'pipe',
    env: subprocessEnvironment(env),
  });
  return args[0] === 'show' ? bytes : bytes.trimEnd();
};

// Stable tags reserve versions, including drafts. GitHub's "latest" release is not a version ledger.
export function planRelease(head, git = gitVersionCommand, operation = 'push') {
  assert.match(head, /^[a-f0-9]{40}$/);
  const tags = git(['tag', '--list', 'v*'])
    .split('\n')
    .filter((tag) => stableVersion.test(tag.slice(1)))
    .map((tag) => ({ version: tag.slice(1), commit: git(['rev-parse', `${tag}^{commit}`]) }))
    .sort((a, b) => compareVersions(a.version, b.version));
  assert.ok(tags.length, 'Stable release baseline unavailable; owner recovery required');
  const latest = tags.at(-1);
  if (operation === 'retry-pending-release') {
    git(['merge-base', '--is-ancestor', latest.commit, head]);
    const previous = tags.at(-2)?.version;
    assert.ok(previous, 'Prior stable baseline unavailable');
    return {
      release: true,
      version: latest.version,
      previous,
      existing: true,
      source: latest.commit,
    };
  }
  const matches = tags.filter((entry) => entry.commit === head);
  assert.ok(matches.length <= 1, 'Multiple stable versions reserve the same source');
  if (latest.commit !== head) {
    try {
      git(['merge-base', '--is-ancestor', latest.commit, head]);
    } catch {
      git(['merge-base', '--is-ancestor', head, latest.commit]);
      return { release: false, version: latest.version, previous: latest.version };
    }
  }
  const current = JSON.parse(git(['show', `${head}:package.json`])).version;
  assert.match(current, stableVersion);
  const existing = matches[0];
  if (existing) {
    assert.equal(existing, latest, 'A newer stable release supersedes this source');
    const previous = tags.at(-2)?.version;
    assert.ok(previous, 'Prior stable baseline unavailable');
    return { release: true, version: existing.version, previous, existing: true, source: head };
  }
  const parts = latest.version.split('.');
  const next = `${parts[0]}.${parts[1]}.${BigInt(parts[2]) + 1n}`;
  return {
    release: true,
    version: compareVersions(current, next) > 0 ? current : next,
    previous: latest.version,
    existing: false,
    source: head,
  };
}

// Reconstruct generated metadata from committed bytes; never accept arbitrary dirty source.
export function stampReleaseVersion(
  version,
  root = process.cwd(),
  git = gitVersionCommand,
  releaseSource
) {
  assert.match(version, stableVersion);
  const head = git(['rev-parse', 'HEAD'], root);
  const originals = Object.fromEntries(
    ['package.json', 'package-lock.json', 'CHANGELOG.md'].map((name) => [
      name,
      git(['show', `HEAD:${name}`], root),
    ])
  );
  const pkg = JSON.parse(originals['package.json']);
  assert.ok(compareVersions(version, pkg.version) >= 0, 'Generated version cannot decrease');
  const generated = { ...originals };
  if (pkg.version !== version) {
    pkg.version = version;
    const lock = JSON.parse(originals['package-lock.json']);
    lock.version = version;
    lock.packages[''].version = version;
    generated['package.json'] = JSON.stringify(pkg, null, 2) + '\n';
    generated['package-lock.json'] = JSON.stringify(lock, null, 2) + '\n';
    assert.ok(originals['CHANGELOG.md'].startsWith('# Changelog\n\n'));
    generated['CHANGELOG.md'] = originals['CHANGELOG.md'].replace(
      '# Changelog\n\n',
      `# Changelog\n\n## ${version}\n\n- Automatic release of code changes from \`${releaseSource ?? head}\`.\n\n`
    );
  }
  for (const [name, content] of Object.entries(generated)) {
    const actual = readFileSync(resolve(root, name), 'utf8');
    assert.ok(
      actual === originals[name] || actual === content,
      `Unexpected metadata edit: ${name}`
    );
  }
  const changes = git(['diff', '--name-only', 'HEAD', '--'], root).split('\n').filter(Boolean);
  assert.ok(
    changes.every((name) => Object.hasOwn(generated, name)),
    'Release source is dirty'
  );
  assert.equal(
    git(['ls-files', '--others', '--exclude-standard'], root),
    '',
    'Untracked release source'
  );
  for (const [name, content] of Object.entries(generated))
    writeFileSync(resolve(root, name), content);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const operation = process.env.PI_RELEASE_OPERATION || 'push';
  assert.ok(['push', 'profile', 'retry-pending-release'].includes(operation));
  const plan =
    operation === 'profile'
      ? { release: true }
      : planRelease(gitVersionCommand(['rev-parse', 'HEAD']), gitVersionCommand, operation);
  if (plan.version)
    stampReleaseVersion(plan.version, process.cwd(), gitVersionCommand, plan.source);
  appendFileSync(process.env.GITHUB_OUTPUT, `release=${plan.release}\n`);
  console.log(
    plan.release
      ? `Reserved stable version ${plan.version} for packaging.`
      : 'Superseded source; publication skipped.'
  );
}
