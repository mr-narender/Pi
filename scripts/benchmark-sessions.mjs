// Run: node --import tsx scripts/benchmark-sessions.mjs [--source-root /path/to/baseline] [--files 700]
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
const sourceFlag = process.argv.indexOf('--source-root');
const sourceRoot = sourceFlag < 0 ? process.cwd() : resolve(process.argv[sourceFlag + 1]);
const filesFlag = process.argv.indexOf('--files');
const fileCount = filesFlag < 0 ? 160 : Number(process.argv[filesFlag + 1]);
if (!Number.isInteger(fileCount) || fileCount < 1)
  throw new Error('--files requires a positive integer');
const module = await import(
  pathToFileURL(resolve(sourceRoot, 'src/sessions/recentSessions.ts')).href
);
const { readRecentSessionsIndex } = module.default ?? module;
const fs = createRequire(import.meta.url)('node:fs');
const original = fs.createReadStream;
let reads = 0;
fs.createReadStream = (...args) => {
  reads++;
  return original(...args);
};
const scratch = join(tmpdir(), 'pi-extension');
await mkdir(scratch, { recursive: true });
const root = await mkdtemp(join(scratch, 'list-benchmark-'));
const sessionDir = `${root}/sessions`;
try {
  await mkdir(sessionDir);
  const entries = [
    { type: 'session', id: 'session', cwd: root },
    { type: 'message', message: { role: 'user', content: 'Synthetic benchmark prompt' } },
    ...Array.from({ length: 810 }, (_, index) => ({
      type: 'message',
      message: { role: 'assistant', content: `Synthetic ${index} ${'x'.repeat(400)}` },
    })),
  ];
  for (let index = 0; index < fileCount; index++) {
    entries[0] = { type: 'session', id: `s${index}`, cwd: root };
    await writeFile(
      `${sessionDir}/${index}.jsonl`,
      entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n'
    );
  }
  for (let iteration = 0; iteration < 3; iteration++) {
    const before = reads;
    const start = performance.now();
    const result = await readRecentSessionsIndex({
      workspaceName: 'benchmark',
      workspacePath: root,
      additionalArgs: ['--session-dir', sessionDir],
    });
    console.log(
      JSON.stringify({
        iteration,
        files: result.sessions.length,
        ms: Number((performance.now() - start).toFixed(2)),
        reads: reads - before,
      })
    );
  }
} finally {
  fs.createReadStream = original;
  await rm(root, { recursive: true, force: true });
}
