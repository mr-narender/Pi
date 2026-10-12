import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scope = import(pathToFileURL(resolve('scripts/ci-change-scope.mjs')).href);
const before = 'a'.repeat(40),
  head = 'b'.repeat(40),
  base = 'c'.repeat(40);

test('CI classification separates validation-only changes from shipped runtime inputs', async () => {
  const { needsExtensionBuild } = await scope;
  for (const path of [
    '.github/workflows/pi.yml',
    '.github/pi-sdk/package-lock.json',
    'docs/ci-release.md',
    'README.md',
    'CHANGELOG.md',
    'NOTICE',
    'LICENSE',
    'scripts/release.mjs',
    'scripts/inspect-vsix.mjs',
    'test/unit/foo.test.ts',
    'eslint.config.mjs',
    'unknown-runtime-file',
    'new-infra/config.yaml',
    'package-release.json',
  ])
    assert.equal(needsExtensionBuild([path]), false, path);
  for (const path of [
    'src/extension.ts',
    'host/startup-adapter.mjs',
    'media/icon.svg',
    'resources/approval-gate.mjs',
    'package.json',
    'package-lock.json',
    '.vscodeignore',
    'scripts/build.mjs',
    'tsconfig.json',
  ])
    assert.equal(needsExtensionBuild([path]), true, path);
  assert.equal(needsExtensionBuild(['docs/readme.md', 'host/deleted.mjs']), true);
});

test('PR diff uses the exact head merge base, NUL paths and both sides of renamed runtime files', async () => {
  const { changeScope } = await scope;
  const calls: string[][] = [];
  const git = (args: string[]) => {
    calls.push(args);
    if (args[0] === 'merge-base') return base;
    if (args[0] === 'diff') return 'src/deleted.ts\0docs/moved.md\0';
    throw new Error('unexpected command');
  };
  const result = changeScope(
    'pull_request',
    { pull_request: { base: { sha: before }, head: { sha: head } } },
    head,
    git
  );
  assert.equal(result.build, true);
  assert.equal(result.release, false);
  assert.deepEqual(calls, [
    ['merge-base', before, head],
    ['diff', '--name-only', '-z', '--no-renames', base, head],
  ]);
});

test('push classifies the entire before-to-after range and releases only increasing runtime versions', async () => {
  const { changeScope } = await scope;
  for (const paths of ['src/a.ts\0docs/b.md\0', 'docs/a.md\0']) {
    for (const next of ['0.2.30', '0.2.31']) {
      const calls: string[][] = [];
      const git = (args: string[]) => {
        calls.push(args);
        if (args[0] === 'merge-base') return '';
        if (args[0] === 'diff') return paths;
        if (args[0] === 'show')
          return JSON.stringify({ version: args[1]!.startsWith(before) ? '0.2.30' : next });
        throw new Error('unexpected command');
      };
      const result = changeScope('push', { before, after: head }, head, git);
      assert.equal(result.build, paths.startsWith('src/'));
      assert.equal(result.release, paths.startsWith('src/') && next === '0.2.31');
      assert.ok(
        calls.some(
          (args) => args.join(' ') === `diff --name-only -z --no-renames ${before} ${head}`
        )
      );
    }
  }
});

test('missing baselines build conservatively without publishing; explicit manual operations retain full proof', async () => {
  const { changeScope } = await scope;
  assert.deepEqual(
    changeScope('push', { before: '0'.repeat(40), after: head }, head, () => {
      throw new Error('missing history');
    }),
    { build: true, release: false, paths: [], fallback: true }
  );
  for (const operation of ['profile', 'retry-pending-release'])
    assert.deepEqual(changeScope('workflow_dispatch', { inputs: { operation } }, head), {
      build: true,
      release: true,
      paths: [],
      fallback: false,
    });
});

test('validation runs changed tests directly, excludes full extension build tests and retains CI release regressions', async () => {
  const { validationTests } = await scope;
  const changed = 'test/integration/owned weird name.test.ts';
  const tests = validationTests([
    changed,
    'test/unit/optional-module-build.test.ts',
    'test/helpers/nativeFixture.ts',
  ]);
  assert.ok(tests.includes(changed));
  assert.ok(tests.includes('test/unit/pi-release.test.ts'));
  assert.ok(!tests.includes('test/unit/optional-module-build.test.ts'));
  assert.ok(!tests.includes('test/helpers/nativeFixture.ts'));
});

