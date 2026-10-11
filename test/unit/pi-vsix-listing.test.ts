import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const inspection = import(pathToFileURL(resolve('scripts/inspect-vsix.mjs')).href);

test('actual ZIP inspection rejects appended final whitespace-only entries without hiding their bytes', async () => {
  const { inspectVsix, sha256 } = await inspection;
  const root = fs.mkdtempSync(join(tmpdir(), 'pi-vsix-listing-'));
  fs.mkdirSync(join(root, 'extension', 'dist'), { recursive: true });
  fs.mkdirSync(join(root, 'extension', 'host'));
  const version = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
  for (const [disk, archive] of [
    ['package.json', 'package.json'],
    ['README.md', 'readme.md'],
    ['NOTICE', 'NOTICE'],
    ['LICENSE', 'LICENSE.txt'],
    ['CHANGELOG.md', 'changelog.md'],
    ...fs
      .readdirSync('host')
      .filter((name) => name.endsWith('.mjs'))
      .map((name) => [`host/${name}`, `host/${name}`]),
  ])
    fs.copyFileSync(disk!, join(root, 'extension', archive!));
  const bundles: Record<string, string> = {};
  for (const name of [
    'extension.js',
    'sessionIndexWorker.js',
    'chat.js',
    'chatList.js',
    'mermaid.js',
    'highlight.js',
    'qrcode.js',
  ]) {
    const bytes = Buffer.from('owned bundle');
    fs.writeFileSync(join(root, 'extension', 'dist', name), bytes);
    bundles[`dist/${name}`] = sha256(bytes);
  }
  fs.writeFileSync(
    join(root, 'extension.vsixmanifest'),
    `<Identity Version="${version}" Publisher="mr-narender"/>`
  );
  const base = join(root, 'base.vsix');
  try {
    childProcess.execFileSync(
      'zip',
      ['-q', '-r', '-D', base, 'extension', 'extension.vsixmanifest'],
      { cwd: root, stdio: 'pipe' }
    );
    assert.equal(inspectVsix(base, process.cwd(), bundles).version, version);
    for (const name of ['mermaid.js', 'highlight.js', 'qrcode.js']) {
      const changed = join(root, `missing-${name}.vsix`);
      fs.copyFileSync(base, changed);
      childProcess.execFileSync('zip', ['-q', '-d', changed, `extension/dist/${name}`], {
        stdio: 'pipe',
      });
      const remaining = { ...bundles };
      delete remaining[`dist/${name}`];
      assert.throws(() => inspectVsix(changed, process.cwd(), remaining), /Missing bundle/);
    }
    for (const [index, name] of [' ', '   '].entries()) {
      const changed = join(root, `whitespace-${index}.vsix`);
      fs.copyFileSync(base, changed);
      fs.writeFileSync(join(root, name), 'unreviewed bytes');
      childProcess.execFileSync('zip', ['-q', changed, name], { cwd: root, stdio: 'pipe' });
      const listing = childProcess.execFileSync('unzip', ['-Z1', changed], {
        encoding: 'utf8',
        stdio: 'pipe',
      });
      assert.ok(listing.endsWith(`${name}\n`));
      assert.throws(
        () => inspectVsix(changed, process.cwd(), bundles),
        /Malformed VSIX entry listing/
      );
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const listing of [
  '',
  'extension/package.json',
  'extension/package.json\n\n',
  'extension/package.json\r\n',
  'extension/package.json\n \n',
])
  test(`inspection rejects malformed listing ${JSON.stringify(listing)} before extraction`, async () => {
    const { inspectVsix } = await inspection;
    let extracted = false;
    mock.method(childProcess, 'execFileSync', (_command: string, args: string[]) => {
      if (args[0] === '-Z1') return listing;
      extracted = true;
      return Buffer.from('{}');
    });
    syncBuiltinESMExports();
    try {
      assert.throws(
        () => inspectVsix('/owned/listing.vsix'),
        /(?:Malformed|Nonterminated) VSIX entry listing/
      );
      assert.equal(extracted, false);
    } finally {
      mock.restoreAll();
      syncBuiltinESMExports();
    }
  });
