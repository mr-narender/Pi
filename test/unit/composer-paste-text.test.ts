import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PASTE_CHIP_MIN_CHARS,
  PASTE_CHIP_MIN_LINES,
  capturePastedText,
  chipPrivacyLabel,
  persistableComposerState,
  serializeContextEnvelope,
  shouldAttachPastedText,
  summarizeChip,
  createEmptyComposerState,
  type PendingContextItem,
} from '../../src/webview/composer';
import { parseWebviewMessage } from '../../src/webview/messages';

test('shouldAttachPastedText: small pastes stay plain text, big ones become chips', () => {
  assert.equal(shouldAttachPastedText('hello world'), false);
  assert.equal(shouldAttachPastedText('line\n'.repeat(PASTE_CHIP_MIN_LINES - 2)), false);
  assert.equal(shouldAttachPastedText('line\n'.repeat(PASTE_CHIP_MIN_LINES + 1)), true);
  assert.equal(shouldAttachPastedText('x'.repeat(PASTE_CHIP_MIN_CHARS)), true);
  assert.equal(shouldAttachPastedText(''), false);
});

test('capturePastedText: builds a self-contained pastedText item with sane labels', () => {
  const text = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n');
  const item = capturePastedText('workspace', text);
  assert.ok(item);
  assert.equal(item!.kind, 'pastedText');
  assert.equal(item!.lineStart, 1);
  assert.equal(item!.lineEnd, 40);
  assert.equal(item!.languageId, 'plaintext');
  assert.match(item!.workspaceRelativePath, /^Pasted text \d+$/);
  assert.equal(item!.sanitizedContent.includes('line 40'), true);
  assert.ok(summarizeChip(item!).includes('40 lines'));
  assert.equal(chipPrivacyLabel(item!), 'Pasted clipboard text');
});

test('capturePastedText: whitespace-only paste is rejected', () => {
  assert.equal(capturePastedText('workspace', '   \n\n  '), undefined);
});

test('capturePastedText: oversized paste is bounded at capture so send never rejects it', () => {
  const huge = 'x'.repeat(200_000) + '\n' + 'y'.repeat(1000);
  const item = capturePastedText('workspace', huge);
  assert.ok(item);
  // The send-envelope path re-applies the same bounds and THROWS on any
  // item still over them — a captured item must always pass.
  const { envelope } = serializeContextEnvelope([item!]);
  assert.ok(envelope && envelope.includes('"kind":"pastedText"'));
});

test('pastedText: persist strips content from the item but the ref keeps it (restore source)', () => {
  const item = capturePastedText('workspace', 'line\n'.repeat(30))!;
  const state = createEmptyComposerState();
  state.pendingContextItems = [item];
  const persisted = persistableComposerState(state);
  const stored = persisted.pendingContextItems[0] as Partial<PendingContextItem> & {
    persistedRef?: { content?: string };
  };
  assert.equal('sanitizedContent' in stored, false);
  assert.equal(stored.persistedRef?.content, item.sanitizedContent);
});

test('parseWebviewMessage: pasteText accepted, empty/malformed rejected', () => {
  assert.deepEqual(parseWebviewMessage({ type: 'pasteText', text: 'abc' }), {
    type: 'pasteText',
    text: 'abc',
  });
  assert.equal(parseWebviewMessage({ type: 'pasteText', text: '' }), undefined);
  assert.equal(parseWebviewMessage({ type: 'pasteText' }), undefined);
  assert.equal(parseWebviewMessage({ type: 'pasteText', text: 42 }), undefined);
});
