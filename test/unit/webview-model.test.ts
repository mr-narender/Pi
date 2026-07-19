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
