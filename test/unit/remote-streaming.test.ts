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
const sentMessages: unknown[] = [];
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
  acquireVsCodeApi: () => ({
    postMessage(message: unknown) {
      sentMessages.push(message);
    },
    getState() {},
    setState() {},
  }),
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
test('activity updates on the answer fast path without resetting reveal, glyph, or composer', async () => {
  const initial = 'streaming '.repeat(200);
  const activity = {
    tools: [{ id: 't1', name: 'read', status: 'running' as const }],
    output: 'first output',
    files: [{ path: 'first.ts' }],
    statuses: [],
  };
  send(initial, { sessionId: 'activity-live', activity });
  await new Promise((resolve) => setTimeout(resolve, 180));
  tick();
  const panel = dom.window.document.getElementById('activity-panel') as HTMLDetailsElement;
  panel.open = true;
  const sources = dom.window.document.getElementById('activity-tab-sources')!;
  sources.click();
  const glyph = dom.window.document.querySelector('.working-glyph')!;
  const frame = glyph.textContent;
  const revealed = text();
  const field = dom.window.document.getElementById('composer-field') as HTMLTextAreaElement;
  field.value = 'in-progress draft';
  field.dispatchEvent(new dom.window.Event('compositionstart', { bubbles: true }));
  send(initial + 'more text', {
    sessionId: 'activity-live',
    activity: { ...activity, output: 'second output', files: [{ path: 'new.ts' }] },
  });
  assert.equal(dom.window.document.getElementById('activity-panel'), panel);
  assert.equal(panel.open, true);
  assert.equal(
    dom.window.document.getElementById('activity-tab-sources')?.getAttribute('aria-selected'),
    'true'
  );
  assert.equal(dom.window.document.querySelector('.activity-output')?.textContent, 'second output');
  assert.equal(dom.window.document.querySelector('.working-glyph'), glyph);
  assert.equal(glyph.textContent, frame);
  assert.equal(text(), revealed);
  assert.equal(field.value, 'in-progress draft');
  const before = sentMessages.length;
  dom.window.document.querySelector<HTMLButtonElement>('#activity-panel [data-file-open]')!.click();
  assert.deepEqual(sentMessages.slice(before), [{ type: 'openFile', path: 'new.ts' }]);
  field.dispatchEvent(new dom.window.Event('compositionend', { bubbles: true }));
  tick();
  assert.ok(text().length > revealed.length);
  assert.notEqual(glyph.textContent, frame, 'the local working timer advances between host frames');
});

test('activity keyboard tabs and expanded state survive structural and settled snapshots', async () => {
  const activity = { tools: [], output: '', files: [], statuses: [] };
  send('answer', { sessionId: 'activity-keys', activity });
  await new Promise((resolve) => setTimeout(resolve, 180));
  const panel = dom.window.document.getElementById('activity-panel') as HTMLDetailsElement;
  panel.open = true;
  const output = dom.window.document.getElementById('activity-tab-output')!;
  output.click();
  output.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'End', bubbles: true }));
  assert.equal(dom.window.document.activeElement?.id, 'activity-tab-agents');
  dom.window.document.activeElement!.dispatchEvent(
    new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })
  );
  assert.equal(dom.window.document.activeElement?.id, 'activity-tab-output');
  dom.window.document.activeElement!.dispatchEvent(
    new dom.window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })
  );
  assert.equal(dom.window.document.activeElement?.id, 'activity-tab-agents');
  send('complete', {
    sessionId: 'activity-keys',
    activity,
    connectionState: 'ready',
    currentAssistantMessageId: undefined,
  });
  assert.equal(
    (dom.window.document.getElementById('activity-panel') as HTMLDetailsElement).open,
    true
  );
  assert.equal(
    dom.window.document.getElementById('activity-tab-agents')?.getAttribute('aria-selected'),
    'true'
  );
  assert.equal(
    dom.window.document.getElementById('activity-view-agents')?.hasAttribute('hidden'),
    false
  );
});

