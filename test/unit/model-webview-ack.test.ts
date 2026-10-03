import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import type { WebviewSnapshot } from '../../src/state/types';

// Each fixture evaluates the actual frontend bundle in a NEW webview generation.
const bundle = build({
  entryPoints: ['src/webview/media/chat.ts'],
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'iife',
});

async function frame() {
  const dom = new JSDOM('<div id="app"></div>', {
    pretendToBeVisual: true,
    url: 'https://webview.test/',
    runScripts: 'outside-only',
  });
  const w = dom.window;
  const posted: Array<Record<string, unknown>> = [];
  Object.assign(w, {
    acquireVsCodeApi: () => ({
      postMessage: (message: Record<string, unknown>) => posted.push(message),
      getState() {},
      setState() {},
    }),
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
  });
  w.HTMLElement.prototype.scrollTo = () => {};
  w.HTMLElement.prototype.scrollIntoView = () => {};
  w.eval((await bundle).outputFiles[0]!.text);
  const snapshot = {
    sequence: 1,
    title: 'Chat',
    bindingState: 'current',
    uiMode: 'simple',
    connectionState: 'ready',
    workspaceFolderName: 'workspace',
    sessionId: 'sid',
    sessionFile: '/tmp/workspace/session.jsonl',
    isStreaming: false,
    isCompacting: false,
    messageCount: 0,
    pendingMessageCount: 0,
    messages: [],
    queue: { steering: [], followUp: [] },
    draft: '',
    statuses: {},
    widgets: [],
    model: { provider: 'mock', id: 'model' },
    thinkingLevel: 'medium',
    pendingContextItems: [],
    pendingImages: [],
    focus: 'composer',
    isTrusted: true,
    folders: [],
  } as WebviewSnapshot;
  const send = (overrides: Partial<WebviewSnapshot> = {}) =>
    w.dispatchEvent(
      new w.MessageEvent('message', {
        data: { type: 'snapshot', snapshot: { ...snapshot, ...overrides } },
      })
    );
  const composer = () => w.document.querySelector('textarea')!;
  const input = (text: string) => {
    composer().focus();
    composer().value = text;
    composer().dispatchEvent(new w.Event('input', { bubbles: true }));
  };
  const submit = () => {
    composer().dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    composer().dispatchEvent(
      new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    );
    return posted.filter((m) => m.type === 'requestSend').at(-1)!.submissionId as string;
  };
  return { dom, posted, send, composer, input, submit };
}

test('fresh webview edit survives previous-generation model acknowledgement', async () => {
  const f = await frame();
  try {
    f.send();
    f.input('/model new draft');
    f.send({ sequence: 2, composerResetSeq: 99, localCommandAck: 'previous-webview-generation:1' });
    assert.equal(f.composer().value, '/model new draft');
    // The rejected ack must not mark the local edit as rendered/clean either.
    f.send({ draft: '', composerResetSeq: 1 });
    assert.equal(f.composer().value, '/model new draft');
    f.input('/model still new');
    assert.equal(f.posted.filter((m) => m.type === 'setDraft').at(-1)!.resetSeq, 1);
  } finally {
    f.dom.window.close();
  }
});

test('current model ack clears; replay cannot reset newer unfocused input or bookkeeping', async () => {
  const f = await frame();
  try {
    f.send();
    f.input('/model');
    const id = f.submit();
    f.send({ draft: '', composerResetSeq: 1, localCommandAck: id });
    assert.equal(f.composer().value, '');
    f.input('new input');
    f.composer().blur();
    f.send({
      draft: '',
      composerResetSeq: 99,
      localCommandAck: id,
      model: { provider: 'mock', id: 'updated' },
    });
    assert.equal(f.composer().value, 'new input');
    assert.match(f.dom.window.document.body.textContent!, /updated/);
    f.input('still new');
    assert.equal(f.posted.filter((m) => m.type === 'setDraft').at(-1)!.resetSeq, 1);
  } finally {
    f.dom.window.close();
  }
});

test('unknown ack without a reset cannot erase chips or unfocused draft', async () => {
  const f = await frame();
  try {
    f.send({
      pendingImages: [{ itemId: 'img', name: 'retained.png', mimeType: 'image/png', sizeBytes: 1 }],
    });
    f.input('new draft');
    f.composer().blur();
    f.send({ draft: 'obsolete draft', localCommandAck: 'unknown:1', pendingImages: [] });
    assert.equal(f.composer().value, 'new draft');
    assert.match(f.dom.window.document.body.textContent!, /retained.png/);
  } finally {
    f.dom.window.close();
  }
});

test('wrong owner ack cannot clear the originating draft', async () => {
  const f = await frame();
  try {
    f.send();
    f.input('/model');
    const id = f.submit();
    f.send({ sessionFile: '/tmp/other.jsonl', composerResetSeq: 99, localCommandAck: id });
    assert.equal(
      f.composer().value,
      '',
      'a wrong-owner reply cannot restore consumed command text'
    );
  } finally {
    f.dom.window.close();
  }
});

test('ordinary initial hydration and authoritative reset still work', async () => {
  const f = await frame();
  try {
    f.send({ draft: 'restored draft', composerResetSeq: 7 });
    assert.equal(f.composer().value, 'restored draft');
    f.input('ordinary input');
    f.send({ draft: '', composerResetSeq: 8 });
    assert.equal(f.composer().value, '');
    f.input('ordinary prompt');
    f.submit();
    assert.equal(f.composer().value, '');
  } finally {
    f.dom.window.close();
  }
});
