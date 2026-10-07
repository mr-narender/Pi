import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

test('selected SDK dependencies resolve from nested, hoisted and pnpm installs', async () => {
  const { resolveSdkDependencyFile } = await import(
    pathToFileURL(resolve('host/startup-adapter.mjs')).href
  );
  const root = await mkdtemp(join(tmpdir(), 'pi-sdk-resolution-'));
  try {
    const dependency = '@earendil-works/pi-ai/dist/models.js';
    const nestedSdk = join(root, 'nested/node_modules/@earendil-works/pi-coding-agent');
    const nestedDependency = join(nestedSdk, 'node_modules', dependency);
    const hoistedSdk = join(root, 'hoisted/node_modules/@earendil-works/pi-coding-agent');
    const hoistedDependency = join(root, 'hoisted/node_modules', dependency);
    const pnpmRoot = join(root, 'pnpm/node_modules/.pnpm/pi-agent@1/node_modules');
    const pnpmSdk = join(pnpmRoot, '@earendil-works/pi-coding-agent');
    const pnpmPackage = join(
      root,
      'pnpm/node_modules/.pnpm/pi-ai@1/node_modules/@earendil-works/pi-ai'
    );
    const pnpmDependency = join(pnpmRoot, dependency);
    for (const file of [nestedDependency, hoistedDependency]) {
      await mkdir(resolve(file, '..'), { recursive: true });
      await writeFile(file, 'export {};\n');
    }
    await mkdir(pnpmSdk, { recursive: true });
    await mkdir(join(pnpmPackage, 'dist'), { recursive: true });
    await writeFile(join(pnpmPackage, 'dist/models.js'), 'export {};\n');
    await symlink(
      pnpmPackage,
      join(pnpmRoot, '@earendil-works/pi-ai'),
      process.platform === 'win32' ? 'junction' : 'dir'
    );

    assert.equal(resolveSdkDependencyFile(nestedSdk, dependency), nestedDependency);
    assert.equal(resolveSdkDependencyFile(hoistedSdk, dependency), hoistedDependency);
    assert.equal(resolveSdkDependencyFile(pnpmSdk, dependency), pnpmDependency);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
