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
test('Agentic menu dismisses outside/Escape and row actions target trusted row IDs', async () => {
  try {
    await import('../../src/webview/media/chatList.js');
  } finally {
    globalThis.setInterval = interval;
  }
  const { document, MessageEvent, Event } = dom.window;
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
  const menu = document.querySelector<HTMLDetailsElement>('.sb-more')!;
  menu.open = true;
  document
    .querySelector('#chat-list-search')!
    .dispatchEvent(new Event('pointerdown', { bubbles: true }));
  assert.equal(menu.open, false);
  menu.open = true;
  document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(menu.open, false);
  document.querySelector<HTMLButtonElement>('#new-chat-btn')!.click();
  document.querySelector<HTMLButtonElement>('#switch-chat-btn')!.click();
  document.querySelector<HTMLButtonElement>('[data-act="changes"]')!.click();
  document.querySelector<HTMLButtonElement>('[data-agentic-theme]')!.click();
  assert.deepEqual(posted.slice(-4), [
    { type: 'newChat' },
    { type: 'switchSidebarMode' },
    { type: 'showChatChanges', rowId: 'recent:one' },
    { type: 'chooseAgenticTheme' },
  ]);
  dom.window.dispatchEvent(
    new MessageEvent('message', { data: { type: 'agenticTheme', theme: 'lime-mint' } })
  );
  assert.equal(document.body.dataset.agenticTheme, 'lime-mint');
  dom.window.dispatchEvent(
    new MessageEvent('message', { data: { type: 'agenticTheme', theme: '<script>' } })
  );
  assert.equal(document.body.dataset.agenticTheme, 'system');
});