test('instant and reduced-motion code streams defer highlighting until settled', async () => {
  const raw = '```typescript\nexport const value = "remote";\n```';
  for (const reduced of [false, true]) {
    preference(reduced);
    const mode = {
      sessionId: `instant-code-${reduced}`,
      typewriterSpeed: reduced ? 'normal' : 'off',
    };
    send(raw, { ...mode, isStreaming: true });
    await new Promise((resolve) => setTimeout(resolve, 180));
    assert.match(text(), /export const value/);
    assert.equal(
      dom.window.document.querySelector('#messages .hljs-keyword'),
      null,
      'instant display must not re-highlight a growing fence'
    );
    send(raw, { ...mode, isStreaming: false, connectionState: 'ready' });
    assert.ok(dom.window.document.querySelector('#messages .hljs-keyword'));
  }
  preference(false);
});

test('incoming deltas preserve revealed DOM until the next reveal tick', async () => {
  send('**remote output** '.repeat(100), { sessionId: 'paint-budget', isStreaming: true });
  await new Promise((resolve) => setTimeout(resolve, 180));
  tick();
  const target = dom.window.document.querySelector('.js-stream-text')!;
  const revealed = target.firstChild;
  assert.ok(revealed);
  send('**remote output** '.repeat(101), { sessionId: 'paint-budget', isStreaming: true });
  assert.equal(
    target.firstChild,
    revealed,
    'unchanged revealed prefix must not replace DOM on incoming snapshots'
  );
  send('CORRECTED '.repeat(100), { sessionId: 'paint-budget', isStreaming: true });
  assert.notEqual(
    target.firstChild,
    revealed,
    'corrections must invalidate the previous revealed prefix'
  );
});

test('structural snapshots do not expose an unrevealed answer when morphdom reuses its node', async () => {
  const raw = '**remote backlog** '.repeat(100);
  send(raw, { sessionId: 'structural-paint', isStreaming: true });
  await new Promise((resolve) => setTimeout(resolve, 180));
  tick();
  const revealed = text();
  assert.ok(revealed.length > 0 && revealed.length < raw.length);
  send(raw, {
    sessionId: 'structural-paint',
    isStreaming: true,
    queue: { steering: ['next'], followUp: [] },
  });
  await new Promise((resolve) => setTimeout(resolve, 180));
  assert.equal(text(), revealed, 'full render must restore the local reveal prefix');
});

test('optional highlighter readiness does not rebuild history during a live reply', async () => {
  send('**still streaming** '.repeat(100), { sessionId: 'highlight-ready', isStreaming: true });
  await new Promise((resolve) => setTimeout(resolve, 180));
  tick();
  const target = dom.window.document.querySelector('.js-stream-text')!;
  const revealed = target.firstChild;
  dom.window.document.dispatchEvent(new dom.window.Event('pi-highlight-ready'));
  assert.equal(
    target.firstChild,
    revealed,
    'highlighter loading must not rebuild the active transcript'
  );
});

test('passive remote snapshots preserve blurred unsent edits without rewriting the native value', (t) => {
  t.mock.method(dom.window.document, 'hasFocus', () => true);
  const state = {
    sessionId: 'passive-draft',
    connectionState: 'ready' as const,
    composerResetSeq: 0,
  };
  render(state);
  const field = dom.window.document.getElementById('composer-field') as HTMLTextAreaElement;
  field.value = 'local unacknowledged text';
  field.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  field.blur();
  const descriptor = Object.getOwnPropertyDescriptor(
    dom.window.HTMLTextAreaElement.prototype,
    'value'
  )!;
  let writes = 0;
  Object.defineProperty(field, 'value', {
    configurable: true,
    get() {
      return descriptor.get!.call(this);
    },
    set(value) {
      writes++;
      descriptor.set!.call(this, value);
    },
  });
  render({ ...state, statuses: { remote: 'updated' } });
  assert.equal(field.value, 'local unacknowledged text');
  assert.equal(writes, 0, 'passive updates must preserve the browser undo buffer');
  assert.notEqual(dom.window.document.activeElement, field);
  delete (field as unknown as { value?: string }).value;
  render({ ...state, composerResetSeq: 1, draft: 'explicit restored draft' });
  assert.equal(field.value, 'explicit restored draft', 'explicit host resets still apply');
});

