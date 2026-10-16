import assert from 'node:assert/strict';
import test from 'node:test';
import { buildChatListModel } from '../../src/webview/chatListData';
import { decideSnapshotPush } from '../../src/webview/chatListShared';
import { renderChatListShell } from '../../src/webview/chatListRowHtml';

const items = ['/projects/app', '/projects/app/nested', '/projects/application', '/other/app'].map(
  (cwd, index) => ({
    id: String(index),
    path: `/sessions/${index}.jsonl`,
    cwd,
    displayName: `Chat ${index}`,
    modifiedAt: index + 1,
    createdAt: 1,
    messageCount: 1,
    workspaceLabel: 'app',
  })
);
const input = {
  recent: { items, filterText: '', loading: false },
  openChats: [
    {
      resource: 'pi-chat:/same.chat',
      title: 'Chat 0',
      sessionFile: items[0]!.path,
      cwd: items[0]!.cwd,
      active: true,
    },
  ],
  folders: ['/projects/empty'],
};

test('folder filter matches exact owners, combines search and retains original JSONL targets', () => {
  const all = buildChatListModel(input);
  assert.equal(all.folders?.length, 5);
  const selected = buildChatListModel({ ...input, selectedFolder: '/projects/app/' });
  assert.deepEqual(
    selected.rows.map((row) => row.sessionPath),
    ['/sessions/0.jsonl']
  );
  assert.equal(selected.rows[0]!.openCommand.resource, 'pi-chat:/same.chat');
  assert.equal(selected.rows[0]!.active, true);
  assert.equal(
    buildChatListModel({
      ...input,
      selectedFolder: '/projects/app',
      recent: { ...input.recent, filterText: 'Chat 1' },
    }).rows.length,
    0
  );
  assert.equal(buildChatListModel({ ...input, selectedFolder: '/projects/empty' }).rows.length, 0);
  assert.equal(buildChatListModel({ ...input, selectedFolder: '/removed' }).selectedFolder, '');
  assert.equal(input.openChats[0]!.active, true);
});

test('folder options and selection repaint even with identical empty rows and escape labels', () => {
  const model = buildChatListModel({ ...input, selectedFolder: '/projects/empty' });
  const first = decideSnapshotPush(model, { hasShownRealData: false });
  assert.equal(decideSnapshotPush({ ...model, selectedFolder: '' }, first).push, true);
  assert.equal(decideSnapshotPush({ ...model, folders: [] }, first).push, true);
  const html = renderChatListShell('', '', {
    ...model,
    folders: [{ path: '/other/<app>', label: 'app — /other/<app>' }],
  });
  assert.ok(html.indexOf('chat-list-folder') < html.indexOf('chat-list-search'));
  assert.match(html, /Show chats from/);
  assert.match(html, /All folders/);
  assert.match(html, /&lt;app&gt;/);
});

test('Windows folder variants compare canonically while nested siblings remain separate', () => {
  const recent = {
    ...input.recent,
    items: items
      .slice(0, 2)
      .map((item, index) => ({ ...item, cwd: index ? 'C:\\Work\\App\\nested' : 'C:\\Work\\App' })),
  };
  const model = buildChatListModel({ openChats: [], recent, selectedFolder: 'c:/work/app/' });
  assert.deepEqual(
    model.rows.map((row) => row.sessionPath),
    ['/sessions/0.jsonl']
  );
});
