import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { createInitialControllerState, type WebviewSnapshot } from '../../src/state/types';
import { createEmptyComposerState } from '../../src/webview/composer';
import { createWebviewSnapshot } from '../../src/webview/model';
import { renderChatApp } from '../../src/webview/render';

function snapshot(extra: Partial<WebviewSnapshot> = {}): WebviewSnapshot {
  return {
    ...createWebviewSnapshot(createInitialControllerState('work', '/tmp/work'), 1, {
      composer: createEmptyComposerState(),
      isTrusted: true,
      folders: [],
    }),
    sessionId: 'chat',
    sessionFile: '/tmp/work/chat.jsonl',
    connectionState: 'ready',
    bindingState: 'current',
    draft: 'Separate unsent draft',
    focus: 'none',
    messages: [
      {
        id: 'reply',
        role: 'assistant',
        text: '',
        attachments: [],
        blocks: [
          { kind: 'thinking', text: 'Private reasoning detail' },
          { kind: 'tool', name: 'read', callId: 'read-1', args: '{"path":"src/a.ts"}' },
          { kind: 'toolResult', name: 'read', callId: 'read-1', text: 'Raw source result' },
          { kind: 'text', text: 'The answer is ready.' },
        ],
      },
    ],
    ...extra,
  };
}

test('answers stay first with one closed inspector and compact details, even for live failures', () => {
  for (const busy of [false, true]) {
    const current = snapshot({ connectionState: busy ? 'busy' : 'ready', isStreaming: busy });
    current.messages[0]!.blocks!.splice(2, 1, {
      kind: 'toolResult',
      name: 'read',
      callId: 'read-1',
      text: 'Detailed failure',
      isError: true,
    });
    const doc = new JSDOM(renderChatApp(current)).window.document;
    const reply = doc.querySelector('.assistant-turn')!;
    assert.match(reply.textContent!, /The answer is ready/);
    assert.doesNotMatch(
      reply.querySelector('.message-card')!.textContent!,
      /Private reasoning detail|Detailed failure|src\/a.ts/
    );
    assert.equal(reply.querySelector('.turn-issue'), null);
    assert.match(reply.querySelector('.activity-attention')!.textContent!, /Failure reported/);
    assert.equal(doc.querySelectorAll('[data-inline-activity]').length, 1);
    assert.equal(doc.querySelector<HTMLDetailsElement>('[data-inline-activity]')!.open, false);
    assert.equal(reply.querySelector('details.work-phase'), reply.lastElementChild);
    assert.equal(
      reply.querySelector('[data-inline-activity] > summary')!.nextElementSibling?.className,
      'activity-content'
    );
    for (const detail of doc.querySelectorAll<HTMLDetailsElement>(
      '[data-inline-activity] [data-raw-details]'
    ))
      assert.equal(detail.open, false);
    assert.equal(doc.querySelectorAll('#chat-settings [data-model-tools]').length, 1);
    assert.equal(doc.querySelectorAll('#chat-settings .mcp-connections').length, 1);
    assert.equal(
      doc.querySelector(
        '[data-inline-activity] [data-model-tools], [data-inline-activity] .mcp-connections'
      ),
      null
    );
  }
});

test('orphan tool results never expand raw output into the transcript', () => {
  const doc = new JSDOM(
    renderChatApp(
      snapshot({
        messages: [
          { id: 'orphan', role: 'toolResult', text: 'RAW_ORPHAN_OUTPUT', attachments: [] },
        ],
      })
    )
  ).window.document;
  assert.doesNotMatch(
    doc.querySelector('#messages .message-card')!.textContent!,
    /RAW_ORPHAN_OUTPUT/
  );
  assert.match(doc.querySelector('[data-inline-activity]')!.textContent!, /RAW_ORPHAN_OUTPUT/);
  assert.ok(doc.querySelector('#messages [data-inline-activity] > summary'));
});

