import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ATTACH_TRIGGER_ID,
  PREVIEW_ACCEPT_BUTTON_ID,
  PREVIEW_CANCEL_BUTTON_ID,
  PREVIEW_DESCRIPTION_ID,
  PREVIEW_DIALOG_ID,
  contextChipRemoveButtonId,
  imageChipRemoveButtonId,
  renderChatApp,
  renderRichText,
} from '../../src/webview/render';
import type { WebviewSnapshot } from '../../src/state/types';

function snapshot(overrides: Partial<WebviewSnapshot> = {}): WebviewSnapshot {
  return {
    sequence: 1,
    title: 'Current Chat',
    bindingState: 'current',
    uiMode: 'simple',
    connectionState: 'ready',
    workspaceFolderName: 'workspace',
    sessionName: 'Demo Session',
    sessionId: 'sid',
    sessionFile: '/tmp/workspace/session.jsonl',
    isStreaming: false,
    isCompacting: false,
    messageCount: 2,
    pendingMessageCount: 0,
    messages: [
      { id: 'm1', role: 'user', text: 'hello', attachments: [] },
      { id: 'm2', role: 'assistant', text: 'hi', attachments: [] },
    ],
    queue: { steering: ['one'], followUp: [] },
    draft: 'draft',
    statuses: { mode: 'active' },
    widgets: [],
    model: { provider: 'mock', id: 'model' },
    thinkingLevel: 'medium',
    pendingContextItems: [],
    pendingImages: [],
    focus: 'composer',
    isTrusted: true,
    folders: [{ name: 'workspace', uri: 'file:///tmp/workspace', active: true }],
    ...overrides,
  };
}

test('renderChatApp renders the header controls + docked composer layout', () => {
  const html = renderChatApp(snapshot());
  assert.match(html, /class="brand-controls"/);
  assert.match(html, /Skip to composer/);
  assert.match(html, /class="composer-dock"/);
  assert.match(html, /class="composer-card"/);
  assert.match(html, /placeholder="Ask Pi to edit/);
  assert.match(html, /class="model-chip"/);
  assert.match(html, /aria-label="More actions"/);
  assert.doesNotMatch(html, /data-command="piRpc\.newSession"/);
  assert.doesNotMatch(html, /data-command="piRpc\.switchSession"/);
  assert.match(html, /aria-label="Add a file"/);
  assert.match(html, /id="composer-send-button"/);
  assert.match(html, /data-command="piRpc.showPiCommands"/);
  assert.doesNotMatch(html, /Queue & steering/);
  assert.doesNotMatch(html, /Workflow & Models/);
});

test('renderChatApp exposes empty, restricted, preview, and attachment states accessibly', () => {
  const html = renderChatApp(
    snapshot({
      isTrusted: false,
      messages: [],
      pendingContextItems: [
        {
          kind: 'selection',
          itemId: 'sel-1',
          workspaceFolder: '/tmp/workspace',
          workspaceRelativePath: 'src/app.ts',
          lineStart: 18,
          lineEnd: 34,
          languageId: 'typescript',
          sanitizedContent: 'const value = 1;',
          capturedAt: '2024-01-01T00:00:00.000Z',
          persistedRef: {
            workspaceRelativePath: 'src/app.ts',
            lineStart: 18,
            lineEnd: 34,
            languageId: 'typescript',
            contentFingerprint: 'abc',
          },
        },
      ],
      pendingImages: [
        {
          itemId: 'img-1',
          name: 'diagram.png',
          mimeType: 'image/png',
          sizeBytes: 42,
          previewDataUrl: 'data:image/png;base64,AAAA',
        },
      ],
      recovery: {
        kind: 'sendFailure',
        title: 'Draft preserved. Not resent.',
        detail: 'network issue',
      },
      preview: {
        command: 'prompt',
        draft: 'hello',
        serializedContextEnvelope: '<pi-vscode-context-v1>\n{}\n</pi-vscode-context-v1>',
        rpcMessage: 'hello\n\n<pi-vscode-context-v1>\n{}\n</pi-vscode-context-v1>',
        rpcImages: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }],
        imageItems: [
          {
            itemId: 'img-1',
            name: 'diagram.png',
            mimeType: 'image/png',
            sizeBytes: 42,
          },
        ],
      },
    })
  );
  assert.match(html, /Restricted Mode/);
  assert.match(html, /What to do first/);
  assert.match(html, /Selection: src\/app\.ts L18-L34/);
  assert.match(html, /diagram\.png/);
  assert.match(html, new RegExp(`id="${PREVIEW_DIALOG_ID}"`));
  assert.match(html, /role="dialog"/);
  assert.match(html, /aria-modal="true"/);
  assert.match(html, new RegExp(`aria-describedby="${PREVIEW_DESCRIPTION_ID}"`));
  assert.match(html, /tabindex="-1"/);
  assert.match(html, new RegExp(`id="${PREVIEW_ACCEPT_BUTTON_ID}"`));
  assert.match(html, new RegExp(`id="${PREVIEW_CANCEL_BUTTON_ID}"`));
  assert.match(html, new RegExp(`id="${ATTACH_TRIGGER_ID}"`));
  assert.match(html, new RegExp(`data-chip-id="sel-1"`));
  assert.match(html, new RegExp(`id="${contextChipRemoveButtonId('sel-1')}"`));
  assert.match(html, new RegExp(`data-chip-id="img-1"`));
  assert.match(html, new RegExp(`id="${imageChipRemoveButtonId('img-1')}"`));
  assert.match(html, /Draft preserved\. Not resent\./);
});

