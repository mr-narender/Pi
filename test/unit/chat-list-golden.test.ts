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

test('golden: chat-list row — favorite with detail (badge + filled star)', () => {
  checkGolden(
    'chat-list-row-favorite',
    renderChatListRow(row({ favorite: true, detail: 'workspace · 5m ago' }))
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
        detail: '<b>ws</b> · 1m ago',
      })
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

test('golden: chat-list shell wrapping a populated body', () => {
  const body = renderChatListBody({
    rows: [
      row({ id: 'open:pi-chat://one', title: 'OpenChat', active: true, isOpen: true }),
      row({ favorite: true, detail: 'workspace · 2h ago' }),
    ],
    loading: false,
  });
  checkGolden('chat-list-shell-populated', renderChatListShell(body));
});

test('chat-list row: hover strip carries exactly the expected actions in order', () => {
  // Structural guard independent of the golden bytes: favorite → rename →
  // delete for a persisted row; delete alone for a draft.
  const acts = (html: string): string[] => [...html.matchAll(/data-act="([a-z]+)"/g)].map((m) => m[1]!);
  assert.deepEqual(acts(renderChatListRow(row())), ['favorite', 'rename', 'delete']);
  assert.deepEqual(
    acts(renderChatListRow(row({ sessionPath: undefined, openCommand: { resource: 'r' } }))),
    ['delete']
  );
});
