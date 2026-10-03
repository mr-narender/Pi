import assert from 'node:assert/strict';
import test from 'node:test';
import { beginSend, buildSendPreview, createEmptyComposerState } from '../../src/webview/composer';

const names =
  'settings model tree thinking scoped-models export import share bug copy name session changelog hotkeys fork clone trust login logout new compact resume reload quit debug arminsayshi dementedelves'.split(
    ' '
  );

for (const route of ['editor', 'sidebar'] as const) {
  for (const mode of ['prompt', 'steer', 'follow_up'] as const) {
    test(`core safety: ${route} ${mode} retains all reserved drafts and attachments`, () => {
      for (const name of names) {
        const state = createEmptyComposerState();
        state.draft = `/${name} argument`;
        state.pendingImages = [
          {
            itemId: 'image',
            name: 'fixture.png',
            mimeType: 'image/png',
            sizeBytes: 3,
            inMemoryBase64: 'AAAA',
          },
        ];
        const before = structuredClone(state);
        assert.throws(
          () => (route === 'editor' ? beginSend(mode, state) : buildSendPreview(mode, state)),
          /local GUI command/,
          `/${name} must not become a model submission`
        );
        assert.deepEqual(state, before);
      }
    });
  }
}

test('core safety: prefixes, qualified resources and manual skills retain native routing', () => {
  for (const draft of [
    '/modelish',
    '/skill:model args',
    '/extension:model args',
    '/Model',
    'Discuss /model',
  ]) {
    const state = createEmptyComposerState();
    state.draft = draft;
    assert.equal(buildSendPreview('prompt', state).rpcMessage, draft);
  }
});
