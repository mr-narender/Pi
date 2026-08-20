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

test('renderChatApp renders a minimal composer + chat header (clean layout)', () => {
  const html = renderChatApp(snapshot());
  // The above-input toolbar band is gone; per-chat actions live in the header.
  assert.doesNotMatch(html, /class="composer-toolbar brand-controls"/);
  assert.doesNotMatch(html, /class="brand-bar"/);
  // Settings moved to the sidebar; no settings menu inside the composer.
  assert.doesNotMatch(html, /id="settings-menu"/);
  // The in-webview chat header was removed: the editor tab shows the name+icon
  // and chat actions live in the native editor title bar (piRpc.chatActions).
  assert.doesNotMatch(html, /class="chat-header"/);
  assert.match(html, /Skip to composer/);
  assert.match(html, /class="composer-dock"/);
  assert.match(html, /class="composer-card"/);
  assert.match(html, /placeholder="Ask Pi to edit/);
  // Model is a borderless clickable label inside the composer; chat actions
  // moved to the NATIVE editor title bar (piRpc.chatActions submenu).
  assert.match(html, /class="model-label"/);
  assert.doesNotMatch(html, /aria-label="Chat actions"/);
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
  assert.match(html, /Start a chat with Pi/);
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
  assert.match(html, /class="hljs language-typescript"/); // highlighted
  assert.match(html, /hljs-keyword">const<\/span>/);
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
  assert.match(html, /hljs-keyword">const<\/span>/);
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

test('long tool result is clamped with a Show more toggle; short is not', () => {
  const long = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
  const html = renderChatApp(
    snapshot({ messages: [{ id: 'r', role: 'toolResult', text: long, attachments: [] }] })
  );
  assert.match(html, /class="clampable"/);
  assert.match(html, /class="code-showmore">Show more/);
  const shortHtml = renderChatApp(
    snapshot({ messages: [{ id: 'r2', role: 'toolResult', text: 'index.ts', attachments: [] }] })
  );
  assert.doesNotMatch(shortHtml, /clampable/);
});

test('chat actions moved to the native title bar; layout has a jump-to-latest button', () => {
  const html = renderChatApp(snapshot());
  // Copy-as-Markdown & friends live in the piRpc.chatActions editor/title
  // submenu now — not in the webview HTML.
  assert.doesNotMatch(html, /data-command="piRpcInternal.copyConversationMarkdown"/);
  assert.match(html, /id="jump-latest"/);
});

test('each user/agent message has a copy button; jump-latest uses an SVG arrow', () => {
  const html = renderChatApp(
    snapshot({
      messages: [
        { id: 'u', role: 'user', text: 'hi', attachments: [] },
        {
          id: 'a',
          role: 'assistant',
          text: 'hello',
          blocks: [{ kind: 'text', text: 'hello' }],
          attachments: [],
        },
      ],
    })
  );
  const copyButtons = html.match(/class="msg-copy"/g) ?? [];
  assert.equal(copyButtons.length, 2); // one per bubble
  assert.match(html, /id="jump-latest"[^>]*><svg/); // SVG arrow, not a bare glyph
});

test('renderRichText renders markdown: headings, lists, blockquote, italic, links', () => {
  const md = [
    '# Title',
    '',
    'Some **bold** and _italic_ and a [link](https://example.com).',
    '',
    '- one',
    '- two',
    '',
    '1. first',
    '2. second',
    '',
    '> a quote',
  ].join('\n');
  const html = renderRichText(md);
  assert.match(html, /class="md-h md-h1">Title/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<em>italic<\/em>/);
  assert.match(html, /class="md-link" data-href="https:\/\/example.com">link<\/a>/);
  assert.match(html, /<ul class="md-ul"><li>one<\/li><li>two<\/li><\/ul>/);
  assert.match(html, /<ol class="md-ol"><li>first<\/li><li>second<\/li><\/ol>/);
  assert.match(html, /<blockquote class="md-quote">/);
  assert.doesNotMatch(html, /<script/);
});

test('renderRichText markdown still escapes html and handles fenced code', () => {
  const html = renderRichText('text <b>x</b>\n```js\nconst y=1;\n```\n- item');
  assert.match(html, /&lt;b&gt;x&lt;\/b&gt;/);
  assert.match(html, /class="code-wrap"/);
  assert.match(html, /<ul class="md-ul"><li>item<\/li>/);
});

test('user messages get an edit button; retry is in the menu; assistant has no edit', () => {
  const html = renderChatApp(
    snapshot({
      messages: [
        { id: 'u', role: 'user', text: 'hi', attachments: [] },
        {
          id: 'a',
          role: 'assistant',
          text: 'hello',
          blocks: [{ kind: 'text', text: 'hello' }],
          attachments: [],
        },
      ],
    })
  );
  assert.equal((html.match(/class="msg-edit"/g) ?? []).length, 1); // only the user message
  // Retry moved to the native chat-actions menu (editor title bar).
  assert.doesNotMatch(html, /data-command="piRpcInternal.retryLast"/);
});

test('working animation shows while busy with the chosen style; font overrides apply', () => {
  const busyHtml = renderChatApp(
    snapshot({
      connectionState: 'busy',
      workingAnimation: 'earth',
      chatFontSize: 16,
      chatFontFamily: 'Fira Code',
    })
  );
  assert.match(busyHtml, /class="working" data-anim="earth"/);
  // The spinner lives in a labelled banner at the top of the composer.
  assert.match(busyHtml, /class="working-banner">.*class="working"/s);
  assert.match(busyHtml, /class="working-label">Working/);
  assert.match(busyHtml, /--pi-chat-font-size:16px/);
  assert.match(busyHtml, /--pi-chat-font-family:Fira Code/);

  const idleHtml = renderChatApp(snapshot({ connectionState: 'ready' }));
  assert.doesNotMatch(idleHtml, /class="working"/); // no animation when idle
});

test('#5 usage chip renders in header when stats present', () => {
  const html = renderChatApp(
    snapshot({ usage: { totalTokens: 12345, contextPercent: 6, cost: 0.0234 } })
  );
  // Cost is now a read-only label (not a clickable usage-chip).
  assert.match(html, /class="cost-label"[^>]*title="Session cost"/);
  assert.doesNotMatch(html, /class="usage-chip"/);
  assert.match(html, /6% · 12k tok · \$0.023/);
  const bare = renderChatApp(snapshot({}));
  assert.doesNotMatch(bare, /class="cost-label"/);
});

test('#3 edit tool cards show Open file / Open changes', () => {
  const html = renderChatApp(
    snapshot({
      messages: [
        {
          id: 'a',
          role: 'assistant',
          text: '',
          blocks: [{ kind: 'tool', name: 'edit', args: '{"path":"src/x.ts"}' }],
          attachments: [],
        },
      ],
    })
  );
  assert.match(html, /data-file-open="src\/x.ts"/);
  assert.match(html, /data-file-diff="src\/x.ts"/);
});

test('messages render without content-visibility virtualization (removed for stable scrolling)', () => {
  const html = renderChatApp(
    snapshot({
      messages: [
        { id: 'a', role: 'user', text: 'one', attachments: [] },
        {
          id: 'b',
          role: 'assistant',
          text: 'two',
          blocks: [{ kind: 'text', text: 'two' }],
          attachments: [],
        },
        { id: 'c', role: 'user', text: 'three', attachments: [] },
      ],
    })
  );
  // Virtualization was removed (caused scrollbar jumpiness) — no msg-virtual class.
  assert.equal((html.match(/msg-virtual/g) ?? []).length, 0);
  assert.equal((html.match(/message-card/g) ?? []).length, 3);
});

test('onboarding empty-state shows example prompts and hints', () => {
  const html = renderChatApp(snapshot({ messages: [] }));
  assert.match(html, /class="empty-example" data-example=/);
  assert.match(html, /Explain this codebase/);
  assert.match(html, /mention a file/);
});

test('typewriter: streaming last assistant answer is marked js-stream-text with data-raw', () => {
  const streaming = renderChatApp(
    snapshot({
      connectionState: 'busy',
      messages: [
        { id: 'u', role: 'user', text: 'hi', attachments: [] },
        {
          id: 'a',
          role: 'assistant',
          text: 'Hello there friend',
          blocks: [{ kind: 'text', text: 'Hello there friend' }],
          attachments: [],
        },
      ],
    })
  );
  assert.match(streaming, /class="message-body js-stream-text" data-raw="Hello there friend"/);

  const idle = renderChatApp(
    snapshot({
      connectionState: 'ready',
      messages: [
        {
          id: 'a',
          role: 'assistant',
          text: 'Hello',
          blocks: [{ kind: 'text', text: 'Hello' }],
          attachments: [],
        },
      ],
    })
  );
  assert.doesNotMatch(idle, /js-stream-text/); // no marker when not streaming
});

test('inline approval card renders for confirm/select requests', () => {
  const confirmHtml = renderChatApp(
    snapshot({
      approvals: [
        { id: 'u1', method: 'confirm', title: 'Allow dangerous command?', message: 'rm -rf build' },
      ],
    })
  );
  assert.match(confirmHtml, /class="approval-card"/);
  assert.match(confirmHtml, /Allow dangerous command\?/);
  assert.match(confirmHtml, /data-ui-confirmed="true"/);
  assert.match(confirmHtml, /data-ui-confirmed="false"/);

  const selectHtml = renderChatApp(
    snapshot({
      approvals: [{ id: 'u2', method: 'select', title: 'Pick', options: ['Allow', 'Block'] }],
    })
  );
  assert.match(selectHtml, /data-ui-value="Allow"/);
  assert.match(selectHtml, /data-ui-value="Block"/);

  assert.doesNotMatch(renderChatApp(snapshot({})), /approval-card/);
});

test('queue tray renders; Continue button was removed', () => {
  const queued = renderChatApp(snapshot({ queue: { steering: ['do X'], followUp: ['then Y'] } }));
  assert.match(queued, /class="queue-tray"/);
  assert.match(queued, /do X/);
  assert.match(queued, /then Y/);

  // The manual Continue affordance is gone (replaced by an in-text suggestion).
  const idleAfterAssistant = renderChatApp(
    snapshot({
      connectionState: 'ready',
      draft: '',
      messages: [
        {
          id: 'a',
          role: 'assistant',
          text: 'hi',
          blocks: [{ kind: 'text', text: 'hi' }],
          attachments: [],
        },
      ],
    })
  );
  assert.doesNotMatch(idleAfterAssistant, /data-command="piRpcInternal.continue"/);
  assert.doesNotMatch(idleAfterAssistant, /continue-btn/);
});

test('edit tool card renders a colored diff', () => {
  const html = renderChatApp(
    snapshot({
      messages: [
        {
          id: 'a',
          role: 'assistant',
          text: '',
          blocks: [
            {
              kind: 'tool',
              name: 'edit',
              args: JSON.stringify({
                path: 'a.ts',
                replacements: [{ oldText: 'old', newText: 'new' }],
              }),
            },
          ],
          attachments: [],
        },
      ],
    })
  );
  assert.match(html, /class="edit-diff"/);
  assert.match(html, /class="diff-line diff-del">old</);
  assert.match(html, /class="diff-line diff-add">new</);
});

test('accessibility: live status region, transcript live=off, author labels', () => {
  const html = renderChatApp(
    snapshot({
      messages: [
        { id: 'u', role: 'user', text: 'hi', attachments: [] },
        {
          id: 'a',
          role: 'assistant',
          text: 'hello',
          blocks: [{ kind: 'text', text: 'hello' }],
          attachments: [],
        },
      ],
    })
  );
  assert.match(html, /id="a11y-status"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(html, /id="messages"[^>]*aria-live="off"/);
  assert.match(html, /class="model-label"[^>]*aria-label="Choose model"/);
  assert.match(html, /aria-label="You said"/);
  assert.match(html, /aria-label="Pi said"/);
});

test('renderRichText renders a GFM table as an HTML table with alignment', () => {
  const md = ['| Name | Score |', '| :--- | ----: |', '| Ann | 10 |', '| Bob | 5 |'].join('\n');
  const html = renderRichText(md);
  assert.match(html, /<table class="md-table">/);
  assert.match(html, /<th style="text-align:left">Name<\/th>/);
  assert.match(html, /<th style="text-align:right">Score<\/th>/);
  assert.match(html, /<td style="text-align:right">10<\/td>/);
  assert.match(html, /<td style="text-align:left">Bob<\/td>/);
  // The raw pipe-row text must not leak as a paragraph.
  assert.doesNotMatch(html, /<p class="msg-para">\| Name/);
});

test('renderRichText leaves a lone pipe line as a paragraph (not a table)', () => {
  const html = renderRichText('a | b but no delimiter row');
  assert.doesNotMatch(html, /<table/);
});

test('renderRichText syntax-highlights fenced code with a language', () => {
  const html = renderRichText(['```js', 'const x = 1;', '```'].join('\n'));
  assert.match(html, /<code class="hljs language-javascript">/);
  assert.match(html, /hljs-keyword/); // `const` tokenized
});

test('renderRichText renders GFM strikethrough, autolinks, and task lists', () => {
  assert.match(renderRichText('~~gone~~'), /<del>gone<\/del>/);
  const auto = renderRichText('see https://example.com/x for details');
  assert.match(
    auto,
    /<a class="md-link" data-href="https:\/\/example\.com\/x">https:\/\/example\.com\/x<\/a>/
  );
  const tasks = renderRichText(['- [x] done', '- [ ] todo'].join('\n'));
  assert.match(tasks, /<li class="md-task"><input type="checkbox" disabled checked \/>/);
  assert.match(tasks, /<li class="md-task"><input type="checkbox" disabled \/>/);
});

test('renderRichText nests sub-lists by indentation', () => {
  const html = renderRichText(['- parent', '  - child', '- parent2'].join('\n'));
  assert.match(html, /<li>parent<ul class="md-ul"><li>child<\/li><\/ul><\/li>/);
});

test('renderRichText renders a markdown image as a safe link (no remote img)', () => {
  const html = renderRichText('![cat](https://ex.com/c.png)');
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /<a class="md-link md-img-link" data-href="https:\/\/ex\.com\/c\.png">/);
});

test('renderChatApp renders JSON tool output as a structured table', () => {
  const html = renderChatApp(
    snapshot({
      messages: [
        {
          id: 'm1',
          role: 'assistant',
          text: 'x',
          blocks: [
            { kind: 'tool', name: 'q', args: '{"path":"a.ts","limit":5}' },
            {
              kind: 'toolResult',
              name: 'q',
              text: '[{"name":"a","size":1},{"name":"b","size":2}]',
              isError: false,
            },
          ],
          attachments: [],
        },
      ],
    })
  );
  assert.match(html, /class="md-table json-table"/); // object args -> grid
  assert.match(html, /class="json-key">path</);
  assert.match(html, /<th>name<\/th>/); // array of objects -> columns
  assert.match(html, /<th>size<\/th>/);
  assert.doesNotMatch(html, /\[\{&quot;name/); // no raw JSON dump
});

test('renderChatApp shows a hint for an empty assistant response (not a blank bubble)', () => {
  const html = renderChatApp(
    snapshot({
      connectionState: 'ready',
      model: { provider: 'openai-codex', id: 'gpt-5.6-sol' },
      messages: [
        { id: 'u', role: 'user', text: 'PING', attachments: [] },
        { id: 'a', role: 'assistant', text: '', blocks: [], attachments: [] },
      ],
    })
  );
  assert.match(html, /class="assistant-empty"/);
  assert.match(html, /empty response/i);
  // Names the failing model so the user knows which one to switch away from.
  assert.match(html, /openai-codex\/gpt-5\.6-sol/);
});

test('renderChatApp tabularizes a ```json block in Pi answer (with raw toggle)', () => {
  const answer = [
    'Here are the results:',
    '',
    '```json',
    '[{"name":"a","qty":1},{"name":"b","qty":2}]',
    '```',
  ].join('\n');
  const html = renderChatApp(
    snapshot({
      messages: [
        { id: 'u', role: 'user', text: 'list', attachments: [] },
        { id: 'a', role: 'assistant', text: answer, attachments: [] },
      ],
    })
  );
  assert.match(html, /class="json-block"/);
  assert.match(html, /json-table|md-table/); // rendered as a table
  assert.match(html, /class="json-toggle"/); // raw toggle present
  assert.match(html, /<th>name<\/th>/); // column header from the array-of-objects
});

test('renderChatApp leaves non-JSON code fences as code blocks', () => {
  const answer = ['```js', 'const x = 1;', '```'].join('\n');
  const html = renderChatApp(
    snapshot({
      messages: [{ id: 'a', role: 'assistant', text: answer, attachments: [] }],
    })
  );
  assert.match(html, /code-wrap/);
  assert.doesNotMatch(html, /class="json-block"/);
});
