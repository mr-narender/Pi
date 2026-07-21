import test from 'node:test';
import assert from 'node:assert/strict';
import { createWebviewSnapshot } from '../../src/webview/model';
import { createInitialControllerState } from '../../src/state/types';
import { createEmptyComposerState } from '../../src/webview/composer';

test('createWebviewSnapshot serializes transcript and composer ui state', () => {
  const state = createInitialControllerState('workspace', '/tmp/workspace');
  state.title = 'Chat';
  state.draft = 'legacy-draft';
  state.messages = [
    {
      id: '1',
      role: 'user',
      content: 'hello',
      attachments: [
        {
          id: 'a1',
          type: 'image',
          fileName: 'diagram.png',
          mimeType: 'image/png',
          size: 1,
          content: 'QUJDREVGR0g=',
          preview: { path: './notes.txt' },
        },
      ],
    },
    { id: '2', role: 'assistant', content: [{ type: 'text', text: 'world' }] },
  ];
  state.statuses.demo = 'ok';
  state.widgets.push({ key: 'w', lines: ['line'], placement: 'aboveEditor' });

  const composer = createEmptyComposerState();
  composer.draft = 'draft';
  composer.pendingContextItems.push({
    kind: 'selection',
    itemId: 'sel-1',
    workspaceFolder: '/tmp/workspace',
    workspaceRelativePath: 'src/app.ts',
    lineStart: 2,
    lineEnd: 4,
    languageId: 'typescript',
    sanitizedContent: 'const value = 1;',
    capturedAt: '2024-01-01T00:00:00.000Z',
    persistedRef: {
      workspaceRelativePath: 'src/app.ts',
      lineStart: 2,
      lineEnd: 4,
      languageId: 'typescript',
      contentFingerprint: 'abc',
    },
  });
  composer.pendingImages.push({
    itemId: 'img-1',
    name: 'demo.png',
    mimeType: 'image/png',
    sizeBytes: 1,
    inMemoryBase64: 'AAAA',
    previewDataUrl: 'data:image/png;base64,AAAA',
  });

  const snapshot = createWebviewSnapshot(state, 7, {
    uiMode: 'simple',
    composer,
    isTrusted: true,
    folders: [{ name: 'workspace', uri: 'file:///tmp/workspace', active: true }],
  });
  assert.equal(snapshot.sequence, 7);
  assert.equal(snapshot.messages[0]?.text, 'hello');
  assert.equal(snapshot.messages[0]?.attachments[0]?.hasContent, true);
  assert.equal(snapshot.messages[0]?.attachments[0]?.fileRef?.path, 'notes.txt');
  assert.equal(JSON.stringify(snapshot).includes('QUJDREVGR0g='), false);
  assert.equal(snapshot.messages[1]?.text, 'world');
  assert.equal(snapshot.statuses.demo, 'ok');
  assert.equal(snapshot.widgets[0]?.key, 'w');
  assert.equal(snapshot.pendingImages[0]?.name, 'demo.png');
  assert.equal(snapshot.pendingImages[0]?.itemId, 'img-1');
  assert.equal(
    snapshot.pendingImages[0]?.previewDataUrl?.startsWith('data:image/png;base64,'),
    true
  );
  assert.equal(snapshot.draft, 'draft');
  assert.equal(snapshot.pendingContextItems[0]?.workspaceRelativePath, 'src/app.ts');
});

import { DEFAULT_MESSAGE_WINDOW, firstPromptPreview } from '../../src/webview/model';
import { parseWebviewMessage } from '../../src/webview/messages';

function stateWithMessages(count: number) {
  const state = createInitialControllerState('workspace', '/tmp/workspace');
  state.messages = Array.from({ length: count }, (_, i) => ({
    id: `m${i}`,
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `message ${i}`,
  }));
  return state;
}

const baseExtra = {
  uiMode: 'simple' as const,
  composer: createEmptyComposerState(),
  isTrusted: true,
  folders: [],
};

