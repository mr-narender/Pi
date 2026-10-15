import assert from 'node:assert/strict';
import test from 'node:test';
import { renderRichText } from '../../src/webview/render';

test('live code keeps readable markup and defers syntax highlighting until settlement', () => {
  const raw = '```typescript\nexport const value = "<remote>";\n```';
  const live = renderRichText(raw, true);
  assert.ok(live.includes('&lt;remote&gt;'));
  assert.ok(live.includes('code-copy'));
  assert.ok(!live.includes('hljs-keyword'), 'live repaint must not re-highlight the entire fence');
  assert.ok(renderRichText(raw).includes('hljs-keyword'), 'settled output retains highlighting');
});
