// Executable regression test for the REAL webview paste path (reported live:
// "image is not getting pasted to the input as chip"). Loads the actual
// src/webview/media/chat.ts script in a jsdom window, renders a real snapshot,
// and dispatches synthetic paste events — asserting the exact messages the
// extension host would receive.
import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import type { WebviewSnapshot } from '../../src/state/types';

const posted: Array<Record<string, unknown>> = [];

const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', {
  pretendToBeVisual: true,
  url: 'https://webview.test/',
});

// The webview script reads these at import time — install before importing.
const g = globalThis as unknown as Record<string, unknown>;
g.window = dom.window;
g.document = dom.window.document;
// Node 26 ships a getter-only global navigator — override via defineProperty.
Object.defineProperty(globalThis, 'navigator', {
  value: dom.window.navigator,
  configurable: true,
});
g.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
g.FileReader = dom.window.FileReader;
g.File = dom.window.File;
g.Event = dom.window.Event;
g.MessageEvent = dom.window.MessageEvent;
g.HTMLElement = dom.window.HTMLElement;
g.HTMLTextAreaElement = dom.window.HTMLTextAreaElement;
g.MutationObserver = dom.window.MutationObserver;
g.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
// Webview-only APIs jsdom lacks — inert stubs are enough for the paste path.
g.ResizeObserver = class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
};
g.IntersectionObserver = class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
};
const matchMediaStub = () => ({
  matches: false,
  addEventListener(): void {},
  removeEventListener(): void {},
  addListener(): void {},
  removeListener(): void {},
});
g.matchMedia = matchMediaStub;
(dom.window as unknown as Record<string, unknown>).matchMedia = matchMediaStub;
(dom.window.HTMLElement.prototype as unknown as Record<string, unknown>).scrollTo = () => {};
(dom.window.HTMLElement.prototype as unknown as Record<string, unknown>).scrollIntoView = () => {};
g.acquireVsCodeApi = () => ({
  postMessage: (message: Record<string, unknown>) => {
    posted.push(message);
  },
  getState: () => undefined,
  setState: () => undefined,
});

function snapshot(overrides: Partial<WebviewSnapshot> = {}): WebviewSnapshot {
  return {
    sequence: 1,
    title: 'Current Chat',
    bindingState: 'current',
    connectionState: 'ready',
    workspaceFolderName: 'workspace',
    sessionName: 'Demo Session',
    sessionId: 'sid',
    sessionFile: '/tmp/workspace/session.jsonl',
    isStreaming: false,
    isCompacting: false,
    messageCount: 2,
    pendingMessageCount: 0,
    messages: [
      { id: 'm1', role: 'user', text: 'hello', attachments: [] },
      { id: 'm2', role: 'assistant', text: 'hi', attachments: [] },
    ],
    queue: { steering: [], followUp: [] },
    draft: '',
    statuses: { mode: 'active' },
    widgets: [],
    model: { provider: 'mock', id: 'model' },
    thinkingLevel: 'medium',
    pendingContextItems: [],
    pendingImages: [],
    focus: 'composer',
    isTrusted: true,
    folders: [{ name: 'workspace', uri: 'file:///tmp/workspace', active: true }],
    ...overrides,
  } as WebviewSnapshot;
}

function findComposer(): HTMLTextAreaElement {
  const textarea = dom.window.document.querySelector('textarea');
  assert.ok(textarea, 'composer textarea must exist after render');
  return textarea as HTMLTextAreaElement;
}

interface FakeClipboardItem {
  kind: string;
  type: string;
  getAsFile: () => File | null;
}

function pasteEvent(
  items: FakeClipboardItem[],
  data: Record<string, string>,
  files: File[] = []
): Event {
  const event = new dom.window.Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', {
    value: {
      items,
      files,
      getData: (type: string) => data[type] ?? '',
    },
  });
  return event;
}