test('createWebviewSnapshot windows to the last N messages with hasOlder', () => {
  const state = stateWithMessages(200);
  const snapshot = createWebviewSnapshot(state, 1, baseExtra);
  assert.equal(snapshot.messages.length, DEFAULT_MESSAGE_WINDOW);
  assert.equal(snapshot.messageWindow?.total, 200);
  assert.equal(snapshot.messageWindow?.offset, 200 - DEFAULT_MESSAGE_WINDOW);
  assert.equal(snapshot.messageWindow?.hasOlder, true);
  // Last message in the window is the newest; ids stay globally stable.
  assert.equal(snapshot.messages.at(-1)?.text, 'message 199');
  assert.equal(snapshot.messages[0]?.text, `message ${200 - DEFAULT_MESSAGE_WINDOW}`);
});

test('createWebviewSnapshot grows the window when messageLimit increases (load older)', () => {
  const state = stateWithMessages(200);
  const snapshot = createWebviewSnapshot(state, 1, { ...baseExtra, messageLimit: 100 });
  assert.equal(snapshot.messages.length, 100);
  assert.equal(snapshot.messageWindow?.offset, 100);
  assert.equal(snapshot.messageWindow?.hasOlder, true);
  assert.equal(snapshot.messages[0]?.text, 'message 100');
});

test('createWebviewSnapshot shows all messages and hasOlder=false for short chats', () => {
  const state = stateWithMessages(10);
  const snapshot = createWebviewSnapshot(state, 1, baseExtra);
  assert.equal(snapshot.messages.length, 10);
  assert.equal(snapshot.messageWindow?.offset, 0);
  assert.equal(snapshot.messageWindow?.hasOlder, false);
});

test('firstPromptPreview returns the first line of the first user message, truncated', () => {
  const messages = [
    { id: 'a', role: 'assistant', content: 'hi there' },
    { id: 'u', role: 'user', content: 'Refactor the auth module\nand add tests' },
  ];
  assert.equal(firstPromptPreview(messages), 'Refactor the auth module');
});

test('firstPromptPreview truncates long prompts with an ellipsis', () => {
  const long = 'x'.repeat(80);
  const preview = firstPromptPreview([{ id: 'u', role: 'user', content: long }], 48);
  assert.equal(preview?.length, 48);
  assert.ok(preview?.endsWith('\u2026'));
});

test('firstPromptPreview handles content blocks and returns undefined when no user turn', () => {
  assert.equal(
    firstPromptPreview([
      { id: 'u', role: 'user', content: [{ type: 'text', text: 'block prompt' }] },
    ]),
    'block prompt'
  );
  assert.equal(firstPromptPreview([{ id: 'a', role: 'assistant', content: 'x' }]), undefined);
  assert.equal(firstPromptPreview([]), undefined);
});

test('parseWebviewMessage accepts loadOlder', () => {
  assert.deepEqual(parseWebviewMessage({ type: 'loadOlder' }), { type: 'loadOlder' });
});

test('createWebviewSnapshot maps Pi content blocks into structured message blocks', () => {
  const state = createInitialControllerState('workspace', '/tmp/workspace');
  state.messages = [
    {
      id: '1',
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'reasoning' },
        { type: 'toolCall', name: 'bash', arguments: { cmd: 'ls' } },
        { type: 'text', text: 'done' },
      ],
    },
  ];
  const snapshot = createWebviewSnapshot(state, 1, baseExtra);
  const blocks = snapshot.messages[0]?.blocks;
  assert.equal(blocks?.[0]?.kind, 'thinking');
  assert.equal(blocks?.[1]?.kind, 'tool');
  assert.equal(blocks?.[1] && 'name' in blocks[1] ? blocks[1].name : undefined, 'bash');
  assert.equal(blocks?.[2]?.kind, 'text');
});
