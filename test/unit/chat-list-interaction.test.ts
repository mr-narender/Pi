import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', {
  url: 'https://webview.test/',
});
const posted: Array<Record<string, unknown>> = [];
const globals = globalThis as unknown as Record<string, unknown>;
globals.window = dom.window;
globals.document = dom.window.document;
globals.Node = dom.window.Node;
globals.HTMLElement = dom.window.HTMLElement;
globals.acquireVsCodeApi = () => ({
  postMessage: (message: Record<string, unknown>) => posted.push(message),
});
const interval = globalThis.setInterval;
globalThis.setInterval = ((callback: () => void, delay: number) => {
  const timer = interval(callback, delay);
  timer.unref();
  return timer;
}) as typeof setInterval;
test('Agentic view relies on native title actions and row actions target trusted row IDs', async () => {
  try {
    await import('../../src/webview/media/chatList.js');
  } finally {
    globalThis.setInterval = interval;
  }
  const { document, MessageEvent } = dom.window;
  dom.window.dispatchEvent(
    new MessageEvent('message', {
      data: {
        type: 'listSnapshot',
        model: {
          loading: false,
          rows: [
            {
              id: 'recent:one',
              title: 'Chat',
              active: false,
              isOpen: false,
              sessionPath: '/sessions/one.jsonl',
              openCommand: { sessionPath: '/sessions/one.jsonl' },
            },
          ],
        },
      },
    })
  );
  assert.equal(document.querySelector('.chat-list-toolbar'), null);
  assert.equal(document.querySelector('.sb-more'), null);
  assert.equal(document.querySelector('#new-chat-btn'), null);
  document.querySelector<HTMLButtonElement>('[data-act="changes"]')!.click();
  assert.deepEqual(posted.at(-1), { type: 'showChatChanges', rowId: 'recent:one' });
  assert.equal(document.body.hasAttribute('data-agentic-theme'), false);
});
