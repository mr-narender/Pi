// Pasted TEXT stays plain text in the composer — the capture path is gone.
// What remains under test: backward compatibility for 'pastedText' chips that
// older versions persisted (they must still summarize, serialize, and persist).
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  chipPrivacyLabel,
  createEmptyComposerState,
  persistableComposerState,
  serializeContextEnvelope,
  summarizeChip,
  type PendingContextItem,
} from '../../src/webview/composer';

function legacyPastedTextItem(lines: number): PendingContextItem {
  const content = Array.from({ length: lines }, (_, i) => `line ${i + 1}`).join('\n');
  return {
    kind: 'pastedText',
    itemId: 'paste-legacy-1',
    workspaceFolder: 'workspace',
    workspaceRelativePath: 'Pasted text 1',
    lineStart: 1,
    lineEnd: lines,
    languageId: 'plaintext',
    sanitizedContent: content,
    capturedAt: new Date().toISOString(),
    persistedRef: {
      workspaceRelativePath: 'Pasted text 1',
      lineStart: 1,
      lineEnd: lines,
      languageId: 'plaintext',
      contentFingerprint: 'deadbeef',
      content,
    },
  } as PendingContextItem;
}

test('legacy pastedText chips still summarize and label correctly', () => {
  const item = legacyPastedTextItem(40);
  assert.ok(summarizeChip(item).includes('40 lines'));
  assert.equal(chipPrivacyLabel(item), 'Pasted clipboard text');
});

test('legacy pastedText chips still serialize into the send envelope', () => {
  const { envelope } = serializeContextEnvelope([legacyPastedTextItem(30)]);
  assert.ok(envelope && envelope.includes('"kind":"pastedText"'));
});

test('legacy pastedText chips still persist content in the ref (restore source)', () => {
  const item = legacyPastedTextItem(30);
  const state = createEmptyComposerState();
  state.pendingContextItems = [item];
  const persisted = persistableComposerState(state);
  const stored = persisted.pendingContextItems[0] as Partial<PendingContextItem> & {
    persistedRef?: { content?: string };
  };
  assert.equal('sanitizedContent' in stored, false);
  assert.equal(stored.persistedRef?.content, item.sanitizedContent);
});
