import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { createInitialControllerState, type WebviewSnapshot } from '../../src/state/types';
import { createEmptyComposerState } from '../../src/webview/composer';
import { createWebviewSnapshot } from '../../src/webview/model';
import { renderChatApp } from '../../src/webview/render';

function snapshot(): WebviewSnapshot {
  return {
    ...createWebviewSnapshot(createInitialControllerState('work', '/tmp/work'), 1, {
      composer: createEmptyComposerState(),
      isTrusted: true,
      folders: [],
    }),
    connectionState: 'busy',
    bindingState: 'current',
    isStreaming: true,
    messages: [{ id: 'ack', role: 'assistant', text: 'I will check that.', attachments: [] }],
  };
}

function documentFor(current: WebviewSnapshot): Document {
  return new JSDOM(renderChatApp(current)).window.document;
}

test('work updates do not accumulate blank reply rows after an acknowledgment', () => {
  const current = snapshot();
  for (let index = 0; index < 12; index++) {
    current.messages.push({
      id: `work-${index}`,
      role: 'assistant',
      text: '',
      attachments: [],
      blocks: [
        { kind: 'thinking', text: `Reasoning ${index}` },
        { kind: 'tool', name: 'read', callId: `call-${index}`, args: `{"path":"${index}.ts"}` },
      ],
    });
    current.currentAssistantMessageId = `work-${index}`;
    let document = documentFor(current);
    assert.equal(
      document.querySelectorAll('.assistant-turn > .message-card').length,
      1,
      'only the acknowledgment occupies reply space while raw work is in Activity'
    );
    current.messages.push({
      id: `result-${index}`,
      role: 'toolResult',
      text: `Source output ${index}`,
      attachments: [],
    });
    document = documentFor(current);
    assert.equal(document.querySelectorAll('.assistant-turn > .message-card').length, 1);
    assert.match(document.querySelector('[data-inline-activity]')!.textContent!, /Source output/);
    assert.equal(document.querySelectorAll('.assistant-turn').length, 1);
    assert.equal(document.querySelectorAll('[data-file-open]').length, index + 1);
  }
  for (const text of ['Done.', 'A longer final answer. '.repeat(30)]) {
    current.messages.push({ id: 'answer', role: 'assistant', text, attachments: [] });
    for (const busy of [true, false]) {
      current.connectionState = busy ? 'busy' : 'ready';
      current.isStreaming = busy;
      current.currentAssistantMessageId = busy ? 'answer' : undefined;
      const document = documentFor(current);
      assert.equal(document.querySelectorAll('.assistant-turn > .message-card').length, 2);
      assert.match(document.querySelector('.assistant-turn')!.textContent!, /I will check that/);
      assert.match(
        document.querySelector('[data-mid="answer"]')!.textContent!,
        new RegExp(text.slice(0, 10))
      );
    }
    current.messages.pop();
  }
});

test('work-only replies preserve activity, sources, file previews and provider errors', () => {
  const current = snapshot();
  current.messages = [
    {
      id: 'write',
      role: 'assistant',
      text: '',
      attachments: [],
      blocks: [
        {
          kind: 'tool',
          name: 'write',
          callId: 'diagram',
          args: JSON.stringify({ path: 'diagram.mmd', content: 'flowchart LR\n A --> B' }),
        },
        {
          kind: 'toolResult',
          name: 'write',
          callId: 'diagram',
          text: 'Successfully wrote diagram.mmd',
        },
      ],
    },
    { id: 'result', role: 'toolResult', text: 'Successfully wrote diagram.mmd', attachments: [] },
  ];
  let document = documentFor(current);
  assert.equal(document.querySelectorAll('.assistant-turn').length, 1);
  assert.equal(document.querySelectorAll('.assistant-turn > .message-card').length, 1);
  assert.ok(document.querySelector('.mermaid-wrap'));
  assert.match(
    document.querySelector('[data-inline-activity]')!.textContent!,
    /Successfully wrote/
  );
  assert.equal(
    document.querySelector('[data-file-open]')!.getAttribute('data-file-open'),
    'diagram.mmd'
  );
  current.messages[0]!.blocks = [
    { kind: 'tool', name: 'read', callId: 'read', args: '{"path":"source.ts"}' },
  ];
  current.messages[0]!.reportedTasks = {
    items: [{ text: 'Inspect source', done: true }],
    done: 1,
  };
  current.activity = {
    tools: [],
    files: [],
    statuses: [],
    output: '',
    agents: [
      {
        id: 'child',
        toolCallId: 'read',
        role: 'reviewer',
        status: 'failed',
        live: false,
        reason: 'Check failed',
      },
    ],
  };
  document = documentFor(current);
  assert.equal(document.querySelectorAll('.assistant-turn').length, 1);
  assert.equal(document.querySelectorAll('.assistant-turn > .message-card').length, 0);
  assert.ok(document.querySelector('[data-inline-activity]'));
  assert.match(document.querySelector('.reported-tasks')!.textContent!, /Inspect source/);
  assert.match(document.querySelector('.reported-agents')!.textContent!, /reviewer/);
  assert.match(document.querySelector('.activity-attention')!.textContent!, /Failure reported/);
  current.messages.push({
    id: 'error',
    role: 'assistant',
    text: '',
    errorMessage: 'Provider failed',
    attachments: [],
  });
  document = documentFor(current);
  assert.match(document.querySelector('[data-mid="error"]')!.textContent!, /Provider failed/);
});

test('Manual Mode indicates selection only when enabled', () => {
  const css = readFileSync('src/webview/media/chat.css', 'utf8');
  assert.equal(css.includes('.permission-toggle.is-auto'), false);
  assert.ok(
    /\.follow-toggle\.is-on,\s*\.permission-toggle\.is-on\s*\{[^}]*background:\s*var\(--pi-surface-selected\)/s.test(
      css
    )
  );
});
