// Vendors the Pi coding agent into vendor/pi/ so the extension can run it with
// VS Code's own Node runtime (no external `pi` install). Copies dist +
// node_modules + package.json (the package.json's `type:module` is required for
// cli.js to run as ESM). Trims what a headless RPC launch never needs.
//
// Source resolution: PI_SRC env override -> global npm install. Run before
// packaging the VSIX.
import { cpSync, rmSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

const dest = 'vendor/pi';

function resolveSource() {
  if (process.env.PI_SRC && existsSync(process.env.PI_SRC)) {
    return process.env.PI_SRC;
  }
  try {
    const root = execSync('npm root -g', { encoding: 'utf8' }).trim();
    const p = join(root, '@earendil-works', 'pi-coding-agent');
    if (existsSync(p)) {
      return p;
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

const src = resolveSource();
if (!src) {
  console.error(
    '[vendor-pi] Pi source not found. Set PI_SRC=/path/to/pi-coding-agent, or\n' +
      '            `npm i -g @earendil-works/pi-coding-agent`.'
  );
  process.exit(1);
}

console.log(`[vendor-pi] source: ${src}`);
rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
cpSync(join(src, 'dist'), join(dest, 'dist'), { recursive: true });
cpSync(join(src, 'node_modules'), join(dest, 'node_modules'), { recursive: true });
cpSync(join(src, 'package.json'), join(dest, 'package.json'));

// Trim things a headless `--mode rpc` launch never needs (docs/examples of the
// package itself, and the OPTIONAL native clipboard which Pi degrades without).
const trim = [
  'node_modules/@mariozechner',
  'node_modules/@earendil-works/pi-coding-agent/docs',
  'node_modules/@earendil-works/pi-coding-agent/examples',
];
for (const rel of trim) {
  rmSync(join(dest, rel), { recursive: true, force: true });
}

function dirSizeMb(p) {
  try {
    return (execSync(`du -sm "${p}"`, { encoding: 'utf8' }).split('\t')[0] ?? '?').trim();
  } catch {
    return '?';
  }
}
const cli = join(dest, 'dist', 'cli.js');
if (!existsSync(cli) || !statSync(cli).isFile()) {
  console.error(`[vendor-pi] ERROR: ${cli} missing after copy`);
  process.exit(1);
}
console.log(`[vendor-pi] vendored -> ${dest} (${dirSizeMb(dest)} MB), cli: ${cli}`);
