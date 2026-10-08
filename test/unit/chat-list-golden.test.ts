// GOLDEN-HTML contract tests for the chat-list webview markup — same harness
// contract as render-golden.test.ts. The 0.1.0 name-squeeze regression (action
// strip permanently reserving row width) shipped because this markup had zero
// coverage; these pins make any structural change to a chat-list row an
// explicit, reviewed diff.
//
// Update intentionally with:  UPDATE_GOLDEN=1 npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import {
  SIZE_WARN_BYTES,
  renderChatListBody,
  renderChatListRow,
  renderChatListShell,
} from '../../src/webview/chatListRowHtml';
import type { ChatListRow } from '../../src/webview/chatListShared';

const goldenDir = join(process.cwd(), 'test', 'unit', '__golden__');

function checkGolden(name: string, html: string): void {
  const file = join(goldenDir, `${name}.html`);
  if (process.env.UPDATE_GOLDEN === '1') {
    mkdirSync(goldenDir, { recursive: true });
    writeFileSync(file, html, 'utf8');
    return;
  }
  const expected = readFileSync(file, 'utf8');
  assert.equal(
    html,
    expected,
    `golden mismatch for ${name} — review the diff; if intentional run UPDATE_GOLDEN=1 npm run test:unit`
  );
}

function row(overrides: Partial<ChatListRow> = {}): ChatListRow {
  return {
    id: 'recent:1',
    title: 'fix the login redirect bug',
    active: false,
    isOpen: false,
    openCommand: { sessionPath: '/s/a.jsonl', label: 'fix the login redirect bug' },
    sessionPath: '/s/a.jsonl',
    ...overrides,
  };
}

test('golden: chat-list row — active open chat', () => {
  checkGolden(
    'chat-list-row-active-open',
    renderChatListRow(
      row({
        id: 'open:pi-chat://one',
        title: 'explain the build pipeline',
        active: true,
        isOpen: true,
        openCommand: { resource: 'pi-chat://one' },
      })
    )
  );
});

const NOW = Date.UTC(2024, 0, 4, 12, 0, 0);

test('golden: chat-list row — favorite with detail (badge + filled star + paint-time "5m ago")', () => {
  checkGolden(
    'chat-list-row-favorite',
    renderChatListRow(
      row({ favorite: true, detail: 'workspace', modifiedAt: NOW - 5 * 60_000 }),
      NOW
    )
  );
});

test('golden: chat-list row — fresh draft (no session file → delete only)', () => {
  checkGolden(
    'chat-list-row-draft',
    renderChatListRow(
      row({
        id: 'open:pi-chat://draft',
        title: 'Session 2',
        isOpen: true,
        openCommand: { resource: 'pi-chat://draft' },
        sessionPath: undefined,
      })
    )
  );
});

test('golden: chat-list row — hostile title is escaped everywhere it appears', () => {
  checkGolden(
    'chat-list-row-escaped',
    renderChatListRow(
      row({
        title: `<img src=x onerror=alert(1)> & "quoted" 'single'`,
        detail: '<b>ws</b>',
        modifiedAt: NOW - 60_000,
      }),
      NOW
    )
  );
});

test('golden: chat-list body — loading / error / empty states', () => {
  checkGolden('chat-list-body-loading', renderChatListBody({ rows: [], loading: true }));
  checkGolden(
    'chat-list-body-error',
    renderChatListBody({ rows: [], loading: false, error: 'scan failed: <EACCES>' })
  );
  checkGolden('chat-list-body-empty', renderChatListBody({ rows: [], loading: false }));
});

test('chat-list body keeps available rows visible during a refresh', () => {
  const html = renderChatListBody({ rows: [row({ isOpen: true })], loading: true }, { now: NOW });
  assert.match(html, /chat-list-row/);
  assert.doesNotMatch(html, /Loading chats/);
});

test('golden: chat-list shell wrapping a populated body (with search box)', () => {
  const body = renderChatListBody(
    {
      rows: [
        row({ id: 'open:pi-chat://one', title: 'OpenChat', active: true, isOpen: true }),
        row({ favorite: true, detail: 'workspace', modifiedAt: NOW - 2 * 60 * 60_000 }),
      ],
      loading: false,
    },
    { now: NOW }
  );
  checkGolden('chat-list-shell-populated', renderChatListShell(body));
});

