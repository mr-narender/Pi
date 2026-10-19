import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createInitialControllerState } from '../../src/state/types';
import { createWebviewSnapshot } from '../../src/webview/model';
import { createEmptyComposerState } from '../../src/webview/composer';
import { renderActivityContent, renderChatApp } from '../../src/webview/render';
import { reduceEvent } from '../../src/state/reducer';

function fixture() {
  let state = createInitialControllerState('work', '/tmp/work');
  state.connectionState = 'busy';
  state.messages = [
    { role: 'user', id: 'u1', content: 'Work' },
    {
      role: 'assistant',
      id: 'a1',
      content: [{ type: 'toolCall', id: 'delegate-1', name: 'delegate_tasks', arguments: {} }],
    },
  ];
  const snapshot = () =>
    createWebviewSnapshot(state, 1, {
      composer: createEmptyComposerState(),
      isTrusted: true,
      folders: [],
    });
  const event = (value: Parameters<typeof reduceEvent>[1]) => {
    state = reduceEvent(state, value);
  };
  event({
    type: 'tool_execution_start',
    toolCallId: 'delegate-1',
    toolName: 'delegate_tasks',
    args: {},
  });
  const update = (status = 'running', extra = {}) =>
    event({
      type: 'tool_execution_update',
      toolCallId: 'delegate-1',
      partialResult: {
        content: [{ type: 'text', text: 'Reported progress' }],
        details: {
          parentToolCallId: 'delegate-1',
          children: [
            { id: 'batch/0', parentToolCallId: 'delegate-1', role: 'worker', status, ...extra },
          ],
        },
      },
    });
  return {
    get state() {
      return state;
    },
    snapshot,
    update,
    event,
  };
}

test('native delegate progress reaches the owning quiet footer and updates by child identity', () => {
  const f = fixture();
  f.update();
  assert.equal(f.snapshot().activity?.agents?.[0]?.status, 'running');
  f.update('completed', { verified: false, output: 'Changed one file; needs parent verification' });
  assert.equal(f.snapshot().activity?.agents?.length, 1);
  assert.equal(f.snapshot().activity?.agents?.[0]?.status, 'completed');
  const doc = new JSDOM(renderChatApp(f.snapshot())).window.document;
  assert.match(
    doc.querySelector('#turn-a1 [data-inline-activity] > summary')!.textContent!,
    /1 agent/
  );
  const row = doc.querySelector('[data-inline-activity] [data-agent-call="delegate-1"]');
  assert.ok(row);
  assert.match(row.textContent!, /Result received/);
  assert.match(row.textContent!, /not independently verified/i);
  assert.equal(row.querySelector('button'), null, 'no unsupported child cancellation');
});

test('child state is never inferred from a parent result or arbitrary prose and payloads', () => {
  const f = fixture();
  f.update('running');
  f.event({
    type: 'tool_execution_end',
    toolCallId: 'delegate-1',
    isError: false,
    result: { content: [{ type: 'text', text: 'Launched background worker successfully' }] },
  });
  assert.equal(f.snapshot().activity?.agents?.[0]?.status, 'running');
  const doc = new JSDOM(renderChatApp(f.snapshot())).window.document;
  assert.match(doc.querySelector('.reported-agent')!.textContent!, /Last reported: Running/);
  f.state.tools[0]!.name = 'bash';
  f.state.messages = [];
  assert.equal(f.snapshot().activity?.agents?.length ?? 0, 0);
  assert.doesNotMatch(renderActivityContent(f.snapshot()), /Agents|No subagent/);
});

test('unknown child state and mismatched ownership do not become completed or live', () => {
  const f = fixture();
  f.update('new-backend-state');
  assert.equal(f.snapshot().activity?.agents?.[0]?.status, 'unknown');
  f.update('running', { parentToolCallId: 'different-parent' });
  assert.equal(f.snapshot().activity?.agents?.length ?? 0, 0);
});

