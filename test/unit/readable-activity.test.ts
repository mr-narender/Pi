import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { createInitialControllerState, type WebviewSnapshot } from '../../src/state/types';
import { createWebviewSnapshot } from '../../src/webview/model';
import { createEmptyComposerState } from '../../src/webview/composer';
import { renderChatApp } from '../../src/webview/render';

function denseSnapshot(): WebviewSnapshot {
  const snapshot = createWebviewSnapshot(createInitialControllerState('work', '/tmp/work'), 1, {
    composer: createEmptyComposerState(),
    isTrusted: true,
    folders: [],
  });
  snapshot.connectionState = 'busy';
  snapshot.isStreaming = true;
  snapshot.messages = [
    { id: 'user', role: 'user', text: 'Make activity readable', attachments: [] },
  ];
  for (let index = 0; index < 8; index++)
    snapshot.messages.push({
      id: `read-message-${index}`,
      role: 'assistant',
      text: '',
      attachments: [],
      blocks: [
        ...(index < 5
          ? [{ kind: 'thinking' as const, text: `REASONING_${index}: inspect this actual step` }]
          : []),
        {
          kind: 'tool',
          name: 'read',
          callId: `read-${index}`,
          args: JSON.stringify({ path: `src/file-${index}.ts`, offset: index + 1, limit: 40 }),
        },
        {
          kind: 'toolResult',
          name: 'read',
          callId: `read-${index}`,
          text: `UNIQUE_READ_RESULT_${index}`,
          durationMs: index + 2,
        },
      ],
    });
  snapshot.messages.push({
    id: 'delegation',
    role: 'assistant',
    text: '',
    attachments: [],
    blocks: [
      {
        kind: 'tool',
        name: 'delegate_tasks',
        callId: 'delegate-one',
        args: JSON.stringify({ tasks: [{ role: 'worker', task: 'Implement inline activity' }] }),
      },
      {
        kind: 'toolResult',
        name: 'delegate_tasks',
        callId: 'delegate-one',
        text: 'Implementation returned; verification pending.',
        durationMs: 2400,
      },
      {
        kind: 'tool',
        name: 'delegate_tasks',
        callId: 'delegate-two',
        args: JSON.stringify({
          tasks: [
            { role: 'worker', task: 'Check behavior' },
            { role: 'reviewer', task: 'Review behavior' },
          ],
        }),
      },
      {
        kind: 'toolResult',
        name: 'delegate_tasks',
        callId: 'delegate-two',
        text: 'One reviewer stopped before a result.',
        isError: true,
        durationMs: 3100,
      },
      { kind: 'text', text: 'The answer stays visible.' },
    ],
  });
  snapshot.activity = {
    tools: [],
    output: '',
    files: [],
    statuses: [
      { label: 'MCP', text: 'MCP_RAW_STATUS' },
      { label: 'ponytail', text: 'PONYTAIL_RAW_STATUS' },
      { label: 'manager', text: 'MANAGER_RAW_STATUS' },
      { label: 'task', text: 'TASK_RAW_STATUS' },
    ],
    agents: [
      {
        id: 'worker-1',
        toolCallId: 'delegate-one',
        role: 'worker',
        status: 'completed',
        live: false,
        output: 'Worker result; unverified',
      },
      {
        id: 'worker-2',
        toolCallId: 'delegate-two',
        role: 'worker',
        status: 'completed',
        live: false,
        output: 'Check report; unverified',
      },
      {
        id: 'reviewer-3',
        toolCallId: 'delegate-two',
        role: 'reviewer',
        status: 'failed',
        live: false,
        reason: 'REVIEW_FAILURE_REASON',
      },
    ],
  };
  return snapshot;
}

