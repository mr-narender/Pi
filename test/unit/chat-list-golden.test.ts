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
import {
  SIZE_WARN_BYTES,
  renderChatListBody,
  renderChatListRow,
  renderChatListShell,
} from '../../src/webview/chatListRowHtml';
import type { ChatListRow } from '../../src/webview/chatListShared';
import {
  CHAT_ACTION_COMMANDS,
  isChatActionCommand,
  renderChatActionsMenu,
} from '../../src/webview/chatActionsMenu';

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

test('golden: chat-list body — empty while a search filter is active', () => {
  checkGolden(
    'chat-list-body-filtered-empty',
    renderChatListBody({ rows: [], loading: false }, { filterActive: true })
  );
});

test('Agentic menu shares Chat mode markup and accepts only its eight actions', () => {
  const menu = renderChatActionsMenu(true);
  assert.ok(renderChatListShell('').includes(menu), 'Agentic shell uses the shared dropdown');
  assert.ok(menu.includes('data-agentic-theme'), 'theme picker appears in Agentic only');
  assert.ok(!renderChatActionsMenu().includes('data-agentic-theme'), 'Chat mode is unchanged');
  assert.deepEqual(
    [...menu.matchAll(/class="menu-group">([^<]+)/g)].map((m) => m[1]),
    ['Chat', 'Configure', 'System']
  );
  assert.deepEqual(
    [...menu.matchAll(/data-command="([^"]+)"/g)].map((m) => m[1]),
    CHAT_ACTION_COMMANDS
  );
  for (const command of CHAT_ACTION_COMMANDS) assert.ok(isChatActionCommand(command));
  assert.equal(isChatActionCommand('piRpcInternal.deleteSession'), false);
  assert.equal(isChatActionCommand(undefined), false);
});

test('chat-list shell: filter text is escaped into the search input value', () => {
  const html = renderChatListShell('<div></div>', `"><script>alert(1)</script>`);
  assert.ok(!html.includes('<script>'), 'raw script must not appear');
  assert.ok(html.includes('value="&quot;&gt;&lt;script&gt;'), 'escaped value expected');
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