test('all native terminal states stay distinct without claiming verified success', () => {
  for (const status of ['failed', 'cancelled', 'timeout', 'output_limit']) {
    const f = fixture();
    f.update(status);
    assert.equal(f.snapshot().activity?.agents?.[0]?.status, status);
    assert.doesNotMatch(
      new JSDOM(renderChatApp(f.snapshot())).window.document.querySelector('.reported-agent')!
        .textContent!,
      /Result received/
    );
  }
});

test('native saved results reconstruct agents without live flags and preserve turn ownership', () => {
  const f = fixture();
  f.state.tools = [];
  f.state.messages.push(
    {
      role: 'toolResult',
      toolCallId: 'delegate-1',
      toolName: 'delegate_tasks',
      content: [{ type: 'text', text: 'result' }],
      details: {
        parentToolCallId: 'delegate-1',
        children: [
          { id: 'batch/0', parentToolCallId: 'delegate-1', role: 'reviewer', status: 'running' },
        ],
      },
    },
    { role: 'user', id: 'u2', content: 'Next question' },
    { role: 'assistant', id: 'a2', content: 'Another reply' }
  );
  const doc = new JSDOM(renderChatApp(f.snapshot())).window.document;
  assert.match(
    doc.querySelector('[data-inline-activity] [data-agent-call="delegate-1"]')!.textContent!,
    /Last reported: Running/
  );
  assert.equal(doc.querySelector('#turn-a2 .reported-agent'), null);
  for (const bindingState of ['cached', 'draft'] as const) {
    f.update();
    assert.doesNotMatch(
      new JSDOM(renderChatApp({ ...f.snapshot(), bindingState })).window.document.querySelector(
        '.reported-agent'
      )!.textContent!,
      /Working/
    );
  }
});

test('reported checklists move into their own response footer without a second pinned plan', () => {
  const f = fixture();
  f.state.messages[1]!.content = 'Plan\n- [x] Trace history\n- [ ] Check switching';
  const doc = new JSDOM(renderChatApp(f.snapshot())).window.document;
  assert.match(doc.querySelector('[data-turn-activity="a1"]')!.textContent!, /Reported tasks/);
  assert.match(
    doc.querySelector('#turn-a1 [data-inline-activity] > summary')!.textContent!,
    /1\/2 tasks/
  );
  assert.equal(doc.querySelector('.layout > .plan-strip'), null);
  assert.equal(doc.querySelectorAll('.reported-tasks').length, 1);
});

test('reported child fields are escaped, redacted, bounded and exclude unapproved metadata', () => {
  const f = fixture();
  f.update('completed', {
    output: '<img src=x onerror=bad> sk-abcdefghijklmno ' + 'text '.repeat(10000),
    reason: '<script>bad</script>',
    verified: false,
    private: 'PRIVATE_DETAIL',
  });
  const projected = f.snapshot().activity!;
  assert.doesNotMatch(JSON.stringify(projected), /sk-|PRIVATE_DETAIL/);
  assert.ok((projected.agents?.[0]?.output?.length ?? 0) <= 1001);
  const doc = new JSDOM(renderChatApp(f.snapshot())).window.document;
  assert.equal(doc.querySelector('.reported-agent img, .reported-agent script'), null);
  assert.match(doc.querySelector('.reported-agent')!.textContent!, /<img/);
});

test('complete native final snapshots replace partial states and deduplicate child identity', () => {
  const f = fixture();
  f.update();
  f.event({
    type: 'tool_execution_end',
    toolCallId: 'delegate-1',
    isError: true,
    result: {
      content: [{ type: 'text', text: 'Batch ended' }],
      details: {
        parentToolCallId: 'delegate-1',
        children: [
          { id: 'batch/0', parentToolCallId: 'delegate-1', role: 'worker', status: 'running' },
          {
            id: 'batch/0',
            parentToolCallId: 'delegate-1',
            role: 'worker',
            status: 'failed',
            reason: 'Command failed',
          },
        ],
      },
    },
  });
  assert.equal(f.snapshot().activity?.agents?.length, 1);
  assert.equal(f.snapshot().activity?.agents?.[0]?.status, 'failed');
  assert.equal(f.snapshot().activity?.agents?.[0]?.live, false);
});

