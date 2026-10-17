import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { compareVersions } from './release-version.mjs';

const sha = /^[a-f0-9]{40}$/;
const gitCommand = (args) =>
  execFileSync('git', args, { encoding: 'utf8', stdio: 'pipe' }).trimEnd();
const fallback = () => ({ build: true, release: false, paths: [], fallback: true });

export function needsExtensionBuild(paths) {
  return paths.some(
    (path) =>
      /^(src|host|media|resources)\//.test(path) ||
      [
        'package.json',
        'package-lock.json',
        '.vscodeignore',
        'tsconfig.json',
        'scripts/build.mjs',
      ].includes(path)
  );
}

export function needsExtensionRelease(paths, base, head, git = gitCommand) {
  const runtimeChanged = needsExtensionBuild(
    paths.filter((path) => !['package.json', 'package-lock.json'].includes(path))
  );
  if (paths.includes('package.json')) {
    const previous = JSON.parse(git(['show', `${base}:package.json`]));
    const current = JSON.parse(git(['show', `${head}:package.json`]));
    const change = compareVersions(current.version, previous.version);
    assert.ok(change >= 0, 'Version rollback is forbidden');
    if (change > 0) return true;
    const runtime = (pkg) =>
      Object.fromEntries(
        Object.entries(pkg).filter(
          ([key]) => !['version', 'scripts', 'devDependencies', 'packageManager'].includes(key)
        )
      );
    if (!isDeepStrictEqual(runtime(previous), runtime(current))) return true;
  }
  if (paths.includes('package-lock.json')) {
    const production = (commit) => {
      const lock = JSON.parse(git(['show', `${commit}:package-lock.json`]));
      return Object.fromEntries(
        Object.entries(lock.packages).filter(([name, pkg]) => name && !pkg.dev)
      );
    };
    if (!isDeepStrictEqual(production(base), production(head))) return true;
  }
  return runtimeChanged;
}

export function changeScope(eventName, event, head, git = gitCommand) {
  assert.match(head, sha, 'Invalid checked-out source');
  if (eventName === 'workflow_dispatch') {
    assert.ok(
      ['profile', 'retry-pending-release'].includes(event.inputs?.operation),
      'Unknown manual operation'
    );
    return { build: true, release: true, paths: [], fallback: false };
  }
  assert.ok(eventName === 'push' || eventName === 'pull_request', 'Unsupported CI event');
  assert.equal(
    eventName === 'push' ? event.after : event.pull_request?.head?.sha,
    head,
    'Checkout must match event source'
  );
  const before = eventName === 'push' ? event.before : event.pull_request?.base?.sha;
  if (!sha.test(before ?? '') || /^0+$/.test(before)) return fallback();
  let base, changed;
  try {
    if (eventName === 'pull_request') base = git(['merge-base', before, head]).trim();
    else {
      git(['merge-base', '--is-ancestor', before, head]);
      base = before;
    }
    assert.match(base, sha);
    changed = git(['diff', '--name-only', '-z', '--no-renames', base, head]);
  } catch {
    return fallback();
  }
  assert.ok(!changed || changed.endsWith('\0'), 'Nonterminated changed-path list');
  const paths = changed ? changed.slice(0, -1).split('\0') : [];
  const build = needsExtensionBuild(paths);
  let release = false;
  if (eventName === 'push' && build) release = needsExtensionRelease(paths, base, head, git);
  return { build, release, paths, fallback: false };
}

export function validationTests(paths) {
  return [
    ...new Set([
      'test/unit/pi-ci-runtime.test.ts',
      'test/unit/pi-ci-scope.test.ts',
      'test/unit/pi-release.test.ts',
      'test/unit/pi-release-oidc.test.ts',
      'test/unit/pi-release-recovery.test.ts',
      'test/unit/pi-release-version.test.ts',
      ...paths.filter(
        (path) =>
          /^test\/(unit|integration)\/.+\.test\.ts$/.test(path) &&
          path !== 'test/unit/optional-module-build.test.ts'
      ),
    ]),
  ];
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const result = changeScope(
    process.env.GITHUB_EVENT_NAME,
    event,
    gitCommand(['rev-parse', 'HEAD'])
  );
  if (process.argv[2] === 'validate') {
    const tests = validationTests(result.paths).filter((path) => existsSync(path));
    execFileSync(process.execPath, ['--import', 'tsx', '--test', ...tests], { stdio: 'inherit' });
  } else {
    if (result.fallback)
      console.log('Change baseline unavailable: full quality, publication disabled.');
    appendFileSync(process.env.GITHUB_OUTPUT, `build=${result.build}\nrelease=${result.release}\n`);
  }
}