test('dense activity groups every original read and reasoning entry without repetitive Details links', () => {
  const doc = new JSDOM(renderChatApp(denseSnapshot())).window.document;
  const activity = doc.querySelector<HTMLDetailsElement>('[data-inline-activity]')!;
  assert.equal(activity.open, false);
  const reads = activity.querySelector<HTMLDetailsElement>('[data-work-group="reads"]')!;
  assert.ok(reads);
  assert.equal(reads.open, false);
  assert.match(reads.querySelector(':scope > summary')!.textContent!, /Read 8 files/);
  assert.equal(reads.querySelectorAll('[data-work-call]').length, 8);
  for (let index = 0; index < 8; index++) {
    const call = reads.querySelector(`[data-work-call="read-${index}"]`)!;
    assert.match(call.querySelector('summary')!.textContent!, new RegExp(`src/file-${index}\\.ts`));
    assert.match(call.textContent!, new RegExp(`UNIQUE_READ_RESULT_${index}`));
    assert.match(call.textContent!, /offset/);
    assert.ok(call.querySelector(`[data-duration-ms="${index + 2}"]`));
  }
  const reasoning = activity.querySelector<HTMLDetailsElement>('[data-work-group="reasoning"]')!;
  assert.ok(reasoning);
  assert.equal(reasoning.open, false);
  assert.match(reasoning.querySelector(':scope > summary')!.textContent!, /5/);
  for (let index = 0; index < 5; index++)
    assert.match(reasoning.textContent!, new RegExp(`REASONING_${index}`));
  assert.ok(
    [...activity.querySelectorAll('summary')].every(
      (summary) => summary.textContent?.trim() !== 'Details'
    )
  );
  assert.equal(activity.querySelectorAll('[data-work-call^="delegate-"]').length, 2);
  assert.match(
    activity.querySelector('[data-work-call="delegate-one"] > summary')!.textContent!,
    /Implement inline activity/
  );
  assert.equal(
    doc.querySelector('.turn-issue'),
    null,
    'do not repeat failure prose above the disclosure'
  );
  assert.match(
    activity.querySelector('[data-work-call="delegate-two"] > summary')!.textContent!,
    /Failed/i
  );
  const runtime = activity.querySelector<HTMLDetailsElement>('[data-work-group="runtime"]')!;
  assert.ok(runtime);
  assert.equal(runtime.open, false);
  for (const text of [
    'MCP_RAW_STATUS',
    'PONYTAIL_RAW_STATUS',
    'MANAGER_RAW_STATUS',
    'TASK_RAW_STATUS',
  ])
    assert.match(runtime.textContent!, new RegExp(text));
  assert.equal(doc.querySelectorAll('[data-agent-call]').length, 3);
  assert.doesNotMatch(activity.textContent!, /verified success|verification complete/i);
});

test('read grouping counts exact files separately from calls and keeps chronology and failures inspectable', () => {
  const snapshot = denseSnapshot();
  snapshot.messages = snapshot.messages.slice(0, 3);
  for (const message of snapshot.messages)
    for (const block of message.blocks ?? []) {
      if (block.kind === 'tool') block.args = '{"path":"same.ts","offset":1}';
      if (block.kind === 'toolResult' && block.callId === 'read-1') block.isError = true;
    }
  const doc = new JSDOM(renderChatApp(snapshot)).window.document;
  const group = doc.querySelector('[data-work-group="reads"]')!;
  assert.match(group.querySelector(':scope > summary')!.textContent!, /Read 1 file/);
  assert.match(group.querySelector(':scope > summary')!.textContent!, /2 calls/);
  assert.match(group.querySelector(':scope > summary')!.textContent!, /failed/i);
  assert.deepEqual(
    [...group.querySelectorAll('[data-work-call]')].map((node) =>
      node.getAttribute('data-work-call')
    ),
    ['read-0', 'read-1']
  );
  assert.match(group.textContent!, /Activity item/);
});

test('activity navigation is content width and metadata stays beside the meaningful label', () => {
  const dom = new JSDOM(
    `<style>${readFileSync('src/webview/media/chat.css', 'utf8')}</style>${renderChatApp(denseSnapshot())}`
  );
  const doc = dom.window.document,
    tabs = doc.querySelector('.activity-tabs')!;
  assert.equal(dom.window.getComputedStyle(tabs).width, 'fit-content');
  assert.equal(dom.window.getComputedStyle(tabs.querySelector('button')!).flex, '0 0 auto');
  const row = doc.querySelector('[data-work-call="read-0"] > summary')!;
  assert.ok(row.querySelector('.activity-row-copy > .activity-row-title'));
  assert.ok(row.querySelector('.activity-row-copy > .activity-row-meta [data-duration-ms]'));
});

