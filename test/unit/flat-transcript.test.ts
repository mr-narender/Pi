import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

test('the sole chat interface uses flat full-width transcript rows without nested cards', () => {
  const css = readFileSync('src/webview/media/chat.css', 'utf8');
  const dom = new JSDOM(
    `<style>${css}</style><main id="messages"><article class="message-card message-user"><div class="message-role">You</div><div class="message-body">Question</div></article><article class="message-card message-assistant"><div class="message-body"><details class="work-phase" open><summary class="work-phase-head">Working</summary><div class="tl-node"><details class="tl-card tl-thinking" open><summary class="tl-head"><span class="tl-label">Thinking</span></summary><div class="tl-body">Reasoning</div></details></div><div class="tl-node"><details class="tl-card tl-tool" open><summary class="tl-head">read · file.ts</summary><div class="tl-body">File output</div></details></div></details><section class="tl-card tl-answer"><div class="tl-body">Response<div class="code-wrap"><div class="code-lang">Mermaid<button>Preview</button></div><pre class="code-block">graph LR</pre></div></div></section></div></article></main>`
  );
  const computed = (selector: string) =>
    dom.window.getComputedStyle(dom.window.document.querySelector(selector)!);
  dom.window.document.querySelector('.message-assistant .message-body')!.classList.add('timeline');
  for (const selector of [
    '.message-user .message-body',
    '.message-assistant .message-body',
    '.work-phase',
    '.tl-thinking',
    '.tl-tool',
    '.tl-answer',
  ]) {
    const style = computed(selector);
    assert.equal(style.backgroundColor, 'rgba(0, 0, 0, 0)', `${selector} has no card fill`);
    assert.equal(style.borderTopWidth, '0px', `${selector} has no card border`);
    assert.match(style.borderRadius, /^0(?:px)?$/, `${selector} has no card corners`);
    assert.equal(style.padding, '0px', `${selector} has no card padding`);
    assert.match(style.height, /^(?:auto)?$/, `${selector} grows with content`);
    assert.match(style.maxHeight, /^(?:none)?$/, `${selector} has no fixed clipping height`);
  }
  assert.equal(computed('.message-user').alignItems, 'flex-start');
  assert.equal(computed('.message-user .message-role').textAlign, 'left');
  assert.equal(computed('.message-user .message-body').maxWidth, '100%');
  assert.equal(computed('.message-user .message-body').width, '100%');
  assert.equal(computed('.timeline').width, '100%');
  assert.equal(computed('.tl-label').textTransform, 'none');
  assert.equal(dom.window.document.querySelector('.code-lang button')?.textContent, 'Preview');
  assert.match(css, /#messages \.clampable\.expanded \.clamp-body\s*\{\s*max-height: none;/);
  assert.match(css, /\.approval-card/);
  dom.window.close();
});
