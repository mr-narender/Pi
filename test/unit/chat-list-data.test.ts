import assert from 'node:assert/strict';
import test from 'node:test';
import { buildChatListModel } from '../../src/webview/chatListData';

const baseRecent = { loading: false, filterText: '', items: [], sessionDir: '/tmp/sessions' };

test('buildChatListModel: open chats come first, active flag preserved', () => {
  const model = buildChatListModel({
    openChats: [
      { resource: 'a', title: 'Alpha', active: false, sessionFile: '/s/a.jsonl' },
      { resource: 'b', title: 'Beta', active: true, sessionFile: '/s/b.jsonl' },
    ],
    recent: baseRecent,
  });
  assert.equal(model.loading, false);
  assert.deepEqual(
    model.rows.map((r) => [r.title, r.active, r.isOpen]),
    [
      ['Alpha', false, true],
      ['Beta', true, true],
    ]
  );
});

test('buildChatListModel: recent sessions already open are excluded (no duplicates)', () => {
  const model = buildChatListModel({
    openChats: [{ resource: 'a', title: 'Alpha', active: true, sessionFile: '/s/a.jsonl' }],
    recent: {
      ...baseRecent,
      items: [
        { id: '1', path: '/s/a.jsonl', modifiedAt: 100, createdAt: 100 } as never,
        { id: '2', path: '/s/c.jsonl', modifiedAt: 200, createdAt: 200 } as never,
      ],
    },
  });
  assert.deepEqual(
    model.rows.map((r) => r.sessionPath),
    ['/s/a.jsonl', '/s/c.jsonl']
  );
});

test('buildChatListModel: recent rows never show NaN even with a malformed timestamp', () => {
  const model = buildChatListModel({
    openChats: [],
    recent: {
      ...baseRecent,
      items: [
        {
          id: '1',
          path: '/s/x.jsonl',
          modifiedAt: Number.NaN,
          createdAt: Number.NaN,
          workspaceLabel: 'workspace',
        } as never,
      ],
    },
    now: Date.UTC(2024, 0, 4),
  });
  assert.ok(!model.rows[0]?.detail?.includes('NaN'));
});

test('buildChatListModel: recent rows never carry active=true (only an open chat can be active)', () => {
  const model = buildChatListModel({
    openChats: [],
    recent: { ...baseRecent, items: [{ id: '1', path: '/s/x.jsonl', modifiedAt: 1, createdAt: 1 } as never] },
  });
  assert.equal(model.rows[0]?.active, false);
});

test('buildChatListModel: propagates loading/error state from the recent-sessions service', () => {
  assert.equal(buildChatListModel({ openChats: [], recent: { ...baseRecent, loading: true } }).loading, true);
  assert.equal(
    buildChatListModel({ openChats: [], recent: { ...baseRecent, error: 'boom' } }).error,
    'boom'
  );
});

test('buildChatListModel: open chats sort newest-first by joined session modifiedAt, not tab order', () => {
  const model = buildChatListModel({
    openChats: [
      { resource: 'old', title: 'Old', active: true, sessionFile: '/s/old.jsonl' },
      { resource: 'new', title: 'New', active: false, sessionFile: '/s/new.jsonl' },
    ],
    recent: {
      ...baseRecent,
      items: [
        { id: '1', path: '/s/old.jsonl', modifiedAt: 100, createdAt: 50 } as never,
        { id: '2', path: '/s/new.jsonl', modifiedAt: 900, createdAt: 800 } as never,
      ],
    },
  });
  assert.deepEqual(
    model.rows.map((r) => r.title),
    ['New', 'Old']
  );
});

test('buildChatListModel: open chat with unknown time (not in recents) sorts to top of open block', () => {
  const model = buildChatListModel({
    openChats: [
      { resource: 'known', title: 'Known', active: false, sessionFile: '/s/known.jsonl' },
      { resource: 'fresh', title: 'Fresh', active: true, sessionFile: '/s/fresh.jsonl' },
      { resource: 'untracked', title: 'Untracked', active: false },
    ],
    recent: {
      ...baseRecent,
      items: [{ id: '1', path: '/s/known.jsonl', modifiedAt: 500, createdAt: 500 } as never],
    },
  });
  // fresh + untracked have no known time -> top (stable: tab order between them), known last.
  assert.deepEqual(
    model.rows.map((r) => r.title),
    ['Fresh', 'Untracked', 'Known']
  );
});

test('buildChatListModel: open block stays above history even when a recent is newer', () => {
  const model = buildChatListModel({
    openChats: [{ resource: 'a', title: 'OpenOld', active: true, sessionFile: '/s/a.jsonl' }],
    recent: {
      ...baseRecent,
      items: [
        { id: '1', path: '/s/a.jsonl', modifiedAt: 10, createdAt: 10 } as never,
        { id: '2', path: '/s/b.jsonl', modifiedAt: 99999, createdAt: 99999 } as never,
      ],
    },
  });
  assert.deepEqual(
    model.rows.map((r) => [r.title, r.isOpen]),
    [
      ['OpenOld', true],
      ['Untitled chat', false],
    ]
  );
});