test('child payload has aggregate limits and vanished session calls clear projected agents', () => {
  const f = fixture();
  f.state.tools[0]!.partialResult = {
    details: {
      parentToolCallId: 'delegate-1',
      children: Array.from({ length: 100 }, (_, i) => ({
        id: `batch/${i}`,
        parentToolCallId: 'delegate-1',
        role: 'worker',
        status: 'completed',
        output: 'test '.repeat(3000),
        reason: 'reason '.repeat(2000),
        usage: { secret: 'UNAPPROVED_METADATA' },
      })),
    },
  };
  const activity = f.snapshot().activity!;
  assert.ok(activity.agents!.length <= 16);
  assert.ok(activity.agents!.reduce((sum, agent) => sum + (agent.output?.length ?? 0), 0) <= 4004);
  assert.ok(JSON.stringify(activity).length < 16000);
  assert.doesNotMatch(JSON.stringify(activity), /UNAPPROVED_METADATA/);
  f.state.messages = [{ id: 'new', role: 'assistant', content: 'Different session' }];
  assert.equal(f.snapshot().activity?.agents?.length, 0);
});

test('agent rows are folded native disclosures and have distinct identities across activity surfaces', () => {
  const f = fixture();
  f.update();
  const doc = new JSDOM(renderChatApp(f.snapshot())).window.document;
  const rows = [...doc.querySelectorAll<HTMLDetailsElement>('.reported-agent-details')];
  assert.equal(rows.length, 1, 'one shared inspector, no duplicated agent output');
  assert.ok(rows.every((row) => !row.open && row.firstElementChild?.tagName === 'SUMMARY'));
  assert.equal(new Set(rows.map((row) => row.id)).size, rows.length);
});

test('recent running agents remain visible when earlier reported children exceed the cap', () => {
  const f = fixture();
  const oldChildren = Array.from({ length: 16 }, (_, index) => ({
    id: `old/${index}`,
    parentToolCallId: 'delegate-1',
    role: 'worker',
    status: 'completed',
  }));
  f.state.tools[0]!.result = { details: { parentToolCallId: 'delegate-1', children: oldChildren } };
  f.state.tools[0]!.endedAt = 2;
  f.state.messages.push(
    { id: 'u2', role: 'user', content: 'Next task' },
    {
      id: 'a2',
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'delegate-2', name: 'delegate_tasks', arguments: {} }],
    }
  );
  f.state.tools.push({
    id: 'delegate-2',
    name: 'delegate_tasks',
    startedAt: 3,
    partialResult: {
      details: {
        parentToolCallId: 'delegate-2',
        children: [
          { id: 'new/0', parentToolCallId: 'delegate-2', role: 'reviewer', status: 'running' },
        ],
      },
    },
  });
  assert.ok(f.snapshot().activity?.agents?.some((agent) => agent.id === 'new/0'));
  assert.match(
    new JSDOM(renderChatApp(f.snapshot())).window.document.querySelector(
      '[data-inline-activity] [data-agent-call="delegate-2"]'
    )!.textContent!,
    /Working/
  );
});

test('a later response checklist does not remove the earlier response task progress', () => {
  const f = fixture();
  f.state.messages[1]!.content = '- [x] Trace history\n- [ ] Check switching';
  f.state.messages.push(
    { id: 'u2', role: 'user', content: 'Next task' },
    { id: 'a2', role: 'assistant', content: '- [x] Read source\n- [ ] Run checks' }
  );
  const doc = new JSDOM(renderChatApp(f.snapshot())).window.document;
  assert.match(
    doc.querySelector('[data-turn-activity="a1"] .reported-tasks')!.textContent!,
    /Trace history/
  );
  assert.match(
    doc.querySelector('[data-turn-activity="a2"] .reported-tasks')!.textContent!,
    /Read source/
  );
});
