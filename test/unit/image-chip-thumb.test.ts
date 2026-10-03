// Reported live: pasting an image produced only a text-label chip ("Image:
// pasted-…") — the preview existed but only inside the collapsed details.
// These pin the always-visible summary thumbnail.
import assert from 'node:assert/strict';
import test from 'node:test';
import { renderChatApp } from '../../src/webview/render';
import type { WebviewSnapshot } from '../../src/state/types';

function snapshot(image: Record<string, unknown>): WebviewSnapshot {
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
    messageCount: 0,
    pendingMessageCount: 0,
    messages: [],
    queue: { steering: [], followUp: [] },
    draft: '',
    statuses: {},
    widgets: [],
    model: { provider: 'mock', id: 'model' },
    thinkingLevel: 'medium',
    pendingContextItems: [],
    pendingImages: [image],
    focus: 'composer',
    isTrusted: true,
    folders: [{ name: 'workspace', uri: 'file:///tmp/workspace', active: true }],
  } as unknown as WebviewSnapshot;
}

const dataUrl = 'data:image/png;base64,iVBORw0KGgo=';

test('image chip: thumbnail-ONLY summary — enlarged preview, no visible name (name stays accessible)', () => {
  const html = renderChatApp(
    snapshot({
      itemId: 'img-1',
      name: 'pasted-123.png',
      mimeType: 'image/png',
      sizeBytes: 10,
      previewDataUrl: dataUrl,
    })
  );
  assert.ok(html.includes('class="chip-thumb"'), 'summary thumbnail missing');
  assert.ok(
    !/chip-thumb[^>]*\/>\s*Image: pasted-123\.png/.test(html),
    'no visible name text next to the thumbnail'
  );
  assert.match(html, /aria-label="Image: pasted-123\.png"/, 'name must remain accessible');
  assert.match(html, /title="pasted-123\.png"/, 'name available on hover');
  assert.ok(html.includes('class="image-preview"'), 'expanded full preview stays');
});

test('image chip: requiresReselect (expired) renders no thumbnail, keeps the warning path', () => {
  const html = renderChatApp(
    snapshot({
      itemId: 'img-2',
      name: 'old.png',
      mimeType: 'image/png',
      sizeBytes: 10,
      requiresReselect: true,
    })
  );
  assert.ok(!html.includes('chip-thumb'));
  assert.ok(html.includes('Reselect image: old.png'));
});
