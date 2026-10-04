import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import type { WebviewSnapshot } from '../../src/state/types';

const dom = new JSDOM('<!doctype html><div id="app"></div>', {
  pretendToBeVisual: true,
  url: 'https://webview.test/',
});
const listeners = new Set<() => void>();
const media = {
  matches: false,
  addEventListener: (_: string, fn: () => void) => listeners.add(fn),
  removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
};
const timers = new Map<number, () => void>();
let nextTimer = 0;
const originalSet = globalThis.setInterval;
const originalClear = globalThis.clearInterval;
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  Node: dom.window.Node,
  Event: dom.window.Event,
  HTMLElement: dom.window.HTMLElement,
  HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
  MutationObserver: dom.window.MutationObserver,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  requestAnimationFrame: () => 0,
  ResizeObserver: class {
    observe() {}
    disconnect() {}
  },
  IntersectionObserver: class {
    observe() {}
    disconnect() {}
  },
  matchMedia: () => media,
  acquireVsCodeApi: () => ({ postMessage() {}, getState() {}, setState() {} }),
  setInterval: (fn: () => void) => {
    timers.set(++nextTimer, fn);
    return nextTimer;
  },
  clearInterval: (id: number) => timers.delete(id),
});
Object.assign(dom.window, { matchMedia: () => media });
Object.assign(dom.window.HTMLElement.prototype, { scrollTo() {}, scrollIntoView() {} });
function render(overrides: Partial<WebviewSnapshot> = {}) {
  const snapshot: WebviewSnapshot = {
    sequence: 1,
    title: 'Chat',
    bindingState: 'current',
    connectionState: 'busy',
    workspaceFolderName: 'workspace',
    isStreaming: false,
    isCompacting: false,
    messages: [],
    queue: { steering: [], followUp: [] },
    draft: '',
    statuses: {},
    widgets: [],
    thinkingLevel: 'off',
    pendingContextItems: [],
    pendingImages: [],
    focus: 'none',
    isTrusted: true,
    folders: [],
    typewriterSpeed: 'off',
    surface: 'sidebar',
    ...overrides,
  };
  dom.window.dispatchEvent(
    new dom.window.MessageEvent('message', { data: { type: 'snapshot', snapshot } })
  );
}
function preference(reduce: boolean) {
  media.matches = reduce;
  for (const listener of listeners) listener();
}
test.after(() => {
  dom.window.dispatchEvent(new dom.window.Event('beforeunload'));
  globalThis.setInterval = originalSet;
  globalThis.clearInterval = originalClear;
  dom.window.close();
});
test('live frame-family switches paint the new choice without accumulating timers on either surface', async () => {
  await import('../../src/webview/media/chat.js');
  try {
    for (const surface of ['tab', 'sidebar'] as const) {
      render({ workingAnimation: 'braille', surface });
      await new Promise((resolve) => setTimeout(resolve, 180));
      assert.equal(timers.size, 1);
      for (const [workingAnimation, glyphPattern] of [
        ['earth', /^[🌍🌎🌏]$/u],
        ['moon', /^[🌑🌒🌓🌔🌕🌖🌗🌘]$/u],
        ['braille', /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]$/],
      ] as const) {
        render({ workingAnimation, surface });
        await new Promise((resolve) => setTimeout(resolve, 180));
        assert.equal(timers.size, 1, 'live choice changes must never accumulate intervals');
        for (const tick of timers.values()) tick();
        assert.match(
          dom.window.document.querySelector('.working-glyph')?.textContent ?? '',
          glyphPattern,
          `${workingAnimation}/${surface}: a live tick paints the current frame family`
        );
      }
      render({ connectionState: 'ready', surface });
      assert.equal(timers.size, 0);
    }
  } finally {
    render({ connectionState: 'ready' });
  }
});
test('live switches to CSS dots/bars/dolphin stop frame timers and switching back starts exactly one', async () => {
  await import('../../src/webview/media/chat.js');
  for (const surface of ['tab', 'sidebar'] as const) {
    for (const [workingAnimation, glyph] of [
      ['dots', ''],
      ['bars', ''],
      ['dolphin', '🐬'],
    ] as const) {
      render({ workingAnimation: 'earth', surface });
      await new Promise((resolve) => setTimeout(resolve, 180));
      assert.equal(timers.size, 1);
      render({ workingAnimation, surface });
      await new Promise((resolve) => setTimeout(resolve, 180));
      assert.equal(timers.size, 0, `${workingAnimation}/${surface}: CSS owns the animation`);
      assert.equal(dom.window.document.querySelector('.working-glyph')?.textContent, glyph);
      render({ workingAnimation: 'earth', surface });
      await new Promise((resolve) => setTimeout(resolve, 180));
      assert.equal(timers.size, 1);
      for (const tick of timers.values()) tick();
      assert.match(
        dom.window.document.querySelector('.working-glyph')?.textContent ?? '',
        /^[🌍🌎🌏]$/u
      );
      render({ connectionState: 'ready', surface });
      assert.equal(timers.size, 0);
    }
  }
});
test('all six working choices honor timer ownership, reduced motion and idle/disposal on both surfaces', async () => {
  await import('../../src/webview/media/chat.js');
  for (const [workingAnimation, intervalCount, glyphPattern] of [
    ['braille', 1, /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]$/],
    ['earth', 1, /^[🌍🌎🌏]$/u],
    ['moon', 1, /^[🌑🌒🌓🌔🌕🌖🌗🌘]$/u],
    ['dots', 0, /^$/],
    ['bars', 0, /^$/],
    ['dolphin', 0, /^🐬$/u],
  ] as const) {
    for (const surface of ['tab', 'sidebar'] as const) {
      render({ workingAnimation, surface });
      await new Promise((resolve) => setTimeout(resolve, 180));
      assert.equal(
        timers.size,
        intervalCount,
        `${workingAnimation}/${surface}: owns only its expected timer`
      );
      assert.equal(
        dom.window.document.querySelector('.working')?.getAttribute('data-anim'),
        workingAnimation
      );
      assert.match(
        dom.window.document.querySelector('.working-glyph')?.textContent ?? '',
        glyphPattern
      );
      for (const tick of timers.values()) tick();
      assert.match(
        dom.window.document.querySelector('.working-glyph')?.textContent ?? '',
        glyphPattern
      );
      render({ workingAnimation, surface });
      assert.equal(timers.size, intervalCount);
      preference(true);
      assert.equal(timers.size, 0);
      const glyph = dom.window.document.querySelector('.working-glyph')?.textContent;
      render({ workingAnimation, surface });
      assert.equal(timers.size, 0);
      assert.equal(dom.window.document.querySelector('.working-glyph')?.textContent, glyph);
      preference(false);
      assert.equal(timers.size, intervalCount);
      render({ connectionState: 'faulted', isStreaming: true });
      assert.equal(timers.size, 0);
      assert.equal(dom.window.document.querySelector('.working-logo'), null);
    }
  }
  render();
  await new Promise((resolve) => setTimeout(resolve, 180));
  assert.equal(timers.size, 1);
  dom.window.dispatchEvent(new dom.window.Event('beforeunload'));
  assert.equal(timers.size, 0);
  assert.equal(listeners.size, 0);
  render();
  await new Promise((resolve) => setTimeout(resolve, 180));
  assert.equal(timers.size, 0);
});
test('reduced-motion CSS disables logo and existing CSS indicator animations', () => {
  const css = readFileSync('src/webview/media/chat.css', 'utf8');
  assert.match(
    css,
    /@media \(prefers-reduced-motion: reduce\) \{\s*\.working-logo,[\s\S]*?animation: none;/
  );
});
