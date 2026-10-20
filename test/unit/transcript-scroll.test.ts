import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import type { WebviewSnapshot } from '../../src/state/types';

const bundle = build({
  entryPoints: ['src/webview/media/chat.ts'],
  bundle: true,
  platform: 'browser',
  format: 'iife',
  write: false,
});

async function frame(initial: Partial<WebviewSnapshot> = {}) {
  const dom = new JSDOM('<!doctype html><div id="app"></div>', {
    pretendToBeVisual: true,
    runScripts: 'outside-only',
    url: 'https://webview.test/',
  });
  const { window } = dom;
  const frames = new Map<number, FrameRequestCallback>();
  const timers = new Map<number, () => void>();
  const positions = new WeakMap<Element, number>();
  let next = 0;
  let height = 2000;
  let pendingHeight: number | undefined;
  Object.defineProperties(window.HTMLElement.prototype, {
    scrollHeight: {
      configurable: true,
      get: () => {
        const previous = height;
        if (pendingHeight !== undefined) {
          height = pendingHeight;
          pendingHeight = undefined;
        }
        return previous;
      },
    },
    clientHeight: { configurable: true, get: () => 300 },
    scrollTop: {
      configurable: true,
      get() {
        return positions.get(this) ?? 0;
      },
      set(value: number) {
        positions.set(this, Math.min(height - 300, Math.max(0, value)));
      },
    },
  });
  Object.assign(window, {
    acquireVsCodeApi: () => ({ postMessage() {}, getState() {}, setState() {} }),
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
    IntersectionObserver: class {
      observe() {}
      disconnect() {}
    },
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      frames.set(++next, callback);
      return next;
    },
    cancelAnimationFrame: (id: number) => frames.delete(id),
    setInterval: (callback: () => void) => {
      timers.set(++next, callback);
      return next;
    },
    clearInterval: (id: number) => timers.delete(id),
  });
  Object.assign(window.HTMLElement.prototype, {
    scrollIntoView() {
      window.document.getElementById('messages')!.scrollTop = height;
    },
  });
  window.eval((await bundle).outputFiles[0]!.text);
  let sequence = 0;
  const snapshot = (overrides: Partial<WebviewSnapshot> = {}) => {
    window.dispatchEvent(
      new window.MessageEvent('message', {
        data: {
          type: 'snapshot',
          snapshot: {
            sequence: ++sequence,
            sessionId: 'scroll',
            title: 'Chat',
            bindingState: 'current',
            connectionState: 'busy',
            workspaceFolderName: 'workspace',
            isStreaming: true,
            isCompacting: false,
            currentAssistantMessageId: 'answer',
            messages: [
              {
                id: 'answer',
                role: 'assistant',
                text: 'streaming answer '.repeat(100),
                blocks: [{ kind: 'text', text: 'streaming answer '.repeat(100) }],
                attachments: [],
              },
            ],
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
            typewriterSpeed: 'normal',
            ...overrides,
          } satisfies WebviewSnapshot,
        },
      })
    );
  };
  const wait = () => new Promise((resolve) => setTimeout(resolve, 180));
  snapshot(initial);
  await wait();
  const messages = () => window.document.getElementById('messages')!;
  const scroll = (top: number) => {
    messages().scrollTop = top;
    messages().dispatchEvent(new window.Event('scroll'));
  };
  const tick = () => {
    for (const callback of [...timers.values()]) callback();
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(window.performance.now());
  };
  return {
    dom,
    messages,
    snapshot,
    wait,
    scroll,
    tick,
    grow: () => (height += 100),
    growDuringRender: () => (pendingHeight = height + 100),
    wheel: (deltaY: number) =>
      messages().dispatchEvent(new window.WheelEvent('wheel', { bubbles: true, deltaY })),
    close: () => {
      window.dispatchEvent(new window.Event('beforeunload'));
      dom.window.close();
    },
  };
}

test('upward input cancels a pending bottom pin without its final scrollIntoView yank', async () => {
  const f = await frame();
  try {
    assert.equal(f.messages().scrollTop, 1700, 'new chat initially lands at the bottom');
    f.wheel(-30);
    f.scroll(1670);
    f.tick();
    assert.equal(f.messages().scrollTop, 1670, 'reader wins over queued pin and reveal frames');
  } finally {
    f.close();
  }
});

