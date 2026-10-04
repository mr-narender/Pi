import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import type { ChatListModel } from '../../src/webview/chatListShared';

test('Agentic list hides a delete on click, resists stale snapshots, and restores on failure', async () => {
  const browser = await build({
    entryPoints: ['src/webview/media/chatList.ts'],
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
  });
  const dom = new JSDOM('<div id="app"></div>', {
    pretendToBeVisual: true,
    runScripts: 'outside-only',
  });
  const posted: unknown[] = [];
  Object.assign(dom.window, {
    acquireVsCodeApi: () => ({ postMessage: (message: unknown) => posted.push(message) }),
  });
  const model: ChatListModel = {
    loading: false,
    rows: [
      {
        id: 'recent:a',
        title: 'A',
        active: false,
        isOpen: false,
        sessionPath: '/s/a.jsonl',
        openCommand: { sessionPath: '/s/a.jsonl' },
      },
    ],
  };
  const send = (data: unknown) =>
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data }));
  const rows = () => dom.window.document.querySelectorAll('.chat-list-row');
  try {
    dom.window.eval(browser.outputFiles[0]!.text);
    send({ type: 'listSnapshot', model });
    assert.equal(rows().length, 1);
    dom.window.document.querySelector<HTMLButtonElement>('[data-act="delete"]')!.click();
    assert.equal(rows().length, 0, 'the row disappears before the host finishes');
    assert.deepEqual(JSON.parse(JSON.stringify(posted.at(-1))), {
      type: 'deleteChat',
      sessionPath: '/s/a.jsonl',
    });
    send({ type: 'listSnapshot', model });
    assert.equal(rows().length, 0, 'an old scan snapshot does not resurrect the row');
    send({ type: 'deleteFailed', id: '/s/a.jsonl' });
    assert.equal(rows().length, 1, 'a refused close or file error restores the row');

    dom.window.document.querySelector<HTMLButtonElement>('[data-act="delete"]')!.click();
    send({ type: 'deleteSucceeded', id: '/s/a.jsonl' });
    assert.equal(rows().length, 0, 'success remains hidden until fresh data arrives');
    send({ type: 'listSnapshot', model: { rows: [], loading: false } });
    assert.equal(rows().length, 0);
  } finally {
    dom.window.close();
  }
});
