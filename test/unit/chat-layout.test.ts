import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

test('assistant layout has no timeline rail or marker styling', () => {
  const css = readFileSync('src/webview/media/chat.css', 'utf8');
  assert.doesNotMatch(css, /\.timeline::before/);
  assert.doesNotMatch(css, /\.tl-dot/);
});

test('approved clean design layer replaces glass effects with theme-aware flat surfaces', () => {
  const css = readFileSync('src/webview/media/chat.css', 'utf8');
  const layer = css.slice(css.lastIndexOf('Apple-inspired clean design layer'));
  assert.match(layer, /--pi-surface-group:/);
  assert.match(layer, /\.chat-list-group\s*\{/);
  assert.match(layer, /#messages \.message-assistant \.message-body\s*\{/);
  assert.match(layer, /backdrop-filter:\s*none/);
  assert.match(layer, /background-image:\s*none/);
});

test('chat list uses whitespace-only rows without a connected group surface or dividers', () => {
  const css = readFileSync('src/webview/media/chat.css', 'utf8');
  const layer = css.slice(css.lastIndexOf('Apple-inspired clean design layer'));
  assert.match(layer, /\.chat-list-group\s*\{[^}]*border:\s*0;[^}]*background:\s*transparent;/s);
  assert.match(layer, /\.chat-list-row\s*\{[^}]*margin:\s*3px 0;[^}]*border-radius:\s*8px;/s);
  assert.doesNotMatch(layer, /\.chat-list-group \.chat-list-row:not\(:last-child\)::after/);
});

test('the stylesheet has one design system with no retired glass layer', () => {
  const css = readFileSync('src/webview/media/chat.css', 'utf8');
  assert.doesNotMatch(css, /Refined Glass|--glass-|--ember(?:-|:)/);
  assert.doesNotMatch(css, /backdrop-filter:\s*(?:blur|saturate)/);

  const layer = css.slice(css.lastIndexOf('Apple-inspired clean design layer'));
  for (const selector of [
    '.composer-dock',
    '.approval-card',
    '.banner',
    '.menu-panel',
    '.code-wrap',
    '.session-details',
    '.plan-strip',
    '.api-error-card',
    '.chat-list-group',
  ]) {
    assert.ok(layer.includes(selector), `${selector} must be covered by the final design layer`);
  }
});

test('Mermaid responses use the full width before the async SVG loads', () => {
  const css = readFileSync('src/webview/media/chat.css', 'utf8');
  const dom = new JSDOM(`
    <style>${css}</style>
    <main id="messages">
      <article class="message-card message-assistant">
        <div class="message-body"><div class="mermaid-wrap"></div></div>
        <div class="timeline"><div class="mermaid-wrap"></div></div>
      </article>
    </main>
  `);
  for (const selector of ['.message-body', '.timeline']) {
    const style = dom.window.getComputedStyle(dom.window.document.querySelector(selector)!);
    assert.equal(style.width, '100%', `${selector} must not shrink-wrap a pending diagram`);
    assert.equal(style.alignSelf, 'stretch');
  }
  dom.window.close();
});

test('expanded Mermaid keeps a compact header above a centered diagram', () => {
  const css = readFileSync('src/webview/media/chat.css', 'utf8');
  const dom = new JSDOM(`
    <style>${css}</style>
    <section class="modal-backdrop mermaid-dialog">
      <div class="modal-card mermaid-dialog-card">
        <div class="mermaid-dialog-head"><h2>Mermaid preview</h2><button class="code-btn">×</button></div>
        <div class="mermaid-dialog-output"><img /></div>
      </div>
    </section>
  `);
  const card = dom.window.getComputedStyle(
    dom.window.document.querySelector('.mermaid-dialog-card')!
  );
  const close = dom.window.getComputedStyle(
    dom.window.document.querySelector('.mermaid-dialog-head .code-btn')!
  );
  const image = dom.window.getComputedStyle(
    dom.window.document.querySelector('.mermaid-dialog-output img')!
  );
  assert.equal(card.gridTemplateRows, 'auto minmax(0, 1fr)');
  assert.equal(card.gap, '0px');
  assert.equal(close.backgroundColor, 'rgba(0, 0, 0, 0)');
  assert.equal(close.width, '28px');
  assert.equal(image.maxWidth, '100%');
  assert.equal(image.maxHeight, '100%');
  dom.window.close();
});

test('chat rendering never creates background untitled formatter documents', () => {
  const tabManager = readFileSync('src/editorTabs/tabManager.ts', 'utf8');
  const extensionUi = readFileSync('src/ui/extensionUiBroker.ts', 'utf8');
  const settings = readFileSync('src/config/settings.ts', 'utf8');
  const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as {
    contributes?: { configuration?: { properties?: Record<string, unknown> } };
  };
  assert.doesNotMatch(tabManager, /CodeFormatService|collectCodeFences|formatCodeBlocks/);
  assert.doesNotMatch(tabManager, /openTextDocument\(\{\s*(?:content|language)/);
  assert.doesNotMatch(extensionUi, /openTextDocument\(\{/);
  assert.doesNotMatch(settings, /formatCodeBlocks/);
  assert.equal(
    manifest.contributes?.configuration?.properties?.['piRpc.formatCodeBlocks'],
    undefined
  );
});

test('webview bundle ships exact license files for every bundled dependency', () => {
  const build = readFileSync('scripts/build.mjs', 'utf8');
  assert.match(build, /legalComments:\s*'external'/);
  assert.match(build, /metafile:\s*true/);
  assert.match(build, /Bundled dependency has no distributed license file/);
  assert.match(build, /dist\/THIRD_PARTY_NOTICES\.txt/);
});
