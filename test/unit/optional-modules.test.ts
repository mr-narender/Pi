import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

async function harness(entry = 'optionalModules.ts', attributes = true) {
  const result = await build({
    entryPoints: [`src/webview/media/${entry}`],
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    globalName: 'TestModule',
  });
  const dom = new JSDOM('<!doctype html><head></head><body></body>', {
    url: 'https://remote.webview.test/',
    runScripts: 'outside-only',
  });
  const script = dom.window.document.createElement('script');
  if (attributes) {
    script.nonce = 'trusted-nonce';
    script.dataset.mermaidSrc = 'https://remote.webview.test/assets/mermaid.js?v=0.2.28';
    script.dataset.highlightSrc = 'https://remote.webview.test/assets/highlight.js?v=0.2.28';
  }
  Object.defineProperty(dom.window.document, 'currentScript', { value: script });
  dom.window.eval(`${result.outputFiles[0]!.text}\nwindow.TestModule = TestModule;`);
  const module = (dom.window as unknown as Record<string, unknown>).TestModule as {
    optionalModule(name: 'Mermaid' | 'Highlight'): Promise<unknown>;
    highlightCode(
      code: string,
      language: string,
      escape: (value: string) => string
    ): { html: string };
  };
  return { dom, module };
}

test('optional engines request nothing at startup and share a nonce-authorized local request', async () => {
  const { dom, module } = await harness();
  const document = dom.window.document;
  assert.equal(document.querySelectorAll('script').length, 0);
  const first = module.optionalModule('Mermaid');
  const second = module.optionalModule('Mermaid');
  assert.equal(first, second);
  const scripts = document.querySelectorAll('script');
  assert.equal(scripts.length, 1);
  assert.equal(scripts[0]!.nonce, 'trusted-nonce');
  assert.equal(scripts[0]!.src, 'https://remote.webview.test/assets/mermaid.js?v=0.2.28');
  const engine = { default: { render: () => 'svg' } };
  (dom.window as unknown as Record<string, unknown>).PiMermaid = engine;
  scripts[0]!.dispatchEvent(new dom.window.Event('load'));
  assert.equal(await first, engine);
  assert.equal(await module.optionalModule('Mermaid'), engine);
  assert.equal(document.querySelectorAll('script').length, 1);
  dom.window.close();
});

test('failed optional requests are removable and retryable; absent nonce cannot load a script', async () => {
  const { dom, module } = await harness();
  const failed = module.optionalModule('Mermaid');
  const rejected = assert.rejects(failed, /Could not load Mermaid/);
  dom.window.document.querySelector('script')!.dispatchEvent(new dom.window.Event('error'));
  await rejected;
  assert.equal(dom.window.document.querySelectorAll('script').length, 0);
  const empty = module.optionalModule('Mermaid');
  const missingEngine = assert.rejects(empty, /Mermaid module did not initialize/);
  dom.window.document.querySelector('script')!.dispatchEvent(new dom.window.Event('load'));
  await missingEngine;
  assert.equal(dom.window.document.querySelectorAll('script').length, 0);
  const retry = module.optionalModule('Mermaid');
  (dom.window as unknown as Record<string, unknown>).PiMermaid = { default: {} };
  dom.window.document.querySelector('script')!.dispatchEvent(new dom.window.Event('load'));
  await retry;
  dom.window.close();
  const missing = await harness('optionalModules.ts', false);
  await assert.rejects(missing.module.optionalModule('Mermaid'), /Missing local Mermaid/);
  assert.equal(missing.dom.window.document.querySelectorAll('script').length, 0);
  missing.dom.window.close();
});

test('code remains escaped while highlighting loads, then enhances once without duplicate requests', async () => {
  const { dom, module } = await harness('lazyHighlight.ts');
  assert.equal(dom.window.document.querySelectorAll('script').length, 0);
  let enhanced = 0;
  dom.window.document.addEventListener('pi-highlight-ready', () => enhanced++);
  const escape = (code: string) => code.replaceAll('<', '&lt;');
  assert.equal(module.highlightCode('<tag>', 'xml', escape).html, '&lt;tag>');
  module.highlightCode('const a = 1', 'js', escape);
  const scripts = dom.window.document.querySelectorAll('script');
  assert.equal(scripts.length, 1);
  assert.match(scripts[0]!.src, /highlight\.js\?v=0\.2\.28$/);
  (dom.window as unknown as Record<string, unknown>).PiHighlight = {
    highlightCode: () => ({ html: '<span class="hljs-keyword">const</span>' }),
  };
  scripts[0]!.dispatchEvent(new dom.window.Event('load'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(enhanced, 1);
  assert.match(module.highlightCode('const', 'js', escape).html, /hljs-keyword/);
  assert.equal(dom.window.document.querySelectorAll('script').length, 1);
  dom.window.close();
});
