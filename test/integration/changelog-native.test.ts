import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import {
  createNativeFixture,
  spawnNativeSdkHost,
  resolveNativeCli,
} from '../helpers/nativeFixture';
import { spawnRealPi, shutdown } from '../helpers/rpc';

for (const mode of ['stock', 'shared', 'dedicated'] as const) {
  test(
    `changelog native ${mode}: actual selected public SDK version/content, zero provider calls`,
    { timeout: 30000 },
    async () => {
      const fixture = await createNativeFixture('scopes');
      let stock: Awaited<ReturnType<typeof spawnRealPi>> | undefined;
      let host: Awaited<ReturnType<typeof spawnNativeSdkHost>> | undefined;
      try {
        const selected = await resolveNativeCli();
        if (mode === 'stock') {
          stock = await spawnRealPi([], fixture);
          await stock.client.getState();
        } else {
          host = await spawnNativeSdkHost(fixture, mode);
          const opened = new Promise<any>((resolve) => {
            let buffer = '';
            host!.child.stdout!.on('data', (chunk) => {
              buffer += chunk;
              const i = buffer.indexOf('\n');
              if (i >= 0) resolve(JSON.parse(buffer.slice(0, i)).d);
            });
          });
          host.child.stdin!.write(JSON.stringify({ k: 'one', d: host.open }) + '\n');
          assert.equal((await opened).success, true);
        }
        const docs: any[] = [];
        const previews: any[] = [];
        const vscode = {
          window: { showInformationMessage: async () => 'Open Preview' },
          workspace: {
            openTextDocument: async (options: any) => {
              docs.push(options);
              return { uri: 'selected' };
            },
          },
          commands: {
            executeCommand: async (...args: any[]) => {
              previews.push(args);
            },
          },
        };
        const built = await build({
          entryPoints: ['src/commands/changelogCommand.ts'],
          bundle: true,
          write: false,
          platform: 'node',
          format: 'cjs',
          external: ['vscode'],
        });
        const mod = { exports: {} as any };
        new Function('require', 'module', 'exports', built.outputFiles[0]!.text)(
          (id: string) =>
            id === 'vscode' ? vscode : createRequire(`${process.cwd()}/package.json`)(id),
          mod,
          mod.exports
        );
        assert.equal(
          await mod.exports.changelogCommand({ sdkRoot: selected.root }, '', () => true),
          true
        );
        assert.equal(
          docs[0].content,
          `# Pi engine ${selected.version}\n\n${await readFile(join(selected.root, 'CHANGELOG.md'), 'utf8')}`
        );
        assert.deepEqual(previews, [['markdown.showPreview', 'selected']]);
        assert.equal(fixture.requests, 0);
        assert.equal((await readFile(fixture.networkLog, 'utf8')).trim(), '');
      } finally {
        if (stock) await shutdown(stock);
        if (host && host.child.exitCode === null && host.child.signalCode === null) {
          host.child.kill('SIGKILL');
          await new Promise((resolve) => host!.child.once('exit', resolve));
        }
        if (!stock) await fixture.dispose();
      }
    }
  );
}