const bundle = build({
  entryPoints: ['src/webview/media/chat.ts'],
  bundle: true,
  platform: 'browser',
  format: 'iife',
  write: false,
});
async function frame() {
  const dom = new JSDOM('<div id="app"></div>', {
    pretendToBeVisual: true,
    runScripts: 'outside-only',
    url: 'https://webview.test/',
  });
  const w = dom.window,
    posted: Array<Record<string, unknown>> = [];
  Object.assign(w, {
    acquireVsCodeApi: () => ({
      postMessage: (m: Record<string, unknown>) => posted.push(m),
      getState() {},
      setState() {},
    }),
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    IntersectionObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    matchMedia: () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
    }),
  });
  w.HTMLElement.prototype.scrollTo = () => {};
  w.HTMLElement.prototype.scrollIntoView = () => {};
  w.eval((await bundle).outputFiles[0]!.text);
  const send = async (extra: Partial<WebviewSnapshot> = {}) => {
    w.dispatchEvent(
      new w.MessageEvent('message', { data: { type: 'snapshot', snapshot: snapshot(extra) } })
    );
    await new Promise((resolve) => setTimeout(resolve, 180));
  };
  return { dom, w, posted, send };
}

test('header opens the same inline disclosure; keyboard and passive updates preserve details and draft', async () => {
  const f = await frame();
  try {
    await f.send();
    const doc = f.w.document,
      panel = () => doc.querySelector<HTMLDetailsElement>('[data-inline-activity]')!;
    const field = doc.querySelector<HTMLTextAreaElement>('#composer-field')!;
    field.value = 'Newer local typing';
    field.dispatchEvent(new f.w.Event('input', { bubbles: true }));
    const summary = doc.querySelector<HTMLElement>('[data-inline-activity] > summary')!;
    doc.querySelector<HTMLButtonElement>('[data-show-latest-activity]')!.click();
    assert.equal(panel().open, true);
    assert.equal(doc.activeElement, summary);
    const details = doc.querySelector<HTMLDetailsElement>(
      '[data-inline-activity] [data-raw-details]'
    )!;
    details.open = true;
    const sources = doc.querySelector<HTMLButtonElement>('[data-activity-tab="output"]')!;
    sources.focus();
    sources.dispatchEvent(new f.w.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    assert.equal(doc.activeElement?.getAttribute('data-activity-tab'), 'sources');
    await f.send({ sequence: 2, statuses: { changed: 'status' } });
    assert.equal(panel().open, true);
    assert.equal(
      doc.querySelector<HTMLDetailsElement>('[data-inline-activity] [data-raw-details]')!.open,
      true
    );
    assert.equal(
      doc.querySelector('[aria-selected="true"]')?.getAttribute('data-activity-tab'),
      'sources'
    );
    assert.equal(doc.querySelector<HTMLTextAreaElement>('#composer-field')!, field);
    assert.equal(field.value, 'Newer local typing');
    doc.activeElement!.dispatchEvent(
      new f.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
    );
    assert.equal(panel().open, false);
    assert.equal(doc.activeElement, doc.querySelector('[data-show-latest-activity]'));
    assert.equal(field.value, 'Newer local typing');
    const settings = doc.querySelector<HTMLDetailsElement>('#chat-settings')!;
    settings.open = true;
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(panel().open, false);
    await f.send({ sequence: 3, sessionId: 'other', sessionFile: '/tmp/work/other.jsonl' });
    assert.equal(panel().open, false);
    assert.equal(doc.querySelector<HTMLDetailsElement>('#chat-settings')!.open, false);
    assert.equal(
      doc.querySelector('[aria-selected="true"]')?.getAttribute('data-activity-tab'),
      'output'
    );
  } finally {
    f.dom.window.close();
  }
});

test('one failure cue follows the selected pane while detailed failure remains inspectable', async () => {
  const f = await frame();
  try {
    const style = f.w.document.createElement('style');
    style.textContent = readFileSync('src/webview/media/chat.css', 'utf8');
    f.w.document.head.append(style);
    const current = snapshot();
    current.messages[0]!.blocks![2] = {
      kind: 'toolResult',
      name: 'read',
      callId: 'read-1',
      text: 'Exact original failure',
      isError: true,
    };
    current.activity = {
      tools: [],
      files: [],
      statuses: [],
      output: '',
      agents: [
        {
          id: 'child',
          toolCallId: 'read-1',
          role: 'reviewer',
          status: 'failed',
          live: false,
          reason: 'Child failure',
        },
      ],
    };
    await f.send(current);
    const doc = f.w.document,
      panel = doc.querySelector<HTMLDetailsElement>('[data-inline-activity]')!,
      cue = panel.querySelector<HTMLElement>('.activity-attention')!;
    assert.notEqual(f.w.getComputedStyle(cue).display, 'none');
    assert.equal(doc.querySelector('.turn-issue'), null);
    panel.querySelector<HTMLElement>(':scope > summary')!.click();
    assert.equal(panel.open, true);
    assert.equal(f.w.getComputedStyle(cue).display, 'none');
    assert.match(panel.querySelector('[data-work-call] > summary')!.textContent!, /Failed/);
    panel.querySelector<HTMLButtonElement>('[data-activity-tab="sources"]')!.click();
    assert.equal(panel.dataset.selectedActivity, 'sources');
    assert.notEqual(f.w.getComputedStyle(cue).display, 'none');
    panel.querySelector<HTMLButtonElement>('[data-activity-tab="agents"]')!.click();
    assert.equal(f.w.getComputedStyle(cue).display, 'none');
    assert.match(
      panel.querySelector('.reported-agent > details > summary')!.textContent!,
      /Failed/
    );
    panel.querySelector<HTMLDetailsElement>('.reported-agent-details')!.open = true;
    assert.match(panel.querySelector('.reported-agent-body')!.textContent!, /Child failure/);
  } finally {
    f.dom.window.close();
  }
});

test('activity panels fit narrow panes in both themes without changing transcript or composer widths', () => {
  const css = readFileSync('src/webview/media/chat.css', 'utf8');
  for (const theme of ['vscode-light', 'vscode-dark']) {
    const doc = new JSDOM(
      `<style>${css}</style><body class="${theme}">${renderChatApp(snapshot())}</body>`
    ).window.document;
    for (const selector of ['[data-inline-activity]', '#chat-settings']) {
      const el = doc.querySelector<HTMLElement>(selector)!;
      const style = doc.defaultView!.getComputedStyle(el);
      assert.equal(style.position, selector === '#chat-settings' ? 'absolute' : 'static');
      assert.equal(style.maxWidth, selector === '#chat-settings' ? 'calc(100% - 24px)' : '100%');
    }
    assert.equal(doc.querySelectorAll('#composer-field').length, 1);
  }
});

test('header controls have reserved space outside the independently scrolling transcript', () => {
  const css = readFileSync('src/webview/media/chat.css', 'utf8');
  for (const theme of ['vscode-light', 'vscode-dark']) {
    const dom = new JSDOM(
      `<style>${css}</style><body class="${theme}">${renderChatApp(snapshot())}</body>`
    );
    const doc = dom.window.document;
    const style = (selector: string) => dom.window.getComputedStyle(doc.querySelector(selector)!);
    const layout = style('.layout');
    assert.equal(layout.display, 'flex');
    assert.equal(layout.flexDirection, 'column');
    assert.equal(layout.boxSizing, 'border-box');
    assert.equal(style('#messages').overflowY, 'auto');
    for (const [control, face] of [
      ['.activity-shortcut', '.activity-shortcut'],
      ['#chat-settings', '#chat-settings > summary'],
    ]) {
      assert.equal(doc.querySelector(control!)!.closest('#messages'), null);
      const controlBottom =
        Number.parseFloat(style(control!).top) + Number.parseFloat(style(face!).minHeight);
      assert.ok(
        Number.parseFloat(layout.paddingTop) >= controlBottom,
        `${control} must fit in reserved space above the transcript`
      );
    }
  }
});

test('two replies keep independent inline disclosure and tabs; header opens the latest same body', async () => {
  const f = await frame();
  try {
    const messages = snapshot().messages;
    messages.push(
      { id: 'next-user', role: 'user', text: 'Next question', attachments: [] },
      {
        id: 'next-reply',
        role: 'assistant',
        text: '',
        attachments: [],
        blocks: [
          { kind: 'tool', name: 'read', callId: 'next-read', args: '{"path":"second.ts"}' },
          { kind: 'toolResult', name: 'read', callId: 'next-read', text: 'SECOND_ONLY_LOG' },
          { kind: 'text', text: 'Second answer' },
        ],
      }
    );
    await f.send({ messages });
    const doc = f.w.document,
      panels = [...doc.querySelectorAll<HTMLDetailsElement>('[data-inline-activity]')];
    assert.equal(panels.length, 2);
    panels[0]!.querySelector<HTMLElement>(':scope > summary')!.click();
    panels[0]!.querySelector<HTMLButtonElement>('[data-activity-tab="sources"]')!.click();
    assert.equal(panels[0]!.open, true);
    assert.equal(panels[1]!.open, false);
    const latestBody = panels[1]!.querySelector('.activity-content');
    const shortcut = doc.querySelector<HTMLButtonElement>('[data-show-latest-activity]')!;
    shortcut.click();
    assert.equal(doc.querySelectorAll('[data-inline-activity]').length, 2);
    assert.equal(panels[1]!.querySelector('.activity-content'), latestBody);
    assert.equal(panels[1]!.open, true);
    assert.equal(panels[0]!.open, true);
    assert.equal(shortcut.getAttribute('aria-controls'), panels[1]!.id);
    assert.equal(doc.activeElement, panels[1]!.querySelector(':scope > summary'));
    assert.equal(
      panels[0]!.querySelector('[aria-selected="true"]')?.getAttribute('data-activity-tab'),
      'sources'
    );
    assert.equal(
      panels[1]!.querySelector('[aria-selected="true"]')?.getAttribute('data-activity-tab'),
      'output'
    );
    assert.doesNotMatch(panels[0]!.textContent!, /SECOND_ONLY_LOG/);
    assert.doesNotMatch(panels[1]!.textContent!, /Raw source result/);
    await f.send({ sequence: 2, messages, statuses: { remote: 'changed' } });
    assert.equal(panels[0]!.open, true);
    assert.equal(panels[1]!.open, true);
    assert.equal(
      panels[0]!.querySelector('[aria-selected="true"]')?.getAttribute('data-activity-tab'),
      'sources'
    );
    assert.equal(
      doc.querySelector<HTMLTextAreaElement>('#composer-field')!.value,
      'Separate unsent draft'
    );
  } finally {
    f.dom.window.close();
  }
});

test('answer-only SSH updates leave a closed history inspector untouched and refresh it on demand', async () => {
  const f = await frame();
  try {
    const messages: WebviewSnapshot['messages'] = Array.from({ length: 40 }, (_, index) => ({
      id: `history-${index}`,
      role: index % 2 ? 'assistant' : 'user',
      text: 'Earlier content '.repeat(20),
      attachments: [],
    }));
    messages.push({
      id: 'live',
      role: 'assistant',
      text: 'Streaming answer',
      attachments: [],
      blocks: [
        { kind: 'tool', name: 'read', callId: 'tool', args: '{"path":"src/a.ts"}' },
        { kind: 'text', text: 'Streaming answer' },
      ],
    });
    const activity = {
      tools: [{ id: 'tool', name: 'bash', status: 'running' as const }],
      files: [{ path: 'src/a.ts' }],
      statuses: [],
      output: 'first output',
    };
    await f.send({
      messages,
      activity,
      connectionState: 'busy',
      isStreaming: true,
      currentAssistantMessageId: 'live',
    });
    const panel = f.w.document.querySelector<HTMLDetailsElement>('[data-inline-activity]')!;
    const before = panel.innerHTML;
    await f.send({
      sequence: 2,
      messages: [
        ...messages.slice(0, -1),
        {
          ...messages.at(-1)!,
          text: 'Streaming answer grows',
          blocks: [messages.at(-1)!.blocks![0]!, { kind: 'text', text: 'Streaming answer grows' }],
        },
      ],
      activity,
      connectionState: 'busy',
      isStreaming: true,
      currentAssistantMessageId: 'live',
    });
    assert.equal(panel.open, false);
    assert.equal(panel.innerHTML, before, 'hidden history is not rebuilt on answer deltas');
    panel.open = true;
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.match(panel.textContent!, /first output/);
    const output = panel.querySelector('.activity-output')!;
    await f.send({
      sequence: 3,
      messages: [
        ...messages.slice(0, -1),
        {
          ...messages.at(-1)!,
          text: 'Streaming answer grows again',
          blocks: [
            messages.at(-1)!.blocks![0]!,
            { kind: 'text', text: 'Streaming answer grows again' },
          ],
        },
      ],
      activity,
      connectionState: 'busy',
      isStreaming: true,
      currentAssistantMessageId: 'live',
    });
    assert.equal(
      panel.querySelector('.activity-output'),
      output,
      'unchanged open activity also avoids rebuilding'
    );
    panel.querySelector<HTMLButtonElement>('[data-activity-tab="sources"]')!.click();
    panel.querySelector<HTMLButtonElement>('[data-file-open]')!.click();
    assert.deepEqual(
      f.posted.filter((item) => item.type === 'openFile').map((item) => item.path),
      ['src/a.ts']
    );
  } finally {
    f.dom.window.close();
  }
});
