import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const module = import(pathToFileURL(resolve('scripts/release-version.mjs')).href);
const head = 'a'.repeat(40),
  previous = 'b'.repeat(40),
  later = 'c'.repeat(40);
function ledger(tags: Record<string, string>, version = '0.2.40', descendant = true) {
  return (args: string[]) => {
    if (args[0] === 'tag') return Object.keys(tags).join('\n');
    if (args[0] === 'rev-parse') return tags[args[1]!.replace(/\^\{commit\}$/, '')];
    if (args[0] === 'show') return JSON.stringify({ version });
    if (args[0] === 'merge-base') {
      if (!descendant && args[2] !== head) throw new Error('not ancestor');
      return '';
    }
    throw new Error(`Unexpected git command ${args[0]}`);
  };
}

test('automatic versions use numeric stable tags, preserve explicit floors and reserve draft versions', async () => {
  const { planRelease } = await module;
  const tags = { 'v0.2.9': previous, 'v0.2.40': previous, 'v1.0.0-beta': later };
  assert.equal(planRelease(head, ledger(tags)).version, '0.2.41');
  assert.equal(planRelease(head, ledger(tags, '0.3.0')).version, '0.3.0');
  assert.equal(planRelease(head, ledger(tags, '0.2.1')).previous, '0.2.40');
  const retry = planRelease(head, ledger({ 'v0.2.39': previous, 'v0.2.41': head }));
  assert.equal(retry.version, '0.2.41');
  assert.equal(retry.existing, true);
  assert.equal(retry.previous, '0.2.39');
  assert.throws(() => planRelease(head, ledger({})), /baseline unavailable/);
});

test('superseded queued runs skip and manual retry selects reserved ancestor rather than allocating again', async () => {
  const { planRelease } = await module;
  assert.equal(planRelease(head, ledger({ 'v0.2.41': later }, '0.2.40', false)).release, false);
  const retry = planRelease(
    head,
    ledger({ 'v0.2.39': previous, 'v0.2.41': previous }),
    'retry-pending-release'
  );
  assert.equal(retry.version, '0.2.41');
  assert.equal(retry.source, previous);
  assert.equal(retry.existing, true);
  const unrelated = (args: string[]) => {
    if (args[0] === 'merge-base') throw new Error('unrelated ancestry');
    return ledger({ 'v0.2.41': later })(args);
  };
  assert.throws(() => planRelease(head, unrelated), /unrelated/);
});

test('manual current-main release allocates the next version for unreserved source', async () => {
  const { planRelease } = await module;
  const git = ledger({ 'v0.2.42': previous, 'v0.2.43': later });
  assert.deepEqual(planRelease(head, git, 'release-current'), {
    release: true,
    version: '0.2.44',
    previous: '0.2.43',
    existing: false,
    source: head,
  });
  assert.equal(planRelease(head, git, 'retry-pending-release').source, later);
});

test('generated metadata is deterministic, preserves source and rejects unrelated or tampered edits', async () => {
  const { stampReleaseVersion } = await module;
  const root = mkdtempSync(join(tmpdir(), 'pi-version-stamp-'));
  const git = (args: string[]) =>
    execFileSync(
      'git',
      [
        '-C',
        root,
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        ...args,
      ],
      {
        encoding: 'utf8',
        stdio: 'pipe',
        env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
      }
    );
  try {
    git(['init', '-b', 'main']);
    const pkg = { name: 'owned', version: '0.2.40', description: 'unchanged' };
    const lock = {
      version: pkg.version,
      packages: { '': { version: pkg.version }, 'node_modules/owned': { version: '1.0.0' } },
    };
    writeFileSync(join(root, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
    writeFileSync(join(root, 'package-lock.json'), JSON.stringify(lock, null, 2) + '\n');
    writeFileSync(join(root, 'CHANGELOG.md'), '# Changelog\n\n## 0.2.40\n\n- Existing entry.\n');
    writeFileSync(join(root, 'source.ts'), 'owned source\n');
    git(['add', '.']);
    git(['commit', '-m', 'owned baseline']);
    stampReleaseVersion('0.2.41', root);
    assert.equal(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version, '0.2.41');
    const generatedLock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
    assert.equal(generatedLock.packages[''].version, '0.2.41');
    assert.equal(generatedLock.packages['node_modules/owned'].version, '1.0.0');
    const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
    stampReleaseVersion('0.2.41', root);
    assert.equal(readFileSync(join(root, 'CHANGELOG.md'), 'utf8'), changelog);
    assert.equal(readFileSync(join(root, 'source.ts'), 'utf8'), 'owned source\n');
    writeFileSync(join(root, 'source.ts'), 'unexpected');
    assert.throws(() => stampReleaseVersion('0.2.41', root), /source is dirty/);
    writeFileSync(join(root, 'source.ts'), 'owned source\n');
    writeFileSync(join(root, 'unexpected.ts'), 'untracked source');
    assert.throws(() => stampReleaseVersion('0.2.41', root), /Untracked release source/);
    rmSync(join(root, 'unexpected.ts'));
    writeFileSync(join(root, 'package-lock.json'), JSON.stringify({ ...lock, version: '9.0.0' }));
    assert.throws(() => stampReleaseVersion('0.2.41', root), /Unexpected metadata edit/);
    writeFileSync(join(root, 'package-lock.json'), JSON.stringify(generatedLock, null, 2) + '\n');
    writeFileSync(join(root, 'package.json'), JSON.stringify({ ...pkg, description: 'tampered' }));
    assert.throws(() => stampReleaseVersion('0.2.41', root), /Unexpected metadata edit/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('release stamping consumes Unreleased notes without rewriting historical releases', async () => {
  const { stampReleaseVersion } = await module;
  const root = mkdtempSync(join(tmpdir(), 'pi-version-notes-'));
  const history = '## 0.2.40\n\n- Existing release entry.\n';
  const notes = '- New inline prompts and durable Outbox fixes.\n\n';
  const originals: Record<string, string> = {
    'package.json': JSON.stringify({ version: '0.2.40' }) + '\n',
    'package-lock.json':
      JSON.stringify({ version: '0.2.40', packages: { '': { version: '0.2.40' } } }) + '\n',
    'CHANGELOG.md': `# Changelog\n\n## Unreleased\n\n${notes}${history}`,
  };
  const git = (args: string[]) => {
    if (args[0] === 'rev-parse') return head;
    if (args[0] === 'show') return originals[args[1]!.slice('HEAD:'.length)];
    if (args[0] === 'diff' || args[0] === 'ls-files') return '';
    throw new Error(`Unexpected git command ${args[0]}`);
  };
  try {
    for (const [name, content] of Object.entries(originals))
      writeFileSync(join(root, name), content);
    stampReleaseVersion('0.2.41', root, git);
    const expected = `# Changelog\n\n## 0.2.41\n\n${notes}${history}`;
    assert.equal(readFileSync(join(root, 'CHANGELOG.md'), 'utf8'), expected);
    stampReleaseVersion('0.2.41', root, git);
    assert.equal(readFileSync(join(root, 'CHANGELOG.md'), 'utf8'), expected);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