async function waitFor(predicate: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${what}; posted=${JSON.stringify(posted)}`);
}

test('webview paste: real script renders and binds the composer', async () => {
  await import('../../src/webview/media/chat.js');
  dom.window.dispatchEvent(
    new dom.window.MessageEvent('message', {
      data: { type: 'snapshot', snapshot: snapshot() },
    })
  );
  await waitFor(() => dom.window.document.querySelector('textarea') !== null, 'composer render');
  findComposer();
});

test('webview paste: pasted IMAGE posts pasteImage with base64 payload (the reported bug)', async () => {
  posted.length = 0;
  const bytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]); // PNG magic
  const file = new dom.window.File([bytes], 'shot.png', { type: 'image/png' });
  const event = pasteEvent([{ kind: 'file', type: 'image/png', getAsFile: () => file }], {
    'text/plain': '',
  });
  findComposer().dispatchEvent(event);
  assert.equal(event.defaultPrevented, true, 'image paste must be intercepted');
  await waitFor(
    () => posted.some((message) => message.type === 'pasteImage'),
    'pasteImage message'
  );
  const message = posted.find((entry) => entry.type === 'pasteImage')!;
  assert.equal(message.mimeType, 'image/png');
  assert.equal(
    message.data,
    Buffer.from(bytes).toString('base64'),
    'payload must be the base64 image bytes'
  );
});

test('webview paste: pasted TEXT stays native — no chip message, default not prevented', () => {
  posted.length = 0;
  const big = 'x'.repeat(5000) + '\n'.repeat(50);
  const event = pasteEvent([{ kind: 'string', type: 'text/plain', getAsFile: () => null }], {
    'text/plain': big,
  });
  findComposer().dispatchEvent(event);
  assert.equal(event.defaultPrevented, false, 'text paste must fall through to the textarea');
  const content = posted.filter((message) => message.type !== 'diag');
  assert.equal(content.length, 0, 'no content message for text pastes of any size');
});

test('webview paste: image arriving ONLY via clipboard.files still chips (Electron delivers files with empty items)', async () => {
  posted.length = 0;
  const bytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const file = new dom.window.File([bytes], 'files-only.png', { type: 'image/png' });
  const event = pasteEvent([], {}, [file]);
  findComposer().dispatchEvent(event);
  assert.equal(event.defaultPrevented, true, 'files-only image paste must be intercepted');
  await waitFor(
    () => posted.some((message) => message.type === 'pasteImage'),
    'pasteImage message from clipboard.files fallback'
  );
  const message = posted.find((entry) => entry.type === 'pasteImage')!;
  assert.equal(message.mimeType, 'image/png');
  assert.equal(message.data, Buffer.from(bytes).toString('base64'));
});

test('webview paste: every paste posts a diag breadcrumb naming clipboard kinds (live debuggability)', async () => {
  posted.length = 0;
  const event = pasteEvent([{ kind: 'string', type: 'text/plain', getAsFile: () => null }], {
    'text/plain': 'hello',
  });
  findComposer().dispatchEvent(event);
  const diag = posted.find((message) => message.type === 'diag');
  assert.ok(diag, 'paste must post a diag breadcrumb');
  assert.equal(diag!.scope, 'paste');
  assert.match(String(diag!.detail), /string:text\/plain/);
});

test('webview paste: file URIs still attach as file chips', () => {
  posted.length = 0;
  const event = pasteEvent([{ kind: 'string', type: 'text/uri-list', getAsFile: () => null }], {
    'text/uri-list': 'file:///tmp/workspace/a.ts\nfile:///tmp/workspace/b.ts',
  });
  findComposer().dispatchEvent(event);
  assert.equal(event.defaultPrevented, true);
  const attached = posted.filter((message) => message.type === 'attachFile');
  assert.equal(attached.length, 2);
});

test('model frontend: IME does not execute; acknowledged command preserves newer text', () => {
  const textarea = findComposer();
  textarea.value = '/model';
  posted.length = 0;
  textarea.dispatchEvent(
    new dom.window.KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true })
  );
  assert.equal(posted.filter((m) => m.type === 'requestSend').length, 0);
  textarea.dispatchEvent(
    new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
  );
  assert.equal(textarea.value, '');
  textarea.value = 'newer input';
  dom.window.dispatchEvent(
    new dom.window.MessageEvent('message', {
      data: { type: 'snapshot', snapshot: snapshot({ draft: '', composerResetSeq: 1 }) },
    })
  );
  assert.equal(findComposer().value, 'newer input');
});

test('model frontend: completion first Enter selects; second Enter executes locally', () => {
  posted.length = 0;
  const textarea = findComposer();
  textarea.value = '/mod';
  textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  dom.window.dispatchEvent(
    new dom.window.MessageEvent('message', {
      data: { type: 'slashCommands', items: [{ name: 'model', description: 'Select a model' }] },
    })
  );
  textarea.dispatchEvent(
    new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
  );
  assert.equal(textarea.value.trim(), '');
  assert.equal(posted.filter((m) => m.type === 'requestSend').length, 1);
  textarea.dispatchEvent(
    new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
  );
  assert.equal(posted.filter((m) => m.type === 'requestSend').length, 1);
  assert.equal(textarea.value.trim(), '');
});

test('model frontend: identical retype and out-of-order correlated acknowledgements preserve edit intent', () => {
  const textarea = findComposer();
  const input = (text: string) => {
    textarea.value = text;
    textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  };
  const submit = () => {
    textarea.dispatchEvent(
      new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
    );
    textarea.dispatchEvent(
      new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    );
    return posted.filter((m) => m.type === 'requestSend').at(-1)!.submissionId as string;
  };
  const ack = (id: string, seq: number) =>
    dom.window.dispatchEvent(
      new dom.window.MessageEvent('message', {
        data: {
          type: 'snapshot',
          snapshot: snapshot({ draft: '', composerResetSeq: seq, localCommandAck: id }),
        },
      })
    );
  input('/model');
  const old = submit();
  input('');
  input('/model');
  ack(old, 20);
  assert.equal(findComposer().value, '/model');
  const newer = submit();
  ack(old, 21);
  assert.equal(findComposer().value, '');
  ack(newer, 22);
  assert.equal(findComposer().value, '');
  input('newer text');
  ack(old, 23);
  assert.equal(findComposer().value, 'newer text');
});

test('webview core safety: Enter retains a local command; ordinary prompts still clear', () => {
  const textarea = findComposer();
  for (const draft of ['/model', '/scoped-models', '/thinking high', '/quit']) {
    posted.length = 0;
    textarea.value = draft;
    textarea.dispatchEvent(
      new dom.window.KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true,
      })
    );
    assert.equal(
      textarea.value,
      ['/model', '/scoped-models'].includes(draft) ? '' : draft,
      'only bare menus consume invoking text'
    );
    assert.equal(posted.filter((message) => message.type === 'requestSend').length, 1);
  }
  textarea.value = 'ordinary prompt';
  textarea.dispatchEvent(
    new dom.window.KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    })
  );
  assert.equal(textarea.value, '', 'normal prompt atomic clear is unchanged');
});
