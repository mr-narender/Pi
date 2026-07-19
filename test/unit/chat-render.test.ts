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

test('renderChatApp renders the native brand + docked composer layout', () => {
  const html = renderChatApp(snapshot());
  assert.match(html, /class="brand"/);
  assert.match(html, /Skip to composer/);
  assert.match(html, /class="composer-dock"/);
  assert.match(html, /class="composer-card"/);
  assert.match(html, /placeholder="Ask Pi to edit/);
  assert.match(html, />New</);
  assert.match(html, />History</);
  assert.match(html, /aria-label="More actions"/);
  assert.match(html, /aria-label="Attach"/);
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

test('renderChatApp shows advanced drawer only in advanced mode', () => {
  const html = renderChatApp(snapshot({ uiMode: 'advanced' }));
  assert.match(html, /<h2 id="advanced-heading">Advanced<\/h2>/);
  assert.match(html, /Queue &amp; steering/);
  assert.match(html, /Diagnostics/);
});
