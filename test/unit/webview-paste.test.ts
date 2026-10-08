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
g.SVGElement = dom.window.SVGElement;
g.SVGSVGElement = dom.window.SVGSVGElement;
g.CSSStyleSheet = dom.window.CSSStyleSheet;
g.MutationObserver = dom.window.MutationObserver;
g.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
(dom.window.SVGElement.prototype as unknown as Record<string, unknown>).getBBox = () => ({
  x: 0,
  y: 0,
  width: 120,
  height: 40,
});
(dom.window.SVGElement.prototype as unknown as Record<string, unknown>).getComputedTextLength =
  () => 80;
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

test('Mermaid preview toggles, expands, closes with Escape, and restores focus', async () => {
  dom.window.dispatchEvent(
    new dom.window.MessageEvent('message', {
      data: {
        type: 'snapshot',
        snapshot: snapshot({
          messages: [
            {
              id: 'diagram',
              role: 'assistant',
              text: ['```mermaid', 'flowchart LR', 'A --> B', '```'].join('\n'),
              attachments: [],
            },
          ],
        }),
      },
    })
  );
  await waitFor(() => dom.window.document.querySelector('.mermaid-toggle') !== null, 'Mermaid UI');
  const wrap = dom.window.document.querySelector<HTMLElement>('.mermaid-wrap')!;
  const previewButton = wrap.querySelector<HTMLButtonElement>('[data-mermaid-mode="preview"]')!;
  previewButton.click();
  assert.equal(wrap.dataset.mermaidView, 'preview');
  assert.equal(wrap.querySelector<HTMLElement>('.mermaid-code')!.hidden, true);
  assert.equal(wrap.querySelector<HTMLElement>('.mermaid-preview')!.hidden, false);

  const expand = wrap.querySelector<HTMLButtonElement>('.mermaid-expand')!;
  await waitFor(
    () => Boolean(wrap.querySelector<HTMLImageElement>('.mermaid-image')?.src),
    'native Mermaid SVG'
  );
  const imageSrc = wrap.querySelector<HTMLImageElement>('.mermaid-image')!.src;
  assert.match(imageSrc, /^data:image\/svg\+xml/);
  assert.match(decodeURIComponent(imageSrc), /<svg/);
  assert.equal(expand.disabled, false);
  expand.click();
  const dialog = dom.window.document.getElementById('mermaid-dialog')!;
  assert.equal(dialog.hidden, false);
  assert.equal(dialog.querySelector<HTMLImageElement>('img')?.src, imageSrc);
  dialog.dispatchEvent(
    new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
  );
  assert.equal(dialog.hidden, true);
  assert.equal(dom.window.document.activeElement, expand);

  expand.click();
  assert.equal(dialog.hidden, false);
  dom.window.dispatchEvent(
    new dom.window.MessageEvent('message', {
      data: {
        type: 'snapshot',
        snapshot: snapshot({
          sequence: 2,
          sessionId: 'other',
          sessionFile: '/tmp/workspace/other.jsonl',
          messages: [
            {
              id: 'diagram',
              role: 'assistant',
              text: ['```mermaid', 'flowchart LR', 'A --> B', '```'].join('\n'),
              attachments: [],
            },
          ],
        }),
      },
    })
  );
  assert.equal(dialog.hidden, true, 'another chat cannot inherit an identical diagram preview');
});

test('malformed Mermaid shows an inline error and cannot expand', async () => {
  dom.window.dispatchEvent(
    new dom.window.MessageEvent('message', {
      data: {
        type: 'snapshot',
        snapshot: snapshot({
          sequence: 5,
          messages: [
            {
              id: 'broken-diagram',
              role: 'assistant',
              text: ['```mermaid', 'flowchart LR', 'A --', '```'].join('\n'),
              attachments: [],
            },
          ],
        }),
      },
    })
  );
  const wrap = dom.window.document.querySelector<HTMLElement>('.mermaid-wrap')!;
  wrap.querySelector<HTMLButtonElement>('[data-mermaid-mode="preview"]')!.click();
  await waitFor(
    () => !wrap.querySelector<HTMLElement>('.mermaid-error')!.hidden,
    'malformed Mermaid error'
  );
  assert.equal(wrap.querySelector('.mermaid-image'), null);
  assert.equal(wrap.querySelector<HTMLButtonElement>('.mermaid-expand')!.disabled, true);
});

