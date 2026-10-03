import assert from 'node:assert/strict';
import test from 'node:test';
import { linkifyFileMentions } from '../../src/webview/render';

test('linkifyFileMentions: backticked path (with and without :line) becomes clickable', () => {
  const withLine = linkifyFileMentions(
    '<code class="inline-code">src/webview/render.ts:611</code>'
  );
  assert.ok(withLine.includes('data-file-open="src/webview/render.ts:611"'));
  assert.ok(withLine.includes('file-link'));
  const noLine = linkifyFileMentions('<code class="inline-code">src/webview/render.ts</code>');
  assert.ok(noLine.includes('data-file-open="src/webview/render.ts"'));
});

test('linkifyFileMentions: bare mention requires :line (precision guard)', () => {
  const bare = linkifyFileMentions('see src/editorTabs/tabManager.ts:646 for the handler.');
  assert.ok(bare.includes('data-file-open="src/editorTabs/tabManager.ts:646"'));
  assert.ok(bare.endsWith('</a> for the handler.'));
  const noLine = linkifyFileMentions('see src/editorTabs/tabManager.ts for the handler.');
  assert.ok(!noLine.includes('data-file-open'), 'bare path without :line must stay plain');
});

test('linkifyFileMentions: path:line:col supported, trailing punctuation excluded', () => {
  const html = linkifyFileMentions('crash at src/a/b.ts:12:5.');
  assert.ok(html.includes('data-file-open="src/a/b.ts:12:5"'));
  assert.ok(html.endsWith('</a>.'));
});

test('linkifyFileMentions: non-paths never match', () => {
  for (const text of [
    'ratio is 3:1 today',
    'a plain sentence with no paths',
    'npm package @scope/name has no extension',
    'https://example.com/a/b.ts:12 stays a URL',
    '<code class="inline-code">not a path</code>',
    '<code class="inline-code">SELECT 1</code>',
  ]) {
    const out = linkifyFileMentions(text);
    assert.ok(!out.includes('data-file-open'), `unexpected link in: ${text}`);
  }
});

test('linkifyFileMentions: never rewrites inside existing tag attributes', () => {
  const attr = '<a class="md-link" data-href="https://x.dev/src/a.ts:12">x</a>';
  assert.equal(linkifyFileMentions(attr), attr);
});
