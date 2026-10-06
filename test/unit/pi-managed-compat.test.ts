import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function loadManaged(autoInstall: boolean) {
  const built = await build({
    stdin: {
      contents: "export { ensureManagedPi } from './src/process/piManaged';",
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    external: ['vscode'],
  });
  const mod = { exports: {} as any };
  new Function('require', 'module', 'exports', built.outputFiles[0]!.text)(
    (name: string) => {
      if (name === 'vscode')
        return {
          workspace: { getConfiguration: () => ({ get: () => autoInstall }) },
          window: {},
        };
      return createRequire(`${process.cwd()}/package.json`)(name);
    },
    mod,
    mod.exports
  );
  return mod.exports.ensureManagedPi as (...args: any[]) => Promise<string | undefined>;
}

function writeManaged(storage: string, location: 'pi' | 'pi/staging', version: string) {
  const root = join(
    storage,
    ...location.split('/'),
    'node_modules',
    '@earendil-works',
    'pi-coding-agent'
  );
  mkdirSync(join(root, 'dist'), { recursive: true });
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      name: '@earendil-works/pi-coding-agent',
      version,
      bin: { pi: 'dist/cli.js' },
    })
  );
  writeFileSync(join(root, 'dist', 'cli.js'), '');
  return root;
}

test('managed Pi rejects an installed SDK outside the audited host contract', async () => {
  const storage = mkdtempSync(join(tmpdir(), 'pi-managed-compat-'));
  writeManaged(storage, 'pi', '0.84.2');
  try {
    const ensureManagedPi = await loadManaged(false);
    const warnings: string[] = [];
    const result = await ensureManagedPi(
      { globalStorageUri: { fsPath: storage } },
      { info() {}, warn: (message: string) => warnings.push(message), error() {} }
    );
    assert.equal(result, undefined);
    assert.match(
      warnings.join('\n'),
      /Managed Pi 0\.84\.2 is unsupported and will not be launched/
    );
  } finally {
    rmSync(storage, { recursive: true, force: true });
  }
});

test('auto-install off never applies an already staged managed update', async () => {
  const storage = mkdtempSync(join(tmpdir(), 'pi-managed-consent-'));
  const live = writeManaged(storage, 'pi', '1.0.0');
  writeManaged(storage, 'pi/staging', '1.0.4');
  try {
    const ensureManagedPi = await loadManaged(false);
    const cli = await ensureManagedPi(
      { globalStorageUri: { fsPath: storage } },
      { info() {}, warn() {}, error() {} }
    );
    assert.equal(cli, join(live, 'dist', 'cli.js'));
    assert.equal(JSON.parse(readFileSync(join(live, 'package.json'), 'utf8')).version, '1.0.0');
    assert.equal(
      JSON.parse(
        String(
          readFileSync(
            join(storage, 'pi/staging/node_modules/@earendil-works/pi-coding-agent/package.json'),
            'utf8'
          )
        )
      ).version,
      '1.0.4'
    );
  } finally {
    rmSync(storage, { recursive: true, force: true });
  }
});