test('pi-quality remains required for every event while build, artifacts and automatic OIDC release are scoped', () => {
  const yaml = createRequire(resolve('package.json'))('js-yaml');
  const workflow = yaml.load(readFileSync('.github/workflows/pi.yml', 'utf8'));
  assert.equal(workflow.on.push.paths, undefined);
  assert.equal(workflow.on.pull_request.paths, undefined);
  const quality = workflow.jobs['pi-quality'];
  assert.equal(quality.if, undefined);
  for (const name of [
    'Non-clean build',
    'Unit',
    'Integration',
    'Real Pi',
    'VS Code extension host',
    'Host drift',
    'Package and inspect stable VSIX',
  ])
    assert.equal(
      quality.steps.find((step: any) => step.name === name).if,
      "steps.scope.outputs.build == 'true'"
    );
  assert.equal(
    quality.steps.find((step: any) => step.uses?.startsWith('actions/upload-artifact@')).if,
    "steps.scope.outputs.build == 'true'"
  );
  assert.ok(workflow.jobs.release.if.includes("needs.pi-quality.outputs.release == 'true'"));
});

test('real Git multi-commit rename/deletion classification and docs-only CLI avoid artifacts', async () => {
  const { changeScope } = await scope;
  const dir = mkdtempSync(join(tmpdir(), 'pi-ci-scope-'));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const git = (args: string[]) =>
    execFileSync(
      'git',
      [
        '-C',
        dir,
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'user.name=Owned Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        ...args,
      ],
      { encoding: 'utf8', env, stdio: 'pipe' }
    ).trimEnd();
  try {
    git(['init', '-b', 'main', '--object-format=sha1']);
    mkdirSync(join(dir, 'src'));
    mkdirSync(join(dir, 'docs'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '0.2.30' }));
    writeFileSync(join(dir, 'src/old.ts'), 'owned source');
    git(['add', '.']);
    git(['commit', '-m', 'owned baseline']);
    const start = git(['rev-parse', 'HEAD']);
    writeFileSync(join(dir, 'docs/note.md'), 'owned documentation');
    git(['add', '.']);
    git(['commit', '-m', 'owned docs']);
    const docsHead = git(['rev-parse', 'HEAD']);
    const event = join(dir, 'event.json'),
      output = join(dir, 'scope-output');
    writeFileSync(event, JSON.stringify({ before: start, after: docsHead }));
    execFileSync(process.execPath, [resolve('scripts/ci-change-scope.mjs')], {
      cwd: dir,
      env: { ...env, GITHUB_EVENT_NAME: 'push', GITHUB_EVENT_PATH: event, GITHUB_OUTPUT: output },
      stdio: 'pipe',
    });
    assert.equal(readFileSync(output, 'utf8'), 'build=false\nrelease=false\n');
    renameSync(join(dir, 'src/old.ts'), join(dir, 'docs/moved.ts'));
    git(['add', '-A']);
    git(['commit', '-m', 'owned rename']);
    const movedHead = git(['rev-parse', 'HEAD']);
    const moved = changeScope('push', { before: start, after: movedHead }, movedHead, git);
    assert.equal(moved.build, true);
    assert.ok(moved.paths.includes('src/old.ts'));
    assert.ok(moved.paths.includes('docs/moved.ts'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '0.2.31' }));
    git(['add', '.']);
    git(['commit', '-m', 'owned version']);
    const releasedHead = git(['rev-parse', 'HEAD']);
    assert.equal(
      changeScope('push', { before: start, after: releasedHead }, releasedHead, git).release,
      true
    );
    assert.deepEqual(
      changeScope('push', { before: 'f'.repeat(40), after: releasedHead }, releasedHead, git),
      { build: true, release: false, paths: [], fallback: true }
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('invalid event identity, unsafe manual operations and version rollback fail closed', async () => {
  const { changeScope } = await scope;
  assert.throws(() => changeScope('push', { before, after: base }, head), /Checkout/);
  assert.throws(
    () => changeScope('workflow_dispatch', { inputs: { operation: 'publish-anything' } }, head),
    /manual operation/
  );
  const git = (args: string[]) =>
    args[0] === 'diff'
      ? 'package.json\0'
      : args[0] === 'show'
        ? JSON.stringify({ version: args[1]!.startsWith(before) ? '0.2.30' : '0.2.29' })
        : '';
  assert.throws(() => changeScope('push', { before, after: head }, head, git), /rollback/);
});
