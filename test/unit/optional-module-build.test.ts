import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

test('production build keeps optional engines out of initial chat and packages licensed local modules', async () => {
  execFileSync(process.execPath, ['scripts/build.mjs'], { stdio: 'pipe' });
  const chat = readFileSync('dist/chat.js', 'utf8');
  assert.ok(
    Buffer.byteLength(chat) < 500_000,
    'initial chat must not contain Mermaid or highlighter'
  );
  assert.doesNotMatch(chat, /node_modules\/(mermaid|highlight\.js)\//);
  for (const asset of ['mermaid.js', 'highlight.js', 'qrcode.js']) {
    assert.ok(statSync(`dist/${asset}`).size > 0);
  }
  const notices = readFileSync('dist/THIRD_PARTY_NOTICES.txt', 'utf8');
  for (const dependency of [
    'mermaid',
    'highlight.js',
    'qrcode',
    'cross-spawn',
    'which',
    'isexe',
    'path-key',
    'shebang-command',
    'shebang-regex',
  ]) {
    assert.match(notices, new RegExp(`\\n${dependency.replaceAll('.', '\\.')}@`));
  }
  for (const line of notices.split('\n').filter((line) => line.includes(' — '))) {
    for (const path of line.split(' — ').at(-1)!.split(', ')) {
      assert.ok(statSync(`dist/${path}`).size > 0, `missing distributed license ${path}`);
    }
  }
  const extension = readFileSync('dist/extension.js', 'utf8');
  assert.doesNotMatch(extension, /node_modules\/qrcode\//);
  const require = createRequire(resolve('package.json'));
  const qr = require(resolve('dist/qrcode.js')) as typeof import('qrcode');
  assert.match(await qr.toString('https://example.test/pair', { type: 'svg' }), /<svg/);
});

test('chat HTML authorizes only the entry script and gives lazy modules remote-safe versioned URIs', async () => {
  const result = await build({
    entryPoints: ['src/webview/html.ts'],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    external: ['vscode'],
  });
  const module = { exports: {} as { renderChatWebviewHtml: (...args: unknown[]) => string } };
  runInNewContext(result.outputFiles[0]!.text, {
    module,
    exports: module.exports,
    require: () => ({
      Uri: { joinPath: (uri: string, ...parts: string[]) => `${uri}/${parts.join('/')}` },
    }),
  });
  const html = module.exports.renderChatWebviewHtml(
    'remote-extension',
    {
      asWebviewUri: (uri: string) => `https://remote.webview.test/${uri}`,
      cspSource: 'https://remote.webview.test',
    },
    'Pi Chat',
    '0.2.28'
  );
  const dom = new JSDOM(html);
  const scripts = dom.window.document.querySelectorAll('script');
  assert.equal(scripts.length, 1, 'optional engines must not appear as eager script elements');
  assert.match(scripts[0]!.src, /chat\.js\?v=0\.2\.28$/);
  assert.match(scripts[0]!.dataset.mermaidSrc!, /mermaid\.js\?v=0\.2\.28$/);
  assert.match(scripts[0]!.dataset.highlightSrc!, /highlight\.js\?v=0\.2\.28$/);
  const csp = dom.window.document
    .querySelector('meta[http-equiv="Content-Security-Policy"]')!
    .getAttribute('content')!;
  assert.ok(csp.includes(`script-src 'nonce-${scripts[0]!.nonce}'`));
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|script-src https:/);
  assert.ok(csp.includes("connect-src 'none'"));
  dom.window.close();
});
