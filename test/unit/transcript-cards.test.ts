import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

test('each Pi reply has one soft card with unboxed work details and full pane width', () => {
  const css = readFileSync('src/webview/media/chat.css', 'utf8');
  const dom = new JSDOM(
    `<style>${css}</style><main id="messages"><article class="message-card message-user"><div class="message-role">You</div><div class="message-body">Question</div></article><article class="message-card message-assistant"><div class="message-body"><details class="work-phase" open><summary class="work-phase-head">Working</summary><div class="tl-node"><details class="tl-card tl-thinking" open><summary class="tl-head"><span class="tl-label">Thinking</span></summary><div class="tl-body">Reasoning</div></details></div><div class="tl-node"><details class="tl-card tl-tool" open><summary class="tl-head">read · file.ts</summary><div class="tl-body">File output</div></details></div></details><section class="tl-card tl-answer"><div class="tl-body">Response<div class="code-wrap"><div class="code-lang">Mermaid<button>Preview</button></div><pre class="code-block">graph LR</pre></div></div></section></div></article></main>`
  );
  const card = dom.window.document.querySelector('.message-assistant')!;
  const turn = dom.window.document.createElement('section');
  turn.className = 'assistant-turn';
  card.before(turn);
  turn.append(card);
  turn.insertAdjacentHTML('afterbegin', '<div class="message-role">Pi</div>');
  const computed = (selector: string) =>
    dom.window.getComputedStyle(dom.window.document.querySelector(selector)!);
  dom.window.document.querySelector('.message-assistant .message-body')!.classList.add('timeline');
  const reply = computed('.assistant-turn');
  assert.equal(reply.background, 'var(--pi-surface-group)');
  assert.equal(reply.borderRadius, '14px');
  assert.equal(reply.width, '100%');
  for (const selector of ['.work-phase', '.tl-thinking', '.tl-tool', '.tl-answer']) {
    const style = computed(selector);
    assert.equal(style.backgroundColor, 'rgba(0, 0, 0, 0)', `${selector} has no nested card fill`);
    assert.equal(style.borderTopWidth, '0px');
    assert.match(style.borderRadius, /^0(?:px)?$/);
  }
  assert.equal(computed('.message-user').alignItems, 'flex-end');
  assert.equal(computed('.message-user .message-role').textAlign, 'right');
  assert.equal(computed('.message-user .message-body').borderRadius, '14px 14px 4px 14px');
  assert.equal(computed('.message-assistant .message-body').width, '100%');
  assert.equal(computed('.timeline').width, '100%');
  assert.equal(computed('.assistant-turn > .message-role').fontSize, '12px');
  assert.equal(computed('.work-phase .tl-thinking').borderTopWidth, '0px');
  assert.equal(dom.window.document.querySelector('.code-lang button')?.textContent, 'Preview');
  assert.match(css, /#messages \.clampable\.expanded \.clamp-body\s*\{\s*max-height: none;/);
  assert.match(css, /\.approval-card/);
  dom.window.close();
});