test('chat-list body groups open and recent sessions into inset lists', () => {
  const html = renderChatListBody(
    {
      rows: [
        row({ id: 'open:pi-chat://one', title: 'Open chat', active: true, isOpen: true }),
        row({ id: 'recent:one', title: 'Recent chat', isOpen: false }),
      ],
      loading: false,
    },
    { now: NOW }
  );
  const dom = new JSDOM(html);
  try {
    const groups = [...dom.window.document.querySelectorAll('.chat-list-group')];
    assert.deepEqual(
      groups.map((group) => group.getAttribute('aria-label')),
      ['Open chats', 'Recent chats']
    );
    assert.deepEqual(
      groups.map((group) => group.querySelectorAll('.chat-list-row').length),
      [1, 1]
    );
    assert.equal(dom.window.document.querySelectorAll('.chat-list-section-label').length, 2);
  } finally {
    dom.window.close();
  }
});

test('golden: chat-list body — empty while a search filter is active', () => {
  checkGolden(
    'chat-list-body-filtered-empty',
    renderChatListBody({ rows: [], loading: false }, { filterActive: true })
  );
});

test('Agentic New Chat and More sit beside π: Chat in the native view header', () => {
  const shell = renderChatListShell('');
  assert.ok(!shell.includes('chat-list-toolbar'));
  assert.ok(!shell.includes('>Chats</span>'));
  assert.ok(!shell.includes('id="new-chat-btn"'));
  assert.ok(!shell.includes('sb-more'));
  const manifest = JSON.parse(
    readFileSync(join(process.cwd(), 'package.json'), 'utf8')
  ).contributes;
  const when = 'view == piRpc.chat';
  assert.deepEqual(
    manifest.menus['view/title'].filter((item: { when: string }) => item.when === when),
    [
      { command: 'piRpc.newSession', when, group: 'navigation@1' },
      { submenu: 'piRpc.agenticActions', when, group: 'navigation@2' },
    ]
  );
  assert.equal(
    manifest.commands.find((item: { command: string }) => item.command === 'piRpc.newSession').icon,
    '$(comment-add)'
  );
  assert.deepEqual(
    manifest.menus['piRpc.agenticActions'].map(
      (item: { group: string }) => item.group.split('@')[0]
    ),
    [
      '1_chat',
      '1_chat',
      '1_chat',
      '1_chat',
      '2_configure',
      '2_configure',
      '2_configure',
      '2_configure',
      '2_configure',
      '2_configure',
      '3_system',
      '3_system',
    ]
  );
  assert.deepEqual(
    manifest.menus['piRpc.agenticActions'].map((item: { command: string }) => item.command),
    [
      'piRpcInternal.agenticChatHeading',
      'piRpc.reviewLastTurn',
      'piRpc.showChatVersions',
      'piRpc.exportHtml',
      'piRpcInternal.agenticConfigureHeading',
      'piRpc.manageExtensions',
      'piRpc.manageSkills',
      'piRpc.managePrompts',
      'piRpc.manageAgentInstructions',
      'piRpcInternal.setWorkingAnimation',
      'piRpcInternal.agenticSystemHeading',
      'piRpcInternal.restart',
    ]
  );
  const more = manifest.submenus.find((item: { id: string }) => item.id === 'piRpc.agenticActions');
  assert.equal(more.label, 'More actions');
  assert.equal(more.icon, '$(ellipsis)');
  assert.ok(
    !manifest.commands.some(
      (item: { command: string }) => item.command === 'piRpcInternal.showChatInSidebar'
    )
  );
  assert.ok(!manifest.configuration.properties['piRpc.agenticTheme']);
});