test('passive snapshots do not steal a transcript selection', (t) => {
  t.mock.method(dom.window.document, 'hasFocus', () => true);
  const state = {
    sessionId: 'selection',
    connectionState: 'ready' as const,
    messages: answer('Select this response'),
    focus: 'none' as const,
  };
  render(state);
  const field = dom.window.document.getElementById('composer-field') as HTMLTextAreaElement;
  field.focus();
  const selection = dom.window.getSelection()!;
  const range = dom.window.document.createRange();
  range.selectNodeContents(dom.window.document.querySelector('.message-body')!);
  selection.removeAllRanges();
  selection.addRange(range);
  let focuses = 0;
  t.mock.method(field, 'focus', () => {
    focuses++;
  });
  render({ ...state, statuses: { remote: 'updated' } });
  assert.equal(focuses, 0);
  assert.equal(selection.toString(), 'Select this response');
  selection.removeAllRanges();
});

test('new text typed after sending survives the delayed remote clear acknowledgement', () => {
  const state = { sessionId: 'send-draft', connectionState: 'ready' as const, composerResetSeq: 0 };
  render(state);
  const field = dom.window.document.getElementById('composer-field') as HTMLTextAreaElement;
  field.value = 'first submitted message';
  field.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  field.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.equal(field.value, '');
  field.value = 'next unsent message';
  field.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  field.blur();
  render({ ...state, composerResetSeq: 1 });
  assert.equal(field.value, 'next unsent message');
  assert.deepEqual(sentMessages.at(-1), {
    type: 'setDraft',
    text: 'next unsent message',
    resetSeq: 1,
  });
  render({ ...state, composerResetSeq: 2, draft: 'explicit replacement' });
  assert.equal(field.value, 'explicit replacement');
});

test('a persistent composer focus echo does not steal focus from another control', (t) => {
  t.mock.method(dom.window.document, 'hasFocus', () => true);
  const state = {
    sessionId: 'focus-echo',
    connectionState: 'ready' as const,
    focus: 'composer' as const,
  };
  render(state);
  const field = dom.window.document.getElementById('composer-field') as HTMLTextAreaElement;
  assert.equal(dom.window.document.activeElement, field);
  const button = dom.window.document.querySelector('button')!;
  button.focus();
  render({ ...state, statuses: { remote: 'updated' } });
  assert.equal(dom.window.document.activeElement, button);
  render({ ...state, focus: 'none' });
  render(state);
  assert.equal(
    dom.window.document.activeElement,
    field,
    'a new explicit focus request still applies'
  );
});

test('submitted text from another session cannot clear the newly opened session draft', () => {
  render({ sessionId: 'submit-origin', connectionState: 'ready', composerResetSeq: 0 });
  const field = dom.window.document.getElementById('composer-field') as HTMLTextAreaElement;
  field.value = 'same valid draft';
  field.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  field.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  render({
    sessionId: 'different-session',
    connectionState: 'ready',
    composerResetSeq: 0,
    draft: 'same valid draft',
  });
  assert.equal(field.value, 'same valid draft');
});

test('edits during a local command cannot overwrite an unrelated session draft', () => {
  render({ sessionId: 'command-origin', connectionState: 'ready', composerResetSeq: 0 });
  const field = dom.window.document.getElementById('composer-field') as HTMLTextAreaElement;
  field.value = '/model';
  field.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  field.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  field.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  field.value = 'new outgoing edits';
  field.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  render({
    sessionId: 'unrelated-session',
    connectionState: 'ready',
    composerResetSeq: 0,
    draft: 'saved incoming draft',
  });
  assert.equal(field.value, 'saved incoming draft');
});

