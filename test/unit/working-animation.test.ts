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
    uiMode: 'simple',
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
test('working frames stop live under reduced motion, retarget, and clean up on idle/disposal', async () => {
  await import('../../src/webview/media/chat.js');
  for (const workingAnimation of ['braille', 'earth', 'moon'] as const) {
    for (const surface of ['tab', 'sidebar'] as const) {
      render({ workingAnimation, surface });
      await new Promise((resolve) => setTimeout(resolve, 180));
      assert.equal(timers.size, 1);
      render({ workingAnimation, surface });
      assert.equal(timers.size, 1);
      preference(true);
      assert.equal(timers.size, 0);
      const glyph = dom.window.document.querySelector('.working-glyph')?.textContent;
      render({ workingAnimation, surface });
      assert.equal(timers.size, 0);
      assert.equal(dom.window.document.querySelector('.working-glyph')?.textContent, glyph);
      preference(false);
      assert.equal(timers.size, 1);
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
