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

test('default simple mode keeps the header primary controls and a grouped More menu', () => {
  const html = renderChatApp(snapshot());
  // Header keeps the model chip + More only (New/History live in the sidebar).
  assert.match(html, /class="model-chip"/);
  assert.match(html, /aria-label="More actions"/);
  assert.doesNotMatch(html, /data-command="piRpc\.newSession"/);
  assert.doesNotMatch(html, /data-command="piRpc\.switchSession"/);
  // The composer exposes attach, send, and slash commands.
  assert.match(html, /id="attach-trigger"/);
  assert.match(html, /id="composer-send-button"/);
  assert.match(html, /data-command="piRpc\.showPiCommands"/);
  // The More menu is a grouped, color-tagged dropdown.
  assert.match(html, /class="menu-group">Model</);
  assert.match(html, /class="menu-item cat-model"/);
  assert.match(html, /class="menu-item cat-system"/);
  // No stop button while idle.
  assert.equal((html.match(/data-action="abort"/g) ?? []).length, 0);
});

test('composer is disabled with a connecting spinner until Pi is ready', () => {
  const connecting = renderChatApp(snapshot({ connectionState: 'handshaking', messages: [] }));
  assert.match(connecting, /Connecting to Pi/);
  assert.match(connecting, /class="spinner"/);
  assert.match(connecting, /id="composer-field"[^>]*disabled/);
  assert.match(connecting, /id="composer-send-button"[^>]*disabled/);

  const ready = renderChatApp(snapshot({ connectionState: 'ready', messages: [] }));
  assert.doesNotMatch(ready, /id="composer-field"[^>]*disabled/);
  assert.match(ready, /What to do first/);
});

test('composer typing is protected from caret reset and re-render loops', () => {
  const chat = readFileSync('src/webview/media/chat.ts', 'utf8');
  assert.match(chat, /composerWasFocused/);
  assert.match(chat, /setSelectionRange/);
  const tab = readFileSync('src/editorTabs/tabManager.ts', 'utf8');
  assert.match(tab, /setDraft\(parsed\.text, \{ silent: true \}\)/);
});

test('opening a saved session reveals an existing tab instead of duplicating', () => {
  const tab = readFileSync('src/editorTabs/tabManager.ts', 'utf8');
  assert.match(tab, /findTabUriForSessionFile/);
  assert.match(tab, /opening a duplicate/);
});

test('sending clears the composer via an authoritative reset', () => {
  const chat = readFileSync('src/webview/media/chat.ts', 'utf8');
  assert.match(chat, /authoritativeReset/);
  assert.match(chat, /composerResetSeq/);
  const tab = readFileSync('src/editorTabs/tabManager.ts', 'utf8');
  assert.match(tab, /state\.composerResetSeq = \(state\.composerResetSeq \?\? 0\) \+ 1/);
});

test('chat css covers narrow, high-contrast, and reduced-motion modes', () => {
  const css = readFileSync('src/webview/media/chat.css', 'utf8');
  assert.match(css, /@media \(max-width: 640px\)/);
  assert.match(css, /@media \(forced-colors: active\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /var\(--vscode-focusBorder\)/);
});
