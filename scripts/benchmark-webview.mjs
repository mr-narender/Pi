import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Script } from 'node:vm';

const root = resolve(process.argv[2] || '.');
const source = await readFile(join(root, 'dist/chat.js'), 'utf8');
const samples = Array.from({ length: 15 }, (_, index) => {
  const start = performance.now();
  // Unique source prevents V8 from reusing its compilation cache between samples.
  new Script(`${source}\n// compile sample ${index}`);
  return performance.now() - start;
}).sort((a, b) => a - b);
const optionalBytes = {};
for (const name of ['mermaid.js', 'highlight.js', 'qrcode.js']) {
  try {
    optionalBytes[name] = (await stat(join(root, 'dist', name))).size;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}
console.log(
  JSON.stringify(
    {
      chatBytes: Buffer.byteLength(source),
      compileMedianMs: samples[7],
      samples: samples.length,
      optionalBytes,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      metric: 'Node V8 compilation proxy; not VS Code startup latency',
    },
    null,
    2
  )
);
