import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import type { WebviewSnapshot } from '../../src/state/types';
import { COMPOSER_FIELD_ID, ATTACH_TRIGGER_ID } from '../../src/webview/render';

const dom = new JSDOM('<!doctype html><div id="app"></div>', {
  pretendToBeVisual: true,
  url: 'https://webview.test/',
});
const posted: Array<Record<string, unknown>> = [];
const matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  Node: dom.window.Node,
  Event: dom.window.Event,
  HTMLElement: dom.window.HTMLElement,
  HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
  MutationObserver: dom.window.MutationObserver,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
  ResizeObserver: class {
    observe() {}
    disconnect() {}
  },
  IntersectionObserver: class {
    observe() {}
    disconnect() {}
  },
  matchMedia,
  acquireVsCodeApi: () => ({
    postMessage: (message: Record<string, unknown>) => posted.push(message),
    getState: () => undefined,
    setState: () => undefined,
  }),
});
Object.assign(dom.window, { matchMedia });
Object.assign(dom.window.HTMLElement.prototype, { scrollTo() {}, scrollIntoView() {} });
function render(overrides: Partial<WebviewSnapshot> = {}) {
  const snapshot: WebviewSnapshot = {
    sequence: 1,
    title: 'Chat',
    bindingState: 'current',
    connectionState: 'ready',
    workspaceFolderName: 'workspace',
    sessionId: 'session',
    sessionFile: '/tmp/session.jsonl',
    isStreaming: false,
    isCompacting: false,
    messages: [],
    queue: { steering: [], followUp: [] },
    draft: '',
    statuses: {},
    widgets: [],
    model: { id: 'model', reasoning: true },
    thinkingLevel: 'off',
    pendingContextItems: [],
    pendingImages: [],
    focus: 'none',
    isTrusted: true,
    folders: [],
    typewriterSpeed: 'off',
    ...overrides,
  };
  message({ type: 'snapshot', snapshot });
}
function message(data: unknown) {
  dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data }));
}
function composer() {
  return dom.window.document.getElementById(COMPOSER_FIELD_ID) as HTMLTextAreaElement;
}
function press(target: Element = composer(), init: KeyboardEventInit = {}) {
  const event = new dom.window.KeyboardEvent('keydown', {
    key: 'Tab',
    shiftKey: true,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  target.dispatchEvent(event);
  return event;
}
function commands() {
  return posted.filter((m) => m.type === 'executeCommand');
}
test.before(async () => {
  await import('../../src/webview/media/chat.js');
});
test.beforeEach(() => {
  render();
  posted.length = 0;
  composer().value = 'keep draft';
});
test.after(() => dom.window.close());

test('composer Shift+Tab posts only the existing native command, including while busy', () => {
  for (const overrides of [
    {},
    { connectionState: 'busy' as const, isStreaming: true },
    { model: { id: 'plain', reasoning: false } },
  ]) {
    render(overrides);
    composer().value = 'keep draft';
    assert.equal(press().defaultPrevented, true);
    assert.equal(composer().value, 'keep draft');
  }
  assert.deepEqual(
    commands(),
    Array(3).fill({ type: 'executeCommand', command: 'piRpc.cycleThinkingLevel' })
  );
  assert.ok(!posted.some((m) => m.type === 'requestSend'));
});
test('thinking dynamic discovery, completion Enter and local execution retain owned text', () => {
  composer().value = '/thi';
  composer().dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  message({
    type: 'slashCommands',
    items: [{ name: 'thinking', description: 'Session thinking', source: 'builtin' }],
  });
  press(composer(), { key: 'Enter', shiftKey: false });
  assert.equal(composer().value, '');
  assert.equal(posted.filter((m) => m.type === 'requestSend').length, 1);
  press(composer(), { key: 'Enter', shiftKey: false });
  assert.equal(posted.filter((m) => m.type === 'requestSend').length, 1);
  assert.equal(composer().value.trim(), '');
});

test('modified Enter sends without bypassing Follow Agent', () => {
  press(composer(), { key: 'Enter', shiftKey: false, ctrlKey: true });
  const request = posted.find((message) => message.type === 'requestSend');
  assert.ok(request);
  assert.equal(Object.hasOwn(request, 'follow'), false);
});

test('Shift+Tab precedes completion; plain Tab still accepts slash and mention', () => {
  composer().value = '/he';
  composer().dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  message({ type: 'slashCommands', items: [{ name: 'help', description: 'Help' }] });
  press();
  assert.equal(composer().value, '/he');
  press(composer(), { shiftKey: false });
  assert.equal(composer().value, '/help ');
  composer().value = '@exa';
  composer().setSelectionRange(4, 4);
  composer().dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  message({ type: 'fileMentions', items: [{ path: '/tmp/example.ts', name: 'example.ts' }] });
  press();
  assert.equal(composer().value, '@exa');
  assert.ok(!posted.some((m) => m.type === 'attachFile'));
  press(composer(), { shiftKey: false });
  assert.equal(posted.filter((m) => m.type === 'attachFile').length, 1);
});
test('other targets and modified/IME Tab retain normal behavior', () => {
  const extras = dom.window.document.createElement('div');
  extras.innerHTML = '<input><textarea></textarea><div contenteditable="true" tabindex="0"></div>';
  dom.window.document.body.appendChild(extras);
  for (const target of [
    ...extras.children,
    dom.window.document.getElementById(ATTACH_TRIGGER_ID)!,
  ]) {
    assert.equal(press(target).defaultPrevented, false);
  }
  for (const init of [
    { ctrlKey: true },
    { metaKey: true },
    { altKey: true },
    { isComposing: true },
    { shiftKey: false },
  ]) {
    assert.equal(press(composer(), init).defaultPrevented, false);
  }
  assert.deepEqual(commands(), []);
  extras.remove();
});
test('repeat and non-current/unavailable snapshots do not post commands', () => {
  press(composer(), { repeat: true });
  for (const overrides of [
    { connectionState: 'starting' as const },
    { connectionState: 'stopped' as const },
    { bindingState: 'cached' as const },
    { switchingSession: true },
  ]) {
    render(overrides);
    press();
  }
  assert.deepEqual(commands(), []);
});
