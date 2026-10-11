import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// Subprocesses need runtime/proxy settings, never the parent's release or Actions credentials.
export function subprocessEnvironment(env = process.env) {
  return Object.fromEntries(
    [
      'PATH',
      'HOME',
      'TMPDIR',
      'TMP',
      'TEMP',
      'SystemRoot',
      'WINDIR',
      'LANG',
      'LC_ALL',
      'LC_CTYPE',
      'TZ',
      'HTTP_PROXY',
      'HTTPS_PROXY',
      'NO_PROXY',
      'http_proxy',
      'https_proxy',
      'no_proxy',
    ]
      .filter((name) => typeof env[name] === 'string')
      .map((name) => [name, env[name]])
  );
}

export function inspectVsix(file, root = process.cwd(), verifiedBundles, env = process.env) {
  const childEnv = subprocessEnvironment(env);
  const source = (name) => readFileSync(resolve(root, name));
  const listing = execFileSync('unzip', ['-Z1', file], {
    encoding: 'utf8',
    env: childEnv,
    stdio: 'pipe',
  });
  assert.ok(listing.endsWith('\n'), 'Nonterminated VSIX entry listing');
  const entries = listing.slice(0, -1).split('\n');
  assert.ok(
    entries.every((name) => /\S/.test(name) && !/[\r\0]/.test(name)),
    'Malformed VSIX entry listing'
  );
  assert.equal(new Set(entries).size, entries.length, 'Duplicate VSIX entries');
  for (const name of entries)
    assert.ok(
      !name.startsWith('/') && !name.includes('..') && !name.includes('\\'),
      'Unsafe VSIX path'
    );
  const read = (name) =>
    execFileSync('unzip', ['-p', file, name], {
      maxBuffer: 32 * 1024 * 1024,
      env: childEnv,
      stdio: 'pipe',
    });
  const pkg = JSON.parse(read('extension/package.json'));
  assert.equal(pkg.publisher, 'mr-narender');
  assert.equal(pkg.name, 'pi');
  assert.match(pkg.version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  assert.deepEqual(read('extension/package.json'), source('package.json'));
  const manifest = read('extension.vsixmanifest').toString();
  for (const property of manifest.match(/<Property\b[^>]*>/gi) ?? [])
    if (/\bId=["']Microsoft\.VisualStudio\.Code\.PreRelease["']/i.test(property))
      assert.ok(!/\bValue=["']true["']/i.test(property), 'Prerelease VSIX');
  assert.ok(manifest.includes(`Version="${pkg.version}"`));
  assert.ok(manifest.includes('Publisher="mr-narender"'));
  for (const [archive, disk] of [
    ['readme.md', 'README.md'],
    ['NOTICE', 'NOTICE'],
    ['LICENSE.txt', 'LICENSE'],
    ['package.json', 'package.json'],
    ...readdirSync(resolve(root, 'host'))
      .filter((name) => name.endsWith('.mjs'))
      .map((name) => [`host/${name}`, `host/${name}`]),
  ])
    assert.deepEqual(read(`extension/${archive}`), source(disk), `VSIX source mismatch: ${disk}`);
  const bundles =
    verifiedBundles ??
    Object.fromEntries(
      entries
        .filter((name) => name.startsWith('extension/dist/'))
        .map((name) => {
          const file = name.slice('extension/'.length);
          return [file, sha256(source(file))];
        })
    );
  for (const [name, digest] of Object.entries(bundles)) {
    assert.match(name, /^dist\/[\w/.-]+$/);
    assert.match(digest, /^[a-f0-9]{64}$/);
    assert.equal(sha256(read(`extension/${name}`)), digest, `VSIX bundle mismatch: ${name}`);
  }
  for (const name of [
    'extension.js',
    'sessionIndexWorker.js',
    'chat.js',
    'chatList.js',
    'mermaid.js',
    'highlight.js',
    'qrcode.js',
  ])
    assert.ok(
      entries.includes(`extension/dist/${name}`) && bundles[`dist/${name}`],
      `Missing bundle ${name}`
    );
  for (const name of entries)
    assert.ok(
      !/^extension\/(?:src|test|vendor|node_modules|\.github|scripts|docs|graphify-out)\//.test(
        name
      ),
      'Development files in VSIX'
    );
  const aliases = { 'readme.md': 'README.md', 'LICENSE.txt': 'LICENSE' };
  for (const name of entries.filter((entry) => entry.startsWith('extension/'))) {
    const file = name.slice('extension/'.length);
    if (file === 'changelog.md' || file.startsWith('dist/')) continue;
    assert.deepEqual(read(name), source(aliases[file] ?? file), `VSIX source mismatch: ${file}`);
  }
  assert.ok(read('extension/changelog.md').toString().includes(`## ${pkg.version}`));
  return {
    schema: 1,
    repository: 'mr-narender/Pi',
    commit: execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      env: childEnv,
      stdio: 'pipe',
    }).trim(),
    publisher: pkg.publisher,
    name: pkg.name,
    version: pkg.version,
    channel: 'stable',
    file: 'pi.vsix',
    sha256: sha256(readFileSync(file)),
    bundles,
  };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const receipt = inspectVsix(resolve(process.argv[2]));
  if (process.argv[3]) writeFileSync(process.argv[3], JSON.stringify(receipt, null, 2) + '\n');
  console.log(`Inspected stable mr-narender.pi ${receipt.version}: ${receipt.sha256}`);
}
