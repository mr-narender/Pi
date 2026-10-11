// Run: node --import tsx scripts/benchmark-history.mjs
// Synthetic files only; no user histories or SDK startup are measured.
import assert from 'node:assert/strict';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { createRequire } from 'node:module';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const { selectActiveBranchMessages } = require('../src/sessions/activeBranch.ts');
const { SessionIndexService } = require('../src/sessions/sessionIndexService.ts');
const root = await mkdtemp(join(tmpdir(), 'pi-history-benchmark-'));
const file = join(root, 'large.jsonl');
const small = join(root, 'small.jsonl');

// Pre-change controller parser: all records retained, then authoritative branch selection.
async function baseline(sessionFile, leaf) {
  const records = [];
  const input = createReadStream(sessionFile, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      /* partial record */
    }
  }
  return selectActiveBranchMessages(records, Number.POSITIVE_INFINITY, leaf);
}

async function measure(label, action, expected) {
  const samples = [];
  for (let i = 0; i < 3; i++) {
    const delay = monitorEventLoopDelay({ resolution: 1 });
    delay.enable();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const start = performance.now();
    const messages = await action();
    const ms = performance.now() - start;
    assert.equal(messages.length, expected);
    await new Promise((resolve) => setTimeout(resolve, 10));
    delay.disable();
    samples.push({ ms: +ms.toFixed(2), eventLoopMaxMs: +(delay.max / 1e6).toFixed(2) });
  }
  console.log(JSON.stringify({ label, samples }));
}

let index;
try {
  await mkdir(join(root, 'dist'));
  await build({
    entryPoints: ['src/workers/sessionIndexWorker.ts'],
    outfile: join(root, 'dist/sessionIndexWorker.js'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
  });
  const output = createWriteStream(file);
  for (let i = 0; i < 16000; i++) {
    const record =
      i % 20 === 0
        ? {
            type: 'message',
            id: String(i),
            parentId: i ? String(i - 1) : null,
            message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(2048) }] },
          }
        : { type: 'compaction', id: String(i), parentId: String(i - 1), summary: 'y'.repeat(6500) };
    if (!output.write(JSON.stringify(record) + '\n')) await once(output, 'drain');
  }
  output.end();
  await once(output, 'finish');
  await writeFile(
    small,
    JSON.stringify({
      type: 'message',
      id: 'small',
      parentId: null,
      message: { role: 'user', content: 'hello' },
    }) + '\n'
  );
  console.log(
    JSON.stringify({
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      largeMiB: +((await stat(file)).size / 1048576).toFixed(2),
      iterations: 3,
    })
  );
  await measure('before large (extension thread)', () => baseline(file, '15999'), 800);
  index = new SessionIndexService(root, { warn() {} });
  const start = performance.now();
  await index.readHistory(small, 'small');
  console.log(
    JSON.stringify({ workerStartupAndFirstSmallReadMs: +(performance.now() - start).toFixed(2) })
  );
  await measure(
    'after large (resident worker; too large to cache)',
    () => index.readHistory(file, '15999'),
    800
  );
  await measure('before repeat small (extension thread)', () => baseline(small, 'small'), 1);
  await measure(
    'after repeat small (validated worker cache)',
    () => index.readHistory(small, 'small'),
    1
  );
} finally {
  index?.dispose();
  await rm(root, { recursive: true, force: true });
}
