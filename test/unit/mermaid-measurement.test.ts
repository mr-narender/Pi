import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { createInitialControllerState } from '../../src/state/types';
import { createWebviewSnapshot } from '../../src/webview/model';
import { createEmptyComposerState } from '../../src/webview/composer';

const bundle = build({
  entryPoints: ['src/webview/media/chat.ts'],
  bundle: true,
  platform: 'browser',
  format: 'iife',
  write: false,
});
const source =
  'flowchart TD\nA["Begin the calculation smoke test with representative input values"] --> B{"Are all inputs valid?"}';

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!check()) {
    assert.ok(Date.now() < deadline, 'webview did not reach the expected render state');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function frame(config: Record<string, unknown> = {}, fail = false) {
  const dom = new JSDOM(
    `<style>body {font-size:13px} ${readFileSync('src/webview/media/chat.css', 'utf8')}</style><div id="app"></div>`,
    { pretendToBeVisual: true, runScripts: 'outside-only', url: 'https://webview.test/' }
  );
  const w = dom.window;
  w.document.documentElement.style.setProperty('--vscode-font-family', 'system-ui, sans-serif');
  const calls: Array<{ source: string; container?: Element }> = [];
  const parsed: string[] = [];
  let initialized: Record<string, unknown> | undefined;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entry = w.document.createElement('script');
  entry.nonce = 'trusted-local-nonce';
  entry.dataset.mermaidSrc = 'https://webview.test/mermaid.js';
  Object.defineProperty(w.document, 'currentScript', { value: entry });
  Object.assign(w, {
    acquireVsCodeApi: () => ({ postMessage() {}, getState() {}, setState() {} }),
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    IntersectionObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    matchMedia: () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
    }),
    PiMermaid: {
      default: {
        initialize(value: Record<string, unknown>) {
          initialized = value;
        },
        async parse(value: string) {
          parsed.push(value);
          return { diagramType: 'flowchart', config };
        },
        async render(_id: string, value: string, container?: Element) {
          calls.push({ source: value, container });
          await gate;
          if (fail) throw new Error('Native Mermaid render failed');
          return { svg: '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120"></svg>' };
        },
      },
    },
  });
  new w.MutationObserver((mutations) => {
    for (const mutation of mutations)
      for (const node of mutation.addedNodes) {
        if (node instanceof w.HTMLScriptElement && node.src.endsWith('/mermaid.js'))
          node.dispatchEvent(new w.Event('load'));
      }
  }).observe(w.document.head, { childList: true });
  w.HTMLElement.prototype.scrollTo = () => {};
  w.HTMLElement.prototype.scrollIntoView = () => {};
  w.eval((await bundle).outputFiles[0]!.text);
  const snapshot = createWebviewSnapshot(createInitialControllerState('work', '/tmp/work'), 1, {
    composer: createEmptyComposerState(),
    isTrusted: true,
    folders: [],
  });
  snapshot.connectionState = 'ready';
  snapshot.focus = 'none';
  snapshot.messages = [
    { id: 'diagram', role: 'assistant', text: '```mermaid\n' + source + '\n```', attachments: [] },
  ];
  const send = () =>
    w.dispatchEvent(new w.MessageEvent('message', { data: { type: 'snapshot', snapshot } }));
  return { dom, w, calls, parsed, send, release, initialized: () => initialized };
}

test('Mermaid measures inside a connected explicit-font container and removes it after rendering', async () => {
  const f = await frame();
  try {
    assert.equal(f.w.document.querySelectorAll('script[src]').length, 0, 'engine stays lazy');
    f.send();
    await until(() => f.calls.length === 1);
    const container = f.calls[0]!.container as HTMLElement;
    assert.ok(container, 'render receives its own measurement container');
    assert.equal(container.isConnected, true);
    assert.equal(f.w.getComputedStyle(container).fontSize, '16px');
    assert.equal(f.w.getComputedStyle(container).fontFamily, 'system-ui, sans-serif');
    assert.equal(container.closest('[aria-hidden="true"]')?.getAttribute('aria-hidden'), 'true');
    assert.equal(f.calls[0]!.source, source);
    assert.deepEqual(f.parsed, [source]);
    assert.equal(f.initialized()?.securityLevel, 'strict');
    assert.equal(f.initialized()?.htmlLabels, false);
    f.release();
    await until(() => !!f.w.document.querySelector('.mermaid-image'));
    assert.equal(container.isConnected, false);
    assert.equal(f.w.document.querySelector('.mermaid-measurement'), null);
    f.send();
    await until(() => !!f.w.document.querySelector('.mermaid-image'));
    assert.equal(f.calls.length, 1, 'the same source retains its cached SVG');
  } finally {
    f.release();
    f.dom.window.close();
  }
});

test('parsed font overrides are measured without rewriting source and failed renders remove their container', async () => {
  const f = await frame({ themeVariables: { fontSize: '20px', fontFamily: 'monospace' } }, true);
  try {
    f.send();
    await until(() => f.calls.length === 1);
    const container = f.calls[0]!.container as HTMLElement;
    assert.ok(container);
    assert.equal(f.w.getComputedStyle(container).fontSize, '20px');
    assert.equal(f.w.getComputedStyle(container).fontFamily, 'monospace');
    assert.equal(f.calls[0]!.source, source);
    f.release();
    await until(() => f.w.document.querySelector<HTMLElement>('.mermaid-error')?.hidden === false);
    assert.equal(container.isConnected, false);
    assert.equal(f.w.document.querySelector('.mermaid-measurement'), null);
  } finally {
    f.release();
    f.dom.window.close();
  }
});

test('relative fonts use a 16px baseline and invalid unitless fonts keep the SVG fallback', async () => {
  for (const [fontSize, expected] of [
    [14, '16px'],
    ['1.25em', '1.25em'],
    ['125%', '125%'],
  ] as const) {
    const f = await frame({ themeVariables: { fontSize } });
    try {
      f.send();
      await until(() => f.calls.length === 1);
      const container = f.calls[0]!.container as HTMLElement;
      assert.ok(container);
      assert.equal(container.style.fontSize, expected);
      assert.equal(f.w.getComputedStyle(container.parentElement!).fontSize, '16px');
      f.release();
      await until(() => !!f.w.document.querySelector('.mermaid-image'));
      assert.equal(container.isConnected, false);
    } finally {
      f.release();
      f.dom.window.close();
    }
  }
});
