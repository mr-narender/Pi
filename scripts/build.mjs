import { mkdir, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { build } from 'esbuild';

await mkdir('dist', { recursive: true });

await build({
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['vscode'],
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