test('a single read uses its own filename disclosure and never implies unreceived results', () => {
  const snapshot = denseSnapshot();
  snapshot.messages = snapshot.messages.slice(0, 2);
  snapshot.messages[1]!.blocks = snapshot.messages[1]!.blocks!.filter(
    (block) => block.kind === 'tool'
  );
  snapshot.activity!.tools = [{ id: 'read-0', name: 'read', status: 'running' }];
  let doc = new JSDOM(renderChatApp(snapshot)).window.document;
  assert.equal(doc.querySelector('[data-work-group="reads"]'), null);
  assert.match(
    doc.querySelector('[data-work-call] > summary')!.textContent!,
    /src\/file-0.ts[\s\S]*Working/
  );
  assert.doesNotMatch(
    doc.querySelector('[data-work-call] > summary')!.textContent!,
    /Result received/
  );
  snapshot.bindingState = 'cached';
  doc = new JSDOM(renderChatApp(snapshot)).window.document;
  assert.match(
    doc.querySelector('[data-work-call] > summary')!.textContent!,
    /Last reported: Running/
  );
});

test('mixed grouped reads retain actual running, requested, failed and unavailable states', () => {
  const snapshot = denseSnapshot();
  snapshot.messages = snapshot.messages.slice(0, 5);
  for (const message of snapshot.messages)
    message.blocks = message.blocks?.filter((block) => block.kind === 'tool');
  snapshot.activity!.tools = [
    { id: 'read-0', name: 'read', status: 'running' },
    { id: 'read-1', name: 'read', status: 'error' },
    { id: 'read-2', name: 'read', status: 'completed' },
  ];
  const doc = new JSDOM(renderChatApp(snapshot)).window.document;
  const group = doc.querySelector('[data-work-group="reads"]')!;
  assert.match(
    group.querySelector(':scope > summary')!.textContent!,
    /1 working.*1 failed.*1 completion reported; result unavailable.*1 requested/
  );
  assert.doesNotMatch(group.textContent!, /Result received|verified/i);
  assert.match(doc.querySelector('.activity-attention')!.textContent!, /Failure reported/);
});

test('original edit payload, diff and actions stay accessible while generated Mermaid stays visible', () => {
  const snapshot = denseSnapshot();
  snapshot.messages = [
    {
      id: 'diagram',
      role: 'assistant',
      text: '',
      attachments: [],
      blocks: [
        {
          kind: 'tool',
          name: 'write',
          callId: 'write-diagram',
          args: JSON.stringify({
            path: 'diagram.mmd',
            content: 'flowchart LR\nA-->B',
            customOption: 'ORIGINAL_EXTRA_ARGUMENT',
          }),
        },
        {
          kind: 'toolResult',
          name: 'write',
          callId: 'write-diagram',
          text: 'ORIGINAL_WRITE_RESULT',
          durationMs: 4,
        },
        { kind: 'text', text: 'Created a diagram.' },
      ],
    },
  ];
  const doc = new JSDOM(renderChatApp(snapshot)).window.document;
  const mermaid = doc.querySelector('.mermaid-wrap')!;
  assert.ok(mermaid);
  assert.equal(mermaid.closest('details:not([open])'), null);
  assert.equal(mermaid.closest('[data-inline-activity]'), null);
  const row = doc.querySelector('[data-work-call="write-diagram"]')!;
  assert.match(row.textContent!, /ORIGINAL_EXTRA_ARGUMENT/);
  assert.match(row.textContent!, /ORIGINAL_WRITE_RESULT/);
  for (const selector of [
    '[data-file-open="diagram.mmd"]',
    '[data-file-diff="diagram.mmd"]',
    '.ed-undo',
  ])
    assert.ok(row.querySelector(selector), selector);
});
