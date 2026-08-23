import { mkdir, copyFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { build } from 'esbuild';

await mkdir('dist', { recursive: true });

const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const define = { __PI_BUILD__: JSON.stringify(String(pkg.version)) };

await build({
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['vscode'],
  define,
  sourcemap: false,
  legalComments: 'none',
});

// Off-main-thread session index/search worker (worker_threads, no vscode dep).
await build({
  entryPoints: ['src/workers/sessionIndexWorker.ts'],
  outfile: 'dist/sessionIndexWorker.js',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  define,
  sourcemap: false,
  legalComments: 'none',
});

await build({
  entryPoints: ['src/webview/media/chat.ts'],
  outfile: 'dist/chat.js',
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  define,
  sourcemap: false,
  legalComments: 'none',
});

if (existsSync('src/webview/media/chat.css')) {
  await copyFile('src/webview/media/chat.css', 'dist/chat.css');
}
if (existsSync('media/icon.svg')) {
  await mkdir('dist/media', { recursive: true });
  await copyFile('media/icon.svg', 'dist/media/icon.svg');
}
if (existsSync('media/icon.png')) {
  await copyFile('media/icon.png', 'dist/media/icon.png');
}