test('buildChatListModel: malformed open-chat timestamps (NaN/0) treated as unknown, no crash', () => {
  const model = buildChatListModel({
    openChats: [
      { resource: 'k', title: 'Known', active: false, sessionFile: '/s/k.jsonl' },
      { resource: 'n', title: 'NaNTime', active: false, sessionFile: '/s/n.jsonl' },
    ],
    recent: {
      ...baseRecent,
      items: [
        { id: '1', path: '/s/k.jsonl', modifiedAt: 500, createdAt: 500 } as never,
        { id: '2', path: '/s/n.jsonl', modifiedAt: Number.NaN, createdAt: 0 } as never,
      ],
    },
  });
  assert.deepEqual(
    model.rows.map((r) => r.title),
    ['NaNTime', 'Known']
  );
});

test('buildChatListModel: generic "Session N" name is demoted to the first-prompt preview', () => {
  const model = buildChatListModel({
    openChats: [],
    recent: {
      ...baseRecent,
      items: [
        {
          id: '1',
          path: '/s/a.jsonl',
          modifiedAt: 100,
          createdAt: 100,
          sessionName: 'Session 36',
          displayName: 'Session 36',
          firstPromptPreview: 'fix the login redirect bug',
        } as never,
      ],
    },
  });
  assert.equal(model.rows[0]?.title, 'fix the login redirect bug');
});

test('buildChatListModel: a genuine custom rename still beats the preview', () => {
  const model = buildChatListModel({
    openChats: [],
    recent: {
      ...baseRecent,
      items: [
        {
          id: '1',
          path: '/s/a.jsonl',
          modifiedAt: 100,
          createdAt: 100,
          sessionName: 'Auth refactor',
          displayName: 'Auth refactor',
          firstPromptPreview: 'fix the login redirect bug',
        } as never,
      ],
    },
  });
  assert.equal(model.rows[0]?.title, 'Auth refactor');
});

test('buildChatListModel: generic name with NO preview falls back to the generic name', () => {
  const model = buildChatListModel({
    openChats: [],
    recent: {
      ...baseRecent,
      items: [
        {
          id: '1',
          path: '/s/a.jsonl',
          modifiedAt: 100,
          createdAt: 100,
          sessionName: 'Session 7',
          displayName: 'Session 7',
        } as never,
      ],
    },
  });
  assert.equal(model.rows[0]?.title, 'Session 7');
});

test('buildChatListModel: open rows use the joined session name over the raw tab title', () => {
  const model = buildChatListModel({
    openChats: [{ resource: 'a', title: 'Session 36', active: true, sessionFile: '/s/a.jsonl' }],
    recent: {
      ...baseRecent,
      items: [
        {
          id: '1',
          path: '/s/a.jsonl',
          modifiedAt: 100,
          createdAt: 100,
          sessionName: 'Session 36',
          displayName: 'Session 36',
          firstPromptPreview: 'explain the build pipeline',
        } as never,
      ],
    },
  });
  assert.deepEqual(
    model.rows.map((r) => [r.title, r.isOpen]),
    [['explain the build pipeline', true]]
  );
});

test('buildChatListModel: open row keeps tab title when the record resolves to nothing better', () => {
  const model = buildChatListModel({
    openChats: [{ resource: 'a', title: 'Session 2', active: true, sessionFile: '/s/a.jsonl' }],
    recent: {
      ...baseRecent,
      items: [{ id: '1', path: '/s/a.jsonl', modifiedAt: 100, createdAt: 100 } as never],
    },
  });
  assert.equal(model.rows[0]?.title, 'Session 2');
});

test('buildChatListModel: favorites float to the top of each block, newest-first within groups', () => {
  const model = buildChatListModel({
    openChats: [
      { resource: 'o1', title: 'OpenNew', active: true, sessionFile: '/s/o1.jsonl' },
      { resource: 'o2', title: 'OpenFav', active: false, sessionFile: '/s/o2.jsonl' },
    ],
    recent: {
      ...baseRecent,
      items: [
        { id: '1', path: '/s/o1.jsonl', modifiedAt: 900, createdAt: 900 } as never,
        { id: '2', path: '/s/o2.jsonl', modifiedAt: 100, createdAt: 100 } as never,
        { id: '3', path: '/s/r1.jsonl', modifiedAt: 800, createdAt: 800, displayName: 'RecNew' } as never,
        { id: '4', path: '/s/r2.jsonl', modifiedAt: 50, createdAt: 50, displayName: 'RecFav' } as never,
      ],
    },
    favorites: new Set(['/s/o2.jsonl', '/s/r2.jsonl']),
  });
  assert.deepEqual(
    model.rows.map((r) => [r.title, r.favorite]),
    [
      ['OpenFav', true],
      ['OpenNew', false],
      ['RecFav', true],
      ['RecNew', false],
    ]
  );
});

test('buildChatListModel: a favorited recent survives the 20-row cap', () => {
  const items = Array.from({ length: 25 }, (_, i) => ({
    id: `s${i}`,
    path: `/s/s${i}.jsonl`,
    modifiedAt: 1000 - i,
    createdAt: 1000 - i,
    displayName: `Chat ${i}`,
  })) as never[];
  const model = buildChatListModel({
    openChats: [],
    recent: { ...baseRecent, items },
    favorites: new Set(['/s/s24.jsonl']),
  });
  assert.equal(model.rows.length, 20);
  assert.deepEqual(model.rows[0] && [model.rows[0].title, model.rows[0].favorite], ['Chat 24', true]);
  assert.equal(model.rows[1]?.title, 'Chat 0');
});