test('renderChatApp no longer renders the confusing Advanced drawer', () => {
  const html = renderChatApp(snapshot({ uiMode: 'advanced' }));
  assert.doesNotMatch(html, /advanced-heading/);
  assert.doesNotMatch(html, /Queue &amp; steering/);
  assert.doesNotMatch(html, /data-command="piRpc\.toggleAdvancedMode"/);
});

test('renderChatApp no longer shows the left "Pi" brand label', () => {
  const html = renderChatApp(snapshot());
  assert.doesNotMatch(html, /class="brand"/);
  assert.doesNotMatch(html, /aria-label="Pi"/);
});

test('renderChatApp shows the older-messages sentinel only when hasOlder', () => {
  const withOlder = renderChatApp(
    snapshot({ messageWindow: { total: 120, offset: 70, hasOlder: true } })
  );
  assert.match(withOlder, /id="older-sentinel"/);

  const noOlder = renderChatApp(
    snapshot({ messageWindow: { total: 2, offset: 0, hasOlder: false } })
  );
  assert.doesNotMatch(noOlder, /id="older-sentinel"/);
});

test('renderRichText formats fenced code blocks and inline code', () => {
  const html = renderRichText('before\n```ts\nconst x = 1;\n```\nafter `inline` end');
  assert.match(html, /class="code-wrap"/);
  assert.match(html, /class="code-lang-name">ts</); // language label
  assert.match(html, /code-copy"/); // copy button
  assert.match(html, /const x = 1;/);
  assert.match(html, /class="inline-code">inline<\/code>/);
  assert.match(html, /<p class="msg-para">before/);
});

test('renderRichText escapes all HTML (no injection)', () => {
  const html = renderRichText('<script>alert(1)</script>\n```\n<b>code</b>\n```');
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;b&gt;code&lt;\/b&gt;/);
});

