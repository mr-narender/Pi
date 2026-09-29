import assert from 'node:assert/strict';
import test from 'node:test';
import {
  beginSend,
  createEmptyComposerState,
  restoreEditableStateFromAcceptedSnapshot,
  type PendingContextItem,
  type PendingImageItem,
} from '../../src/webview/composer';
import { parseWebviewMessage } from '../../src/webview/messages';

function fileChip(): PendingContextItem {
  return {
    kind: 'file',
    itemId: 'ctx-1',
    workspaceRelativePath: 'src/example.ts',
    languageId: 'typescript',
    lineStart: 1,
    lineEnd: 12,
    sanitizedContent: 'export const example = 1;',
    persistedRef: { kind: 'file', uri: 'file:///w/src/example.ts' },
  } as unknown as PendingContextItem;
}

function imageChip(): PendingImageItem {
  return {
    itemId: 'img-1',
    name: 'screenshot.png',
    mimeType: 'image/png',
    sizeBytes: 128,
    inMemoryBase64: 'aGVsbG8=',
    previewDataUrl: 'data:image/png;base64,aGVsbG8=',
  };
}

test('beginSend: clears draft, context chips, and image chips in one atomic step', () => {
  const state = createEmptyComposerState();
  state.draft = 'please review this';
  state.pendingContextItems = [fileChip()];
  state.pendingImages = [imageChip()];

  const { preview, accepted } = beginSend('prompt', state);

  assert.equal(state.draft, '', 'input text clears');
  assert.deepEqual(state.pendingContextItems, [], 'context chips clear with the input');
  assert.deepEqual(state.pendingImages, [], 'image chips clear with the input');
  assert.equal(state.composerResetSeq, 1, 'webview reset sequence bumps');
  assert.equal(state.focus, 'composer');
  assert.equal(state.preview, undefined);
  assert.equal(state.recovery, undefined);
  assert.equal(state.acceptedSendSnapshot, accepted, 'sent message is captured before the clear');

  assert.ok(preview.rpcMessage.includes('please review this'));
  assert.ok(preview.rpcMessage.includes('src/example.ts'), 'chip content rides in the message');
  assert.equal(preview.rpcImages.length, 1);
  assert.equal(accepted.contextItems.length, 1, 'accepted snapshot retains chips for recovery');
  assert.equal(accepted.state, 'accepted');
});

test('beginSend: cancel/failure can restore exactly what was cleared', () => {
  const state = createEmptyComposerState();
  state.draft = 'draft to restore';
  state.pendingContextItems = [fileChip()];
  state.pendingImages = [imageChip()];

  const { accepted } = beginSend('follow_up', state);
  const restored = restoreEditableStateFromAcceptedSnapshot(accepted);

  assert.equal(restored.draft, 'draft to restore');
  assert.equal(restored.pendingContextItems.length, 1);
  assert.equal(restored.pendingContextItems[0]!.itemId, 'ctx-1');
  assert.equal(restored.pendingImages.length, 1);
  assert.equal(restored.pendingImages[0]!.itemId, 'img-1');
});

test('beginSend: empty composer throws without mutating state', () => {
  const state = createEmptyComposerState();
  assert.throws(() => beginSend('prompt', state), /Enter a message/);
  assert.equal(state.composerResetSeq, undefined);
  assert.equal(state.acceptedSendSnapshot, undefined);
});

test('beginSend: repeat sends keep bumping the reset sequence', () => {
  const state = createEmptyComposerState();
  state.draft = 'one';
  beginSend('prompt', state);
  state.draft = 'two';
  beginSend('prompt', state);
  assert.equal(state.composerResetSeq, 2);
});

test('pasted text stays text: the pasteText webview message is gone from the protocol', () => {
  assert.equal(
    parseWebviewMessage({ type: 'pasteText', text: 'x'.repeat(5000) }),
    undefined,
    'text pastes must not round-trip to the host as chip requests'
  );
});
