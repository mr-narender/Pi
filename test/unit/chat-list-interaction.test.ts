import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { buildChatListModel } from '../../src/webview/chatListData';

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

test('copied session UUIDs have distinct row identities and isolated open/delete actions', () => {
  const items = ['/project-a/copied.jsonl', '/project-b/copied.jsonl'].map((path, index) => ({
    id: 'copied-uuid',
    path,
    cwd: `/project-${index}`,
    workspaceLabel: `project-${index}`,
    displayName: `copy ${index}`,
    modifiedAt: index + 1,
    createdAt: 1,
    messageCount: 1,
  }));
  const model = buildChatListModel({
    openChats: [],
    recent: { loading: false, filterText: '', items },
  });
  assert.equal(new Set(model.rows.map((row) => row.id)).size, 2);
  dom.window.dispatchEvent(
    new dom.window.MessageEvent('message', { data: { type: 'listSnapshot', model } })
  );
  const rows = [...dom.window.document.querySelectorAll<HTMLElement>('.chat-list-row')];
  posted.length = 0;
  rows[0]!.click();
  assert.equal(posted.length, 1);
  assert.equal(posted[0]!.sessionPath, model.rows[0]!.sessionPath);
  posted.length = 0;
  rows[1]!.querySelector<HTMLButtonElement>('[data-act="delete"]')!.click();
  assert.deepEqual(posted, [{ type: 'deleteChat', sessionPath: model.rows[1]!.sessionPath }]);
});

test('sidebar folder selector precedes search and sends only a list filter message', () => {
  const model = buildChatListModel({
    openChats: [],
    recent: { loading: false, filterText: '', items: [] },
    folders: ['/projects/a', '/projects/b'],
    selectedFolder: '/projects/a',
  });
  dom.window.dispatchEvent(
    new dom.window.MessageEvent('message', {
      data: { type: 'listSnapshot', model },
    })
  );
  const select = dom.window.document.querySelector<HTMLSelectElement>('#chat-list-folder')!;
  assert.equal(select.value, '/projects/a');
  select.value = '/projects/b';
  posted.length = 0;
  select.dispatchEvent(new dom.window.Event('change'));
  assert.deepEqual(posted, [{ type: 'filterChatFolder', path: '/projects/b' }]);
  assert.equal(dom.window.document.querySelector('#folder-select'), null);
  const html = dom.window.document.getElementById('app')!.innerHTML;
  assert.ok(html.indexOf('chat-list-folder') < html.indexOf('chat-list-search'));
  assert.equal(
    model.selectedFolder,
    '/projects/a',
    'selection does not mutate the active snapshot'
  );
});
