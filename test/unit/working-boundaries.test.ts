import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { createInitialControllerState } from '../../src/state/types';
import { reduceEvent } from '../../src/state/reducer';
import { createWebviewSnapshot } from '../../src/webview/model';
import { renderChatApp } from '../../src/webview/render';
const dom = new JSDOM('<!doctype html><div id="app"></div>', {
  pretendToBeVisual: true,
  url: 'https://webview.test/',
});
const observedClasses = new Set<MutationObserver>();
class TrackedObserver extends dom.window.MutationObserver {
  override observe(target: Node, options?: MutationObserverInit) {
    if (target === dom.window.document.body && options?.attributeFilter?.includes('class'))
      observedClasses.add(this);
    super.observe(target, options);
  }
  override disconnect() {
    observedClasses.delete(this);
    super.disconnect();
  }
}
const intervals = new Map<number, () => void>(),
  changes = new Set<() => void>();
let id = 0;
const media = {
  matches: false,
  addEventListener: (_: string, f: () => void) => changes.add(f),
  removeEventListener: (_: string, f: () => void) => changes.delete(f),
};
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  Node: dom.window.Node,
  Event: dom.window.Event,
  HTMLElement: dom.window.HTMLElement,
  HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
  MutationObserver: TrackedObserver,
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
  acquireVsCodeApi: () => ({ postMessage() {}, getState() {}, setState() {} }),
  setInterval: (f: () => void) => {
    intervals.set(++id, f);
    return id;
  },
  clearInterval: (n: number) => intervals.delete(n),
});
Object.assign(dom.window, { matchMedia: () => media });
Object.assign(dom.window.HTMLElement.prototype, { scrollTo() {}, scrollIntoView() {} });
let state = {
  ...createInitialControllerState('workspace', '/tmp/fixture'),
  connectionState: 'ready' as const,
};
const composer = { draft: '', pendingContextItems: [], pendingImages: [], focus: 'none' as const };
const project = () => ({
  ...createWebviewSnapshot(state, 1, { composer, isTrusted: true, folders: [] }),
  bindingState: 'current' as const,
  typewriterSpeed: 'off',
  surface: 'tab' as const,
});
function send(extra: Record<string, unknown> = {}) {
  dom.window.dispatchEvent(
    new dom.window.MessageEvent('message', {
      data: { type: 'snapshot', snapshot: { ...project(), ...extra } },
    })
  );
}
const wait = () => new Promise((r) => setTimeout(r, 180));
function motion(matches: boolean) {
  media.matches = matches;
  for (const f of changes) f();
}
test('producer events preserve streaming/tool/compaction/retry indicators and end cleanly', () => {
  let s = createInitialControllerState('workspace', '/tmp/fixture');
  s = { ...s, connectionState: 'ready' };
  for (const type of [
    'agent_start',
    'message_start',
    'tool_execution_start',
    'tool_execution_end',
    'turn_start',
    'message_update',
    'compaction_start',
    'compaction_end',
    'auto_retry_start',
    'auto_retry_end',
  ]) {
    s = reduceEvent(s, { type });
    const p = createWebviewSnapshot(s, 1, {
      composer,
      isTrusted: true,
      folders: [],
    });
    assert.equal(p.connectionState, 'busy', type);
    assert.ok(renderChatApp(p).includes('working-logo'), type);
  }
  s = reduceEvent(s, { type: 'agent_end' });
  assert.equal(s.connectionState, 'ready');
  assert.equal(s.state.isStreaming, false);
  for (const pair of [
    ['compaction_start', 'compaction_end'],
    ['auto_retry_start', 'auto_retry_end'],
  ] as const) {
    s = reduceEvent(s, { type: pair[0] });
    assert.equal(s.connectionState, 'busy');
    s = reduceEvent(s, { type: pair[1] });
    assert.equal(s.connectionState, 'ready');
  }
});
test('actual DOM rapid idle, all choices, motion, ownership and hidden node removal', async () => {
  await import('../../src/webview/media/chat.js');
  send();
  for (const workingAnimation of ['braille', 'earth', 'moon', 'dots', 'bars', 'dolphin']) {
    send({
      connectionState: 'busy',
      isStreaming: true,
      workingAnimation,
      sessionId: 'live-' + workingAnimation,
    });
    await wait();
    assert.ok(document.querySelector('.working-logo'));
    assert.match(document.querySelector('.working-label')!.textContent!, /Working/);
    assert.equal(intervals.size, ['braille', 'earth', 'moon'].includes(workingAnimation) ? 1 : 0);
    motion(true);
    assert.equal(intervals.size, 0);
    motion(false);
    send({ connectionState: 'ready', isStreaming: false, sessionId: 'other' });
    assert.equal(intervals.size, 0);
    assert.equal(document.querySelector('.working-logo'), null);
  }
  send({ connectionState: 'busy' });
  send({ connectionState: 'ready' });
  await wait();
  assert.equal(document.querySelector('.working-logo'), null);
  send({ connectionState: 'busy' });
  await wait();
  document.querySelector('.working-banner')!.remove();
  for (const f of intervals.values()) f();
  assert.equal(intervals.size, 0);
  send({ connectionState: 'faulted', isStreaming: true });
  motion(true);
  motion(false);
  assert.equal(intervals.size, 0);
});
test('native body class toggles JS frames without polling while status survives', async () => {
  send({ connectionState: 'busy', workingAnimation: 'earth' });
  await wait();
  assert.equal(intervals.size, 1);
  assert.equal(observedClasses.size, 1);
  document.body.classList.add('vscode-reduce-motion');
  await Promise.resolve();
  assert.equal(intervals.size, 0);
  assert.ok(document.querySelector('.working-label'));
  document.body.classList.remove('vscode-reduce-motion');
  await Promise.resolve();
  assert.equal(intervals.size, 1);
  motion(true);
  document.body.classList.add('vscode-reduce-motion');
  await Promise.resolve();
  motion(false);
  assert.equal(intervals.size, 0);
  document.body.classList.remove('vscode-reduce-motion');
  await Promise.resolve();
  assert.equal(intervals.size, 1);
  send({ connectionState: 'ready', isStreaming: false });
});
test('connected streaming and cached ownership also gate DOM timers', async () => {
  send({ connectionState: 'ready', isStreaming: true, workingAnimation: 'moon' });
  await wait();
  assert.ok(document.querySelector('.working-logo'));
  assert.equal(intervals.size, 1);
  send({ bindingState: 'cached', connectionState: 'busy', isStreaming: true });
  assert.equal(document.querySelector('.working-logo'), null);
  assert.equal(intervals.size, 0);
});
test('native reduced motion CSS covers all CSS working indicators', () => {
  const css = readFileSync('src/webview/media/chat.css', 'utf8');
  for (const selector of [
    'body.vscode-reduce-motion .working-logo',
    "body.vscode-reduce-motion .working[data-anim='dots'] .working-glyph::after",
    "body.vscode-reduce-motion .working[data-anim='bars'] .working-glyph",
    "body.vscode-reduce-motion .working[data-anim='dolphin'] .working-glyph",
  ])
    assert.ok(css.includes(selector));
  assert.match(css, /body\.vscode-reduce-motion[\s\S]*?animation: none;/);
});
test('inline editing across agent end keeps editor but removes work immediately', async () => {
  send({
    connectionState: 'busy',
    messages: [{ id: 'edit-fixture', role: 'user', text: 'edit me', attachments: [] }],
  });
  await wait();
  (document.querySelector('.msg-edit') as HTMLElement).click();
  const editor = document.querySelector('.inline-edit-field');
  assert.ok(editor);
  send({ connectionState: 'ready', isStreaming: false });
  assert.equal(document.querySelector('.working-logo'), null);
  assert.equal(intervals.size, 0);
  assert.equal(document.querySelector('.inline-edit-field'), editor);
  editor.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await wait();
  assert.equal(document.querySelector('.working-logo'), null);
});
test('unload cancels a pending busy debounce rather than mounting hidden animated DOM', async () => {
  send({ connectionState: 'ready' });
  send({ connectionState: 'busy', sessionId: 'pending-disposal' });
  assert.equal(document.querySelector('.working-logo'), null);
  dom.window.dispatchEvent(new dom.window.Event('beforeunload'));
  await wait();
  assert.equal(intervals.size, 0);
  assert.equal(changes.size, 0);
  assert.equal(observedClasses.size, 0);
  assert.equal(
    document.querySelector('.working-logo'),
    null,
    'pending busy render must not mount CSS animated logo after unload'
  );
  send({ connectionState: 'busy', workingAnimation: 'earth' });
  motion(true);
  motion(false);
  document.body.classList.add('vscode-reduce-motion');
  await Promise.resolve();
  document.body.classList.remove('vscode-reduce-motion');
  await Promise.resolve();
  await wait();
  assert.equal(document.querySelector('.working-logo'), null);
  assert.equal(intervals.size, 0);
  assert.equal(changes.size, 0);
});
test('cached nonowner cannot show another live owners busy logo', () => {
  const p = {
    ...project(),
    bindingState: 'cached' as const,
    connectionState: 'busy' as const,
    isStreaming: true,
  };
  assert.equal(
    renderChatApp(p).includes('working-logo'),
    false,
    'tabManager cached lastSnapshot retains busy; it is not live work for this binding'
  );
});
test('compiled controller refresh can publish ready plus current RPC streaming true; indicator must survive', async () => {
  const output = await build({
    entryPoints: ['src/sessions/sessionController.ts'],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    external: ['vscode'],
  });
  const mod = { exports: {} as any };
  const require = createRequire(process.cwd() + '/package.json');
  new Function('require', 'module', 'exports', output.outputFiles[0]!.text)(
    (name: string) => (name === 'vscode' ? {} : require(name)),
    mod,
    mod.exports
  );
  const c = Object.create(mod.exports.SessionController.prototype);
  c.state = {
    ...createInitialControllerState('fixture', '/tmp/fixture'),
    connectionState: 'ready',
    state: { sessionId: 'live' },
  };
  c.supervisor = {
    currentClient: { getState: async () => ({ sessionId: 'live', isStreaming: true }) },
  };
  c.fire = () => {};
  await c.refreshState();
  assert.equal(c.snapshot.connectionState, 'ready');
  assert.equal(c.snapshot.state.isStreaming, true);
  const p = createWebviewSnapshot(c.snapshot, 1, {
    composer,
    isTrusted: true,
    folders: [],
  });
  assert.ok(
    renderChatApp(p).includes('working-logo'),
    'current successful get_state streaming projection must retain working indicator'
  );
});
test.after(() => dom.window.close());

test('live binding defaults and terminal stale streaming use one gate', () => {
  for (const bindingState of [undefined, 'current'] as const) {
    for (const connectionState of ['busy', 'ready'] as const)
      assert.ok(
        renderChatApp({ ...project(), bindingState, connectionState, isStreaming: true }).includes(
          'working-logo'
        )
      );
  }
  for (const bindingState of ['cached', 'draft'] as const)
    assert.equal(
      renderChatApp({
        ...project(),
        bindingState,
        connectionState: 'busy',
        isStreaming: true,
      }).includes('working-logo'),
      false
    );
  for (const connectionState of ['starting', 'stopped', 'faulted'] as const)
    assert.equal(
      renderChatApp({ ...project(), connectionState, isStreaming: true }).includes('working-logo'),
      false
    );
});
