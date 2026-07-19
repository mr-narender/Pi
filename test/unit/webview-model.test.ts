import test from 'node:test';
import assert from 'node:assert/strict';
import { createWebviewSnapshot } from '../../src/webview/model';
import { createInitialControllerState } from '../../src/state/types';

test('createWebviewSnapshot serializes transcript and ui state', () => {
  const state = createInitialControllerState('workspace', '/tmp/workspace');
  state.title = 'Chat';
  state.draft = 'draft';
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
  const snapshot = createWebviewSnapshot(state, 7, {
    pendingImages: [{ name: 'demo.png', mimeType: 'image/png', size: 1 }],
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
});