test('Agentic native section labels are disabled, flat, first in each group, and palette-hidden', () => {
  const manifest = JSON.parse(
    readFileSync(join(process.cwd(), 'package.json'), 'utf8')
  ).contributes;
  const headings = [
    ['piRpcInternal.agenticChatHeading', 'Chat', '1_chat@0'],
    ['piRpcInternal.agenticConfigureHeading', 'Configure', '2_configure@0'],
    ['piRpcInternal.agenticSystemHeading', 'System', '3_system@0'],
  ];
  const items = manifest.menus['piRpc.agenticActions'];
  assert.ok(
    items.every((item: { submenu?: string }) => !item.submenu),
    'no nested submenus'
  );
  for (const [id, title, group] of headings) {
    const command = manifest.commands.find((item: { command: string }) => item.command === id);
    assert.ok(command, `${title} label must be contributed`);
    assert.equal(command.title, title);
    assert.equal(command.enablement, 'false', 'label must never be selectable');
    assert.equal(command.icon, undefined);
    assert.deepEqual(
      items.find((item: { group: string }) => item.group.startsWith(group!.split('@')[0]!)),
      { command: id, group }
    );
    assert.ok(
      manifest.menus.commandPalette.some(
        (item: { command: string; when: string }) => item.command === id && item.when === 'false'
      ),
      'label must not become a palette action'
    );
  }
  assert.ok(!JSON.stringify(manifest.menus['piRpc.chatActions']).includes('Heading'));
  assert.equal(manifest.views.piRpc[0].name, 'Chat', 'π: Chat view title stays unchanged');
});

test('chat-list shell: filter text is escaped into the search input value', () => {
  const html = renderChatListShell('<div></div>', `"><script>alert(1)</script>`);
  assert.ok(!html.includes('<script>'), 'raw script must not appear');
  assert.ok(html.includes('value="&quot;&gt;&lt;script&gt;'), 'escaped value expected');
});

test('hostile chat title and filter remain text when parsed by the browser', () => {
  const title = `<img src=x onerror="alert(1)"> 'chat'`;
  const filter = `"><script>alert(2)</script><svg onload="alert(3)">`;
  const html = renderChatListShell(
    renderChatListBody({ rows: [row({ title, detail: '<b>project</b>' })], loading: false }),
    filter
  );
  const dom = new JSDOM(html);
  try {
    const document = dom.window.document;
    assert.equal(document.querySelectorAll('img, script, [onerror], [onload]').length, 0);
    assert.equal(document.querySelector('.chat-list-row-title')?.textContent, title);
    assert.equal(document.querySelector('.chat-list-row-detail')?.textContent, '<b>project</b>');
    assert.equal(document.querySelector<HTMLInputElement>('#chat-list-search')?.value, filter);
  } finally {
    dom.window.close();
  }
});

test('golden: chat-list row — oversized session paints the size warning', () => {
  checkGolden(
    'chat-list-row-oversized',
    renderChatListRow(
      row({ detail: 'workspace', modifiedAt: NOW - 60_000, sizeBytes: 113 * 1024 * 1024 }),
      NOW
    )
  );
});

test('chat-list row: sizes under the warning threshold stay silent', () => {
  const html = renderChatListRow(
    row({ sizeBytes: SIZE_WARN_BYTES - 1, modifiedAt: NOW - 60_000 }),
    NOW
  );
  assert.ok(!html.includes('size-warn'));
  const exact = renderChatListRow(
    row({ sizeBytes: SIZE_WARN_BYTES, modifiedAt: NOW - 60_000 }),
    NOW
  );
  assert.ok(exact.includes('size-warn') && exact.includes('50 MB'));
});

test('chat-list row: stale/invalid modifiedAt renders no time fragment at all', () => {
  const nan = renderChatListRow(row({ detail: 'workspace', modifiedAt: Number.NaN }), NOW);
  assert.ok(!nan.includes('NaN') && !nan.includes('Unknown'));
  assert.ok(nan.includes('>workspace<'), 'label alone survives');
  const zero = renderChatListRow(row({ modifiedAt: 0 }), NOW);
  assert.ok(!zero.includes('chat-list-row-detail'), 'no detail span when nothing to show');
});

test('chat-list row: hover strip carries exactly the expected actions in order', () => {
  // Structural guard independent of the golden bytes: changes → favorite →
  // rename → delete for a persisted row; changes → delete for a draft.
  const acts = (html: string): string[] =>
    [...html.matchAll(/data-act="([a-z]+)"/g)].map((m) => m[1]!);
  assert.deepEqual(acts(renderChatListRow(row())), ['changes', 'favorite', 'rename', 'delete']);
  assert.deepEqual(
    acts(renderChatListRow(row({ sessionPath: undefined, openCommand: { resource: 'r' } }))),
    ['changes', 'delete']
  );
  const html = renderChatListRow(row({ title: 'Chat name' }));
  assert.ok(html.includes('data-tooltip="Chat name"'));
  assert.ok(!html.includes('title="Chat name"'), 'avoid native + custom duplicate tooltip');
});