test('Mermaid preview stays isolated as an SVG image', async () => {
  dom.window.dispatchEvent(
    new dom.window.MessageEvent('message', {
      data: {
        type: 'snapshot',
        snapshot: snapshot({
          sequence: 6,
          messages: [
            {
              id: 'safe-diagram',
              role: 'assistant',
              text: [
                '```mermaid',
                'flowchart LR',
                'A["<script>alert(1)</script>"] --> B',
                '```',
              ].join('\n'),
              attachments: [],
            },
          ],
        }),
      },
    })
  );
  const wrap = dom.window.document.querySelector<HTMLElement>('.mermaid-wrap')!;
  wrap.querySelector<HTMLButtonElement>('[data-mermaid-mode="preview"]')!.click();
  await waitFor(
    () => Boolean(wrap.querySelector<HTMLImageElement>('.mermaid-image')?.src),
    'isolated Mermaid SVG'
  );
  const svg = decodeURIComponent(wrap.querySelector<HTMLImageElement>('.mermaid-image')!.src);
  assert.doesNotMatch(svg, /<script|javascript:|onload=/i);
});

test('identical Mermaid blocks keep independent Preview state across snapshots', () => {
  const repeated = ['```mermaid', 'flowchart LR', 'A --> B', '```'].join('\n');
  const repeatedSnapshot = snapshot({
    sequence: 3,
    messages: [
      {
        id: 'duplicates',
        role: 'assistant',
        text: `${repeated}\n\n${repeated}`,
        attachments: [],
      },
    ],
  });
  dom.window.dispatchEvent(
    new dom.window.MessageEvent('message', {
      data: { type: 'snapshot', snapshot: repeatedSnapshot },
    })
  );
  const wraps = Array.from(dom.window.document.querySelectorAll<HTMLElement>('.mermaid-wrap'));
  assert.equal(wraps.length, 2);
  wraps[0]!.querySelector<HTMLButtonElement>('[data-mermaid-mode="preview"]')!.click();
  dom.window.dispatchEvent(
    new dom.window.MessageEvent('message', {
      data: { type: 'snapshot', snapshot: { ...repeatedSnapshot, sequence: 4 } },
    })
  );
  assert.deepEqual(
    Array.from(dom.window.document.querySelectorAll<HTMLElement>('.mermaid-wrap')).map(
      (wrap) => wrap.dataset.mermaidView
    ),
    ['preview', 'code']
  );
});

test("fresh-session details drawer keeps the user's collapsed state across snapshots", () => {
  const fresh = snapshot({
    sequence: 2,
    messages: [],
    messageCount: 0,
    runtime: { sdkVersion: '1.0.4', commands: 27, extensions: 1, prompts: 2, skills: 3 },
  });
  dom.window.dispatchEvent(
    new dom.window.MessageEvent('message', { data: { type: 'snapshot', snapshot: fresh } })
  );
  const drawer = dom.window.document.querySelector<HTMLDetailsElement>('#pi-session-details')!;
  assert.equal(drawer.open, true);
  drawer.open = false;
  dom.window.dispatchEvent(
    new dom.window.MessageEvent('message', {
      data: { type: 'snapshot', snapshot: { ...fresh, sequence: 3 } },
    })
  );
  assert.equal(
    dom.window.document.querySelector<HTMLDetailsElement>('#pi-session-details')?.open,
    false
  );
});

test('a failed work phase reopens after the user collapsed its live state', async () => {
  const live = snapshot({
    sequence: 100,
    connectionState: 'busy',
    isStreaming: true,
    currentAssistantMessageId: 'work',
    messages: [
      {
        id: 'work',
        role: 'assistant',
        text: '',
        blocks: [
          { kind: 'thinking', text: 'checking' },
          { kind: 'tool', name: 'bash', callId: 'call' },
        ],
        attachments: [],
      },
    ],
  });
  dom.window.dispatchEvent(
    new dom.window.MessageEvent('message', { data: { type: 'snapshot', snapshot: live } })
  );
  await waitFor(
    () => dom.window.document.querySelector('.work-phase') !== null,
    'live work phase render'
  );
  const phase = dom.window.document.querySelector<HTMLDetailsElement>('.work-phase')!;
  assert.equal(phase.open, true);
  phase.open = false;

  dom.window.dispatchEvent(
    new dom.window.MessageEvent('message', {
      data: {
        type: 'snapshot',
        snapshot: {
          ...live,
          sequence: 101,
          isStreaming: false,
          connectionState: 'ready',
          messages: [
            {
              ...live.messages[0]!,
              blocks: [
                { kind: 'thinking', text: 'checking' },
                { kind: 'tool', name: 'bash', callId: 'call' },
                {
                  kind: 'toolResult',
                  name: 'bash',
                  text: 'failed',
                  callId: 'call',
                  isError: true,
                },
              ],
            },
          ],
        },
      },
    })
  );

  const failed = dom.window.document.querySelector<HTMLDetailsElement>('.work-phase.is-error')!;
  assert.equal(failed.open, true);
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
