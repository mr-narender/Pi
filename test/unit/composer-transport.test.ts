import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildSendPreview,
  createEmptyComposerState,
  serializeContextEnvelope,
} from '../../src/webview/composer';
import { renderChatApp } from '../../src/webview/render';
import type { WebviewSnapshot } from '../../src/state/types';

function snapshot(overrides: Partial<WebviewSnapshot> = {}): WebviewSnapshot {
  return {
    sequence: 1,
    title: 'Current Chat',
    uiMode: 'simple',
    connectionState: 'ready',
    workspaceFolderName: 'workspace',
    sessionName: 'Demo Session',
    sessionId: 'sid',
    sessionFile: '/tmp/workspace/session.jsonl',
    isStreaming: false,
    isCompacting: false,
    messages: [],
    queue: { steering: [], followUp: [] },
    draft: '',
    statuses: {},
    widgets: [],
    pendingContextItems: [],
    pendingImages: [],
    focus: 'composer',
    isTrusted: true,
    folders: [{ name: 'workspace', uri: 'file:///tmp/workspace', active: true }],
    ...overrides,
  };
}

test('serializeContextEnvelope preserves order and canonical field shape', () => {
  const state = createEmptyComposerState();
  state.pendingContextItems.push(
    {
      kind: 'activeFile',
      itemId: 'a',
      workspaceFolder: '/tmp/workspace',
      workspaceRelativePath: 'src/auth.ts',
      lineStart: 1,
      lineEnd: 2,
      languageId: 'typescript',
      sanitizedContent: 'const a = 1;\nconst b = 2;',
      capturedAt: '2024-01-01T00:00:00.000Z',
      persistedRef: {
        workspaceRelativePath: 'src/auth.ts',
        lineStart: 1,
        lineEnd: 2,
        languageId: 'typescript',
        contentFingerprint: 'abc',
      },
    },
    {
      kind: 'diagnostics',
      itemId: 'd',
      workspaceFolder: '/tmp/workspace',
      workspaceRelativePath: 'src/auth.ts',
      lineStart: 18,
      lineEnd: 34,
      severity: 'mixed',
      issueCount: 2,
      sanitizedContent: 'ERROR L20: bad\nWARNING L30: meh',
      capturedAt: '2024-01-01T00:00:00.000Z',
      persistedRef: {
        workspaceRelativePath: 'src/auth.ts',
        lineStart: 18,
        lineEnd: 34,
        severity: 'mixed',
        issueCount: 2,
        diagnosticFingerprint: 'def',
      },
    }
  );

  const { envelope } = serializeContextEnvelope(state.pendingContextItems);
  assert.equal(
    envelope,
    '<pi-vscode-context-v1>\n' +
      '{"kind":"activeFile","workspaceRelativePath":"src/auth.ts","lineStart":1,"lineEnd":2,"languageId":"typescript","content":"const a = 1;\\nconst b = 2;"}\n' +
      '{"kind":"diagnostics","workspaceRelativePath":"src/auth.ts","lineStart":18,"lineEnd":34,"severity":"mixed","content":"ERROR L20: bad\\nWARNING L30: meh"}\n' +
      '</pi-vscode-context-v1>'
  );
});

test('buildSendPreview appends deterministic envelope and exact rpc images', () => {
  const state = createEmptyComposerState();
  state.draft = 'hello';
  state.pendingContextItems.push({
    kind: 'selection',
    itemId: 'sel',
    workspaceFolder: '/tmp/workspace',
    workspaceRelativePath: 'src/auth.ts',
    lineStart: 18,
    lineEnd: 34,
    languageId: 'typescript',
    sanitizedContent: 'const value = 1;',
    capturedAt: '2024-01-01T00:00:00.000Z',
    persistedRef: {
      workspaceRelativePath: 'src/auth.ts',
      lineStart: 18,
      lineEnd: 34,
      languageId: 'typescript',
      contentFingerprint: 'abc',
    },
  });
  state.pendingImages.push({
    itemId: 'img',
    name: 'diagram.png',
    mimeType: 'image/png',
    sizeBytes: 4,
    inMemoryBase64: 'AAAA',
  });

  const preview = buildSendPreview('follow_up', state);
  assert.equal(preview.command, 'follow_up');
  assert.match(preview.rpcMessage, /hello\n\n<pi-vscode-context-v1>/);
  assert.deepEqual(preview.rpcImages, [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }]);
});

test('default simple mode visible controls stay compact', () => {
  const html = renderChatApp(snapshot());
  const headerButtons =
    html.match(
      /data-command="piRpc\.showModels"|data-command="piRpc\.newSession"|data-command="piRpc\.switchSession"|<summary>More<\/summary>/g
    ) ?? [];
  const composerButtons =
    html.match(
      /id="attach-trigger"|id="composer-send-button"|data-command="piRpc\.showPiCommands"/g
    ) ?? [];
  assert.equal(headerButtons.length, 4);
  assert.equal(composerButtons.length, 3);
  assert.equal((html.match(/data-action="abort"/g) ?? []).length, 0);
});

test('composer typing is protected from caret reset and re-render loops', () => {
  const chat = readFileSync('src/webview/media/chat.ts', 'utf8');
  assert.match(chat, /composerWasFocused/);
  assert.match(chat, /setSelectionRange/);
  const tab = readFileSync('src/editorTabs/tabManager.ts', 'utf8');
  assert.match(tab, /setDraft\(parsed\.text, \{ silent: true \}\)/);
});

test('chat css covers narrow, high-contrast, and reduced-motion modes', () => {
  const css = readFileSync('src/webview/media/chat.css', 'utf8');
  assert.match(css, /@media \(max-width: 640px\)/);
  assert.match(css, /@media \(forced-colors: active\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /var\(--vscode-focusBorder\)/);
});