test('renderChatApp renders thinking, tool, and code blocks distinctly', () => {
  const html = renderChatApp(
    snapshot({
      messages: [
        {
          id: 'm1',
          role: 'assistant',
          text: 'fallback',
          blocks: [
            { kind: 'thinking', text: 'let me reason' },
            { kind: 'tool', name: 'bash', args: '{"cmd":"ls"}' },
            { kind: 'toolResult', name: 'bash', text: 'file.txt', isError: false },
            { kind: 'text', text: 'Here:\n```js\nconst y = 2;\n```' },
          ],
          attachments: [],
        },
      ],
    })
  );
  // Assistant turn with process renders as a timeline of rounded cards.
  assert.match(html, /class="timeline"/);
  assert.match(html, /class="tl-node tl-thinking"/);
  assert.match(html, /class="tl-node tl-tool"/);
  assert.match(html, /class="tl-node tl-result"/);
  assert.match(html, /class="tl-node tl-response"/);
  assert.match(html, /class="tl-label">Thinking</);
  assert.match(html, /class="tl-label">Tool</);
  assert.match(html, /class="tl-label">Result</);
  assert.match(html, /tool-name">bash/);
  assert.match(html, /class="tl-dot"/);
  assert.match(html, /class="meta-icon"/); // inline SVG icon, not an emoji
  assert.match(html, /const y = 2;/);
  assert.match(html, /class="code-block"/);
});

test('thinking/tool render as separate light meta cards; text stays in the chat bubble', () => {
  const html = renderChatApp(
    snapshot({
      messages: [
        {
          id: 'm1',
          role: 'assistant',
          text: 'fallback',
          blocks: [
            { kind: 'thinking', text: 'reasoning' },
            { kind: 'text', text: 'the answer' },
            { kind: 'tool', name: 'bash' },
          ],
          attachments: [],
        },
      ],
    })
  );
  // Thinking + tool are timeline nodes; the answer is its own response node.
  assert.match(html, /class="tl-node tl-thinking"/);
  assert.match(html, /class="tl-node tl-tool"/);
  assert.match(html, /class="tl-node tl-response"/);
  // The answer sits in a response card with a "Pi" header, then the body text.
  assert.match(html, /class="tl-head tl-answer-head">.*<span class="tl-label">Pi</);
  assert.match(html, /<div class="tl-body"><p class="msg-para">the answer<\/p>/);
});

test('standalone toolResult / bashExecution messages render as a Result card (not a raw role label)', () => {
  const html = renderChatApp(
    snapshot({
      messages: [
        {
          id: 'r1',
          role: 'toolResult',
          text: 'User packages:\n  npm:@gotgenes/pi-anthropic-auth',
          blocks: [{ kind: 'text', text: 'User packages:\n  npm:@gotgenes/pi-anthropic-auth' }],
          attachments: [],
        },
      ],
    })
  );
  // It uses the timeline Result card, with an icon + "Result" label.
  assert.match(html, /class="tl-node tl-result"/);
  assert.match(html, /class="tl-label">Result</);
  assert.match(html, /class="meta-icon"/);
  assert.match(html, /npm:@gotgenes\/pi-anthropic-auth/);
  // The raw "toolResult" role label must NOT be shown as a heading.
  assert.doesNotMatch(html, /class="message-role">toolResult</);
});

test('renderRichText renders **bold** as <strong> and never shows literal ** markers', () => {
  const html = renderRichText('The **auth** module is **isolated** now.');
  assert.match(html, /<strong>auth<\/strong>/);
  assert.match(html, /<strong>isolated<\/strong>/);
  assert.doesNotMatch(html, /\*\*/); // no literal asterisks left
});

test('code blocks include Insert / New file / Copy actions and a data-lang', () => {
  const html = renderChatApp(
    snapshot({
      messages: [
        {
          id: 'm1',
          role: 'assistant',
          text: 'x',
          blocks: [{ kind: 'text', text: 'run:\n```ts\nconst x = 1;\n```' }],
          attachments: [],
        },
      ],
    })
  );
  assert.match(html, /class="code-wrap" data-lang="ts"/);
  assert.match(html, /class="code-btn code-insert"/);
  assert.match(html, /class="code-btn code-newfile"/);
  assert.match(html, /class="code-btn code-copy"/);
});
