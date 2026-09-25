#!/usr/bin/env node
// Detect upstream drift: our host fork (host/pi-multi-host.mjs) is derived from
// Pi's rpc-mode. When Pi upgrades, this script flags the exact upstream
// functions we mirror so the fork can be re-synced deliberately.
// Usage: node scripts/check-host-drift.mjs   (exits 1 on drift)
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';

const require2 = (p) => path.join(process.cwd(), p);
const BASELINE = require2('scripts/host-drift-baseline.json');

function upstreamRpcModePath() {
  try {
    const root = execSync('npm root -g', { encoding: 'utf8' }).trim();
    const candidate = path.join(root, '@earendil-works/pi-coding-agent/dist/modes/rpc/rpc-mode.js');
    if (existsSync(candidate)) return candidate;
  } catch {
    /* fall through */
  }
  const vendored = require2('vendor/pi/dist/modes/rpc/rpc-mode.js');
  return existsSync(vendored) ? vendored : undefined;
}

const source = upstreamRpcModePath();
if (!source) {
  console.log('drift-check: no upstream rpc-mode.js found (global pi or vendor/) — skipping');
  process.exit(0);
}
const hash = createHash('sha256').update(readFileSync(source)).digest('hex').slice(0, 16);

if (process.argv.includes('--update')) {
  writeFileSync(
    BASELINE,
    JSON.stringify(
      { source: path.basename(source), hash, updated: new Date().toISOString() },
      null,
      2
    ) + '\n'
  );
  console.log(`drift-check: baseline updated → ${hash}`);
  process.exit(0);
}
if (!existsSync(BASELINE)) {
  console.log('drift-check: no baseline yet — run with --update after verifying the host fork');
  process.exit(0);
}
const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'));
if (baseline.hash !== hash) {
  console.error(`DRIFT: upstream rpc-mode changed (${baseline.hash} → ${hash}).`);
  console.error('Re-sync host/pi-multi-host.mjs against the new rpc-mode, then run:');
  console.error('  node scripts/check-host-drift.mjs --update');
  process.exit(1);
}
console.log(`drift-check: in sync (${hash})`);