test('composer Undo and Redo shortcuts stay inside the focused input instead of routing to VS Code', (t) => {
  render({ sessionId: 'keyboard-editing', connectionState: 'ready', composerResetSeq: 0 });
  const field = dom.window.document.getElementById('composer-field') as HTMLTextAreaElement;
  const commands: string[] = [];
  Object.defineProperty(dom.window.document, 'execCommand', {
    configurable: true,
    value: (command: string) => {
      commands.push(command);
      return true;
    },
  });
  t.after(() => {
    Reflect.deleteProperty(dom.window.document, 'execCommand');
  });
  const cases = [
    { key: 'z', metaKey: true, command: 'undo' },
    { key: 'Z', metaKey: true, shiftKey: true, command: 'redo' },
    { key: 'z', ctrlKey: true, command: 'undo' },
    { key: 'Z', ctrlKey: true, shiftKey: true, command: 'redo' },
    { key: 'y', ctrlKey: true, command: 'redo' },
  ];
  for (const { command, ...keys } of cases) {
    const event = new dom.window.KeyboardEvent('keydown', {
      ...keys,
      bubbles: true,
      cancelable: true,
    });
    field.dispatchEvent(event);
    assert.equal(commands.at(-1), command);
    assert.equal(event.defaultPrevented, true);
  }
  for (const extra of [{ isComposing: true }, { altKey: true }]) {
    const event = new dom.window.KeyboardEvent('keydown', {
      key: 'z',
      ctrlKey: true,
      ...extra,
      bubbles: true,
      cancelable: true,
    });
    field.dispatchEvent(event);
    assert.equal(event.defaultPrevented, false);
  }
  assert.equal(commands.length, cases.length);
});

test('submit clears text through a native undoable edit without clearing the host draft before send', (t) => {
  render({ sessionId: 'undo-submit', connectionState: 'ready', composerResetSeq: 0 });
  const field = dom.window.document.getElementById('composer-field') as HTMLTextAreaElement;
  field.value = 'restore this submitted text';
  field.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  const commands: string[] = [];
  Object.defineProperty(dom.window.document, 'execCommand', {
    configurable: true,
    value: (command: string) => {
      commands.push(command);
      if (command === 'delete') {
        field.value = '';
        field.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      }
      return true;
    },
  });
  t.after(() => {
    Reflect.deleteProperty(dom.window.document, 'execCommand');
  });
  const start = sentMessages.length;
  field.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.deepEqual(commands, ['delete']);
  assert.equal(field.value, '');
  assert.equal(sentMessages.slice(start).filter((m: any) => m.type === 'setDraft').length, 0);
  assert.equal(sentMessages.slice(start).filter((m: any) => m.type === 'requestSend').length, 1);
});

test('Thinking starts compact and preserves user expansion across passive snapshots', () => {
  const state = {
    sessionId: 'thinking-disclosure',
    connectionState: 'ready' as const,
    messages: [
      {
        id: 'thinking-a',
        role: 'assistant' as const,
        text: 'Answer',
        attachments: [],
        blocks: [
          { kind: 'thinking' as const, text: 'Work details' },
          { kind: 'text' as const, text: 'Answer' },
        ],
      },
    ],
  };
  render(state);
  const detail = () =>
    dom.window.document.querySelector<HTMLDetailsElement>('.tl-thinking > details')!;
  assert.equal(detail().open, false);
  detail().open = true;
  render({ ...state, statuses: { task: 'updated' } });
  assert.equal(detail().open, true);
  detail().open = false;
  render({ ...state, statuses: { task: 'updated again' } });
  assert.equal(detail().open, false);
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
