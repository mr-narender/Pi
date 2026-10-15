import assert from 'node:assert/strict';
import test from 'node:test';
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
const delays = new Map<number, number>();
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
  setInterval: (fn: () => void, ms: number) => {
    timers.set(++nextTimer, fn);
    delays.set(nextTimer, ms);
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

const text = () => dom.window.document.querySelector('.message-body')?.textContent ?? '';
const answer = (value: string) => [
  {
    id: 'a',
    role: 'assistant' as const,
    text: value,
    blocks: [{ kind: 'text' as const, text: value }],
    attachments: [],
  },
];
const tick = () => {
  for (const callback of [...timers.values()]) callback();
};
const send = (value: string, extra: Partial<WebviewSnapshot> = {}) =>
  render({
    sessionId: 'remote',
    typewriterSpeed: 'normal',
    currentAssistantMessageId: 'a',
    messages: answer(value),
    ...extra,
  });
test.after(() => {
  dom.window.dispatchEvent(new dom.window.Event('beforeunload'));
  globalThis.setInterval = originalSet;
  globalThis.clearInterval = originalClear;
  dom.window.close();
});
test('remote final burst drains locally after settlement while backend controls are ready', async () => {
  await import('../../src/webview/media/chat.js');
  send('');
  await new Promise((resolve) => setTimeout(resolve, 180));
  const burst = Array.from({ length: 100 }, (_, i) => `line ${i}: remote output`).join('\n');
  send(burst, {
    connectionState: 'ready',
    isStreaming: false,
    currentAssistantMessageId: undefined,
  });
  assert.ok(text().length < burst.length, 'settled snapshot must not dump the entire burst');
  assert.equal(dom.window.document.querySelector('[data-action="abort"]'), null);
  tick();
  assert.ok(text().length > 0 && text().length < burst.length);
  for (let i = 0; i < 300; i++) tick();
  assert.equal(text(), burst);
});
test('ready streaming, corrections and speed off never leave stale or missing text', async () => {
  send('first twelve same but OLD body', { isStreaming: true, connectionState: 'ready' });
  await new Promise((resolve) => setTimeout(resolve, 180));
  assert.equal(text(), '');
  tick();
  send('first twelve same but CORRECT body', { isStreaming: true, connectionState: 'ready' });
  for (let i = 0; i < 300; i++) tick();
  assert.equal(text(), 'first twelve same but CORRECT body');
  send('speed off latest complete text', {
    typewriterSpeed: 'off',
    connectionState: 'ready',
    isStreaming: true,
  });
  assert.equal(text(), 'speed off latest complete text');
});
test('history and session switches render immediately and dispose pending reveal', () => {
  send('unseen historical answer', {
    sessionId: 'history',
    connectionState: 'ready',
    currentAssistantMessageId: undefined,
  });
  assert.equal(text(), 'unseen historical answer');
  send('new live text', { sessionId: 'new' });
  send('another saved answer', {
    sessionId: 'other',
    connectionState: 'ready',
    currentAssistantMessageId: undefined,
  });
  tick();
  assert.equal(text(), 'another saved answer');
});

test('coalesced busy placeholder and completed markdown reveal only the new answer', async () => {
  render({ sessionId: 'coalesced', typewriterSpeed: 'normal', messages: [] });
  await new Promise((resolve) => setTimeout(resolve, 180));
  const code =
    '```typescript\n' +
    Array.from({ length: 100 }, (_, i) => `const row${i} = ${i};`).join('\n') +
    '\n```';
  render({
    sessionId: 'coalesced',
    typewriterSpeed: 'normal',
    connectionState: 'ready',
    messages: answer(code),
  });
  const node = dom.window.document.querySelector('.js-stream-text')!;
  assert.ok(node);
  assert.equal(node.textContent, '');
  tick();
  assert.ok((node.textContent?.length ?? 0) > 0 && (node.textContent?.length ?? 0) < code.length);
  for (let i = 0; i < 400; i++) tick();
  assert.match(node.textContent ?? '', /const row99 = 99;/);
  assert.ok(node.querySelector('pre code'));
});
test('reduced motion flushes pending text immediately and leaves no reveal timer', async () => {
  send('pending remote answer', {
    sessionId: 'motion',
    connectionState: 'ready',
    isStreaming: true,
  });
  await new Promise((resolve) => setTimeout(resolve, 180));
  assert.equal(text(), '');
  preference(true);
  assert.equal(text(), 'pending remote answer');
  assert.equal(timers.size, 0);
  preference(false);
});

test('speed changes replace reveal timing and slow frames catch up within the reveal budget', async () => {
  send('x'.repeat(10000), {
    sessionId: 'slow-frame',
    connectionState: 'ready',
    isStreaming: true,
    typewriterSpeed: 'slow',
  });
  await new Promise((resolve) => setTimeout(resolve, 180));
  assert.ok([...timers.keys()].some((id) => delays.get(id) === 34));
  tick();
  const prefix = text();
  send('x'.repeat(10000), {
    sessionId: 'slow-frame',
    connectionState: 'ready',
    isStreaming: true,
    typewriterSpeed: 'fast',
  });
  assert.equal(text(), prefix, 'speed change retains the visible prefix');
  assert.ok(![...timers.keys()].some((id) => delays.get(id) === 34));
  assert.ok([...timers.keys()].some((id) => delays.get(id) === 18));
  const now = performance.now.bind(performance);
  let frameTime = now();
  try {
    Object.defineProperty(performance, 'now', { configurable: true, value: () => frameTime });
    send('x'.repeat(10000), {
      sessionId: 'slow-frame',
      connectionState: 'ready',
      isStreaming: true,
      typewriterSpeed: 'slow',
    });
    frameTime += 2000;
    tick();
    assert.ok(text().length < 10000, 'slower speed gets its own reveal deadline');
    frameTime += 10000;
    Object.defineProperty(performance, 'now', { configurable: true, value: () => now() + 10000 });
    tick();
    assert.equal(
      text(),
      'x'.repeat(10000),
      'late browser frame finishes overdue reveal rather than replaying indefinitely'
    );
  } finally {
    Object.defineProperty(performance, 'now', { configurable: true, value: now });
  }
});
test('a new user turn flushes the previous answer without replaying history', async () => {
  const old = 'old answer '.repeat(400);
  send(old, { sessionId: 'next-turn', connectionState: 'ready', isStreaming: true });
  await new Promise((resolve) => setTimeout(resolve, 180));
  tick();
  assert.ok(text().length < old.length);
  render({
    sessionId: 'next-turn',
    typewriterSpeed: 'normal',
    messages: [
      ...answer(old),
      { id: 'next-user', role: 'user', text: 'Next question', attachments: [] },
    ],
  });
  await new Promise((resolve) => setTimeout(resolve, 180));
  assert.equal(text(), old);
  assert.equal(dom.window.document.querySelector('.js-stream-text'), null);
});
test('settled reveal returns to normal structured rendering without replaying on later snapshots', async () => {
  const json = '```json\n{"name":"Pi","count":3}\n```';
  send(json, { sessionId: 'settled-json' });
  await new Promise((resolve) => setTimeout(resolve, 180));
  send(json, {
    sessionId: 'settled-json',
    connectionState: 'ready',
    isStreaming: false,
    currentAssistantMessageId: undefined,
  });
  for (let i = 0; i < 300; i++) tick();
  assert.equal(
    dom.window.document.querySelector('.js-stream-text'),
    null,
    'settled local marker is removed once drained'
  );
  assert.ok(dom.window.document.querySelector('[data-json-block] .json-table'));
  send(json, {
    sessionId: 'settled-json',
    connectionState: 'ready',
    isStreaming: false,
    currentAssistantMessageId: undefined,
  });
  assert.equal(
    dom.window.document.querySelector('.js-stream-text'),
    null,
    'passive ready snapshot never replays completed text'
  );
});
test('empty terminal corrections restore Retry and provider errors remain visible', async () => {
  send('provisional answer', { sessionId: 'empty-correction' });
  await new Promise((resolve) => setTimeout(resolve, 180));
  tick();
  send('', {
    sessionId: 'empty-correction',
    connectionState: 'ready',
    isStreaming: false,
    currentAssistantMessageId: undefined,
  });
  assert.ok(dom.window.document.querySelector('.assistant-empty'));
  assert.ok(dom.window.document.querySelector('[data-command="piRpcInternal.retryLast"]'));
  send('', {
    sessionId: 'empty-correction',
    connectionState: 'ready',
    isStreaming: false,
    currentAssistantMessageId: undefined,
    messages: [{ ...answer('')[0]!, errorMessage: 'OWNED provider failure' }],
  });
  assert.match(
    dom.window.document.getElementById('messages')!.textContent ?? '',
    /OWNED provider failure/
  );
});
for (const focused of [true, false]) {
  test(`final local reveal preserves ${focused ? 'focused' : 'blurred'} composer edits before a remote draft echo`, async () => {
    const sessionId = `draft-${focused}`;
    const output = 'pending response '.repeat(200);
    send(output, { sessionId });
    await new Promise((resolve) => setTimeout(resolve, 180));
    send(output, {
      sessionId,
      connectionState: 'ready',
      isStreaming: false,
      currentAssistantMessageId: undefined,
    });
    const field = dom.window.document.getElementById('composer-field') as HTMLTextAreaElement;
    field.focus();
    field.value = 'new unacknowledged draft';
    field.dispatchEvent(
      new dom.window.InputEvent('input', {
        bubbles: true,
        data: 'draft',
        inputType: 'insertText',
        isComposing: true,
      })
    );
    field.setSelectionRange(5, 5);
    if (!focused) field.blur();
    const hasFocus = dom.window.document.hasFocus;
    dom.window.document.hasFocus = () => true;
    try {
      for (let i = 0; i < 400; i++) tick();
      const current = dom.window.document.getElementById('composer-field') as HTMLTextAreaElement;
      assert.equal(current.value, 'new unacknowledged draft');
      if (focused) {
        assert.equal(dom.window.document.activeElement, current);
        assert.equal(current.selectionStart, 5);
      }
      assert.equal(dom.window.document.querySelector('.js-stream-text'), null);
    } finally {
      dom.window.document.hasFocus = hasFocus;
    }
  });
}
test('reduced motion finishes settled backlog with normal formatting and preserves blurred draft', async () => {
  const json = '```json\n{"name":"Pi","count":3}\n```';
  send(json, { sessionId: 'motion-draft' });
  await new Promise((resolve) => setTimeout(resolve, 180));
  send(json, {
    sessionId: 'motion-draft',
    connectionState: 'ready',
    isStreaming: false,
    currentAssistantMessageId: undefined,
  });
  const field = dom.window.document.getElementById('composer-field') as HTMLTextAreaElement;
  field.value = 'keep this draft';
  field.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  field.blur();
  preference(true);
  assert.equal(dom.window.document.querySelector('.js-stream-text'), null);
  assert.ok(dom.window.document.querySelector('[data-json-block] .json-table'));
  assert.equal(
    (dom.window.document.getElementById('composer-field') as HTMLTextAreaElement).value,
    'keep this draft'
  );
  preference(false);
});
test('authoritative composer resets still win before settled reveal completes', async () => {
  const output = 'pending reset response '.repeat(100);
  send(output, { sessionId: 'reset-draft', composerResetSeq: 1 });
  await new Promise((resolve) => setTimeout(resolve, 180));
  send(output, {
    sessionId: 'reset-draft',
    connectionState: 'ready',
    isStreaming: false,
    currentAssistantMessageId: undefined,
    composerResetSeq: 1,
  });
  const field = dom.window.document.getElementById('composer-field') as HTMLTextAreaElement;
  field.value = 'local superseded draft';
  field.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  field.blur();
  send(output, {
    sessionId: 'reset-draft',
    connectionState: 'ready',
    isStreaming: false,
    currentAssistantMessageId: undefined,
    composerResetSeq: 2,
    draft: 'authoritative restored draft',
  });
  for (let i = 0; i < 400; i++) tick();
  assert.equal(
    (dom.window.document.getElementById('composer-field') as HTMLTextAreaElement).value,
    'authoritative restored draft'
  );
});
test('local reveals preserve a scrolled-up reader and follow an already pinned reader', async () => {
  send('new answer '.repeat(200), {
    sessionId: 'scroll',
    connectionState: 'ready',
    isStreaming: true,
  });
  await new Promise((resolve) => setTimeout(resolve, 180));
  const messages = dom.window.document.getElementById('messages')!;
  Object.defineProperties(messages, {
    scrollHeight: { configurable: true, value: 2000 },
    clientHeight: { configurable: true, value: 300 },
    scrollTop: { configurable: true, writable: true, value: 100 },
  });
  tick();
  assert.equal(messages.scrollTop, 100);
  messages.scrollTop = 1800;
  tick();
  assert.equal(messages.scrollTop, 2000);
  dom.window.dispatchEvent(new dom.window.Event('beforeunload'));
  assert.equal(timers.size, 0, 'unload stops reveal and working timers');
});