test('scrollbar movement pauses follow and deliberate scrolling to the exact bottom resumes it', async () => {
  const f = await frame();
  try {
    f.scroll(1660);
    f.tick();
    assert.equal(f.messages().scrollTop, 1660);
    f.scroll(1690);
    f.grow();
    f.tick();
    assert.equal(f.messages().scrollTop, 1690, 'near the bottom is still paused');
    f.scroll(1800);
    f.grow();
    f.tick();
    assert.equal(f.messages().scrollTop, 1900, 'returning to the bottom resumes reveal follow');
  } finally {
    f.close();
  }
});

test('composer caret keys do not interrupt follow; transcript navigation keys do', async () => {
  const f = await frame();
  try {
    const composer = f.dom.window.document.querySelector('textarea')!;
    for (const key of ['ArrowUp', 'Home']) {
      composer.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key, bubbles: true }));
    }
    f.grow();
    f.tick();
    assert.equal(f.messages().scrollTop, 1800);
    f.messages().dispatchEvent(
      new f.dom.window.KeyboardEvent('keydown', { key: 'PageUp', bubbles: true })
    );
    f.scroll(1770);
    f.tick();
    assert.equal(f.messages().scrollTop, 1770);
  } finally {
    f.close();
  }
});

test('upward touch scrolling cancels follow before native scrolling', async () => {
  const f = await frame();
  try {
    for (const [type, clientY] of [
      ['touchstart', 50],
      ['touchmove', 80],
    ] as const) {
      const event = new f.dom.window.Event(type, { bubbles: true });
      Object.defineProperty(event, 'touches', { value: [{ clientY }] });
      f.messages().dispatchEvent(event);
    }
    f.scroll(1670);
    f.tick();
    assert.equal(f.messages().scrollTop, 1670);
  } finally {
    f.close();
  }
});

test('older history keeps its prepend anchor and switching chat restores bottom following', async () => {
  const f = await frame({ messageWindow: { total: 150, offset: 100, hasOlder: true } });
  try {
    f.wheel(-700);
    f.scroll(1000);
    f.growDuringRender();
    f.snapshot({
      messageWindow: { total: 150, offset: 50, hasOlder: true },
      messages: [
        { id: 'older', role: 'user', text: 'older history', attachments: [] },
        {
          id: 'answer',
          role: 'assistant',
          text: 'streaming answer '.repeat(100),
          blocks: [{ kind: 'text', text: 'streaming answer '.repeat(100) }],
          attachments: [],
        },
      ],
    });
    await f.wait();
    assert.equal(f.messages().scrollTop, 1100, 'prepended height is added to the reader anchor');
    f.tick();
    assert.equal(f.messages().scrollTop, 1100, 'prepend restoration does not resume follow');
    f.snapshot({ sessionId: 'another-chat' });
    await f.wait();
    assert.equal(f.messages().scrollTop, 1800, 'new chat starts at its latest reply');
    f.grow();
    f.tick();
    assert.equal(f.messages().scrollTop, 1900);
  } finally {
    f.close();
  }
});

test('small upward intent survives stale scroll events and structural updates; jump resumes', async () => {
  const f = await frame();
  try {
    f.wheel(-30);
    // A previous programmatic scroll may arrive before the browser applies the wheel.
    f.messages().dispatchEvent(new f.dom.window.Event('scroll'));
    f.snapshot({ thinkingLevel: 'high' });
    await f.wait();
    f.scroll(1670);
    const before = f.dom.window.document.querySelector('.message-body')!.textContent!.length;
    f.tick();
    assert.equal(f.messages().scrollTop, 1670);
    assert.ok(
      f.dom.window.document.querySelector('.message-body')!.textContent!.length > before,
      'streaming continues below the paused reader'
    );
    const jump = f.dom.window.document.getElementById('jump-latest') as HTMLButtonElement;
    assert.equal(jump.hidden, false, 'small upward scroll can explicitly resume');
    jump.click();
    assert.equal(f.messages().scrollTop, 1700);
    f.grow();
    f.tick();
    assert.equal(f.messages().scrollTop, 1800, 'jump resumes following later output');
  } finally {
    f.close();
  }
});
