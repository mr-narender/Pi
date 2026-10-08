import { mkdir, copyFile, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
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

const chatBuild = await build({
  entryPoints: ['src/webview/media/chat.ts'],
  outfile: 'dist/chat.js',
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  define,
  sourcemap: false,
  legalComments: 'external',
  metafile: true,
});

const packageRoots = new Set(
  Object.keys(chatBuild.metafile.inputs).flatMap((input) => {
    if (!input.startsWith('node_modules/')) return [];
    const parts = input.slice('node_modules/'.length).split('/');
    return [`node_modules/${parts[0].startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]}`];
  })
);
await mkdir('dist/licenses', { recursive: true });
const notices = ['Bundled webview dependencies and their exact distributed license files:', ''];
for (const root of [...packageRoots].sort()) {
  const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const licenseFiles = [];
  for (const name of await readdir(root)) {
    const path = join(root, name);
    if (/^(license|licence|copying|notice)(\.|$)/i.test(name) && (await stat(path)).isFile()) {
      licenseFiles.push({ name, path });
    }
  }
  if (licenseFiles.length === 0) {
    throw new Error(`Bundled dependency has no distributed license file: ${metadata.name}`);
  }
  const prefix = String(metadata.name).replaceAll('@', '').replaceAll('/', '--');
  const shipped = [];
  for (const license of licenseFiles) {
    const destination = `${prefix}--${license.name}`;
    await copyFile(license.path, join('dist/licenses', destination));
    shipped.push(`licenses/${destination}`);
  }
  notices.push(
    `${metadata.name}@${metadata.version} — ${String(metadata.license || 'see license file')} — ${shipped.join(', ')}`
  );
}
await writeFile('dist/THIRD_PARTY_NOTICES.txt', `${notices.join('\n')}\n`);

// Agentic Mode's chat list — its own small bundle, not the chat.ts runtime.
await build({
  entryPoints: ['src/webview/media/chatList.ts'],
  outfile: 'dist/chatList.js',
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
