import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { renderChatApp } from '../../src/webview/render';
import { createWebviewSnapshot } from '../../src/webview/model';
import { createInitialControllerState } from '../../src/state/types';
import { createEmptyComposerState } from '../../src/webview/composer';

test('each reply owns its normal-flow activity body below its native summary, without a second overlay', () => {
  const snapshot = createWebviewSnapshot(createInitialControllerState('work', '/tmp/work'), 1, {
    composer: createEmptyComposerState(),
    isTrusted: true,
    folders: [],
  });
  snapshot.connectionState = 'busy';
  snapshot.isStreaming = true;
  snapshot.messages = [
    {
      id: 'one',
      role: 'assistant',
      text: '',
      attachments: [],
      blocks: [
        { kind: 'tool', name: 'read', callId: 'call-one', args: '{"path":"first.ts"}' },
        { kind: 'toolResult', name: 'read', callId: 'call-one', text: 'FIRST_RAW_OUTPUT' },
        { kind: 'text', text: 'First answer' },
      ],
    },
    { id: 'user', role: 'user', text: 'Next', attachments: [] },
    {
      id: 'two',
      role: 'assistant',
      text: '',
      attachments: [],
      blocks: [
        { kind: 'tool', name: 'read', callId: 'call-two', args: '{"path":"second.ts"}' },
        {
          kind: 'toolResult',
          name: 'read',
          callId: 'call-two',
          text: 'SECOND_RAW_OUTPUT',
          isError: true,
        },
        { kind: 'text', text: 'Second answer' },
      ],
    },
  ];
  snapshot.activity = {
    tools: [],
    output: '',
    statuses: [],
    files: [{ path: 'first.ts' }, { path: 'second.ts' }],
  };
  for (const theme of ['vscode-light', 'vscode-dark']) {
    const dom = new JSDOM(
      `<style>${readFileSync('src/webview/media/chat.css', 'utf8')}</style><body class="${theme}">${renderChatApp(snapshot)}</body>`
    );
    const doc = dom.window.document;
    for (const [id, own, other, file] of [
      ['one', 'FIRST_RAW_OUTPUT', 'SECOND_RAW_OUTPUT', 'first.ts'],
      ['two', 'SECOND_RAW_OUTPUT', 'FIRST_RAW_OUTPUT', 'second.ts'],
    ]) {
      const reply = doc.getElementById(`turn-${id}`)!;
      const disclosure = reply.querySelector<HTMLDetailsElement>('[data-inline-activity]')!;
      assert.ok(disclosure, 'activity is a descendant of its owning reply');
      assert.equal(disclosure.open, false, 'live and failed activity never auto-expands');
      assert.equal(disclosure, reply.lastElementChild);
      const summary = disclosure.querySelector(':scope > summary')!;
      const body = disclosure.querySelector<HTMLElement>(':scope > .activity-content')!;
      assert.equal(summary.nextElementSibling, body);
      assert.match(body.textContent!, new RegExp(own!));
      assert.doesNotMatch(body.textContent!, new RegExp(other!));
      assert.equal(body.querySelector('[data-file-open]')?.getAttribute('data-file-open'), file);
      assert.ok(
        !['absolute', 'fixed', 'sticky'].includes(dom.window.getComputedStyle(disclosure).position)
      );
      assert.ok(
        !['absolute', 'fixed', 'sticky'].includes(dom.window.getComputedStyle(body).position)
      );
      for (const details of disclosure.querySelectorAll<HTMLDetailsElement>('[data-raw-details]'))
        assert.equal(details.open, false);
    }
    assert.equal(doc.querySelector('.layout > .activity-panel'), null);
    assert.equal(doc.querySelectorAll('#chat-settings [data-model-tools]').length, 1);
    assert.equal(doc.querySelectorAll('#chat-settings .mcp-connections').length, 1);
    assert.equal(
      new Set([...doc.querySelectorAll('[id]')].map((node) => node.id)).size,
      doc.querySelectorAll('[id]').length
    );
  }
});

test('historical sources retain exact turn paths and later text replies inherit no retained tool output', () => {
  const snapshot = createWebviewSnapshot(createInitialControllerState('work', '/tmp/work'), 1, {
    composer: createEmptyComposerState(),
    isTrusted: true,
    folders: [],
  });
  snapshot.messages = [
    {
      id: 'first',
      role: 'assistant',
      text: '',
      attachments: [],
      blocks: [
        {
          kind: 'tool',
          name: 'read',
          callId: 'first-call',
          args: '{"path":"/workspace/src/a.ts"}',
        },
        { kind: 'text', text: 'First answer' },
      ],
    },
    { id: 'u2', role: 'user', text: 'Next', attachments: [] },
    {
      id: 'second',
      role: 'assistant',
      text: '',
      attachments: [],
      blocks: [
        { kind: 'tool', name: 'read', callId: 'second-call', args: '{"path":"/other/src/a.ts"}' },
        { kind: 'text', text: 'Second answer' },
      ],
    },
    { id: 'u3', role: 'user', text: 'Thanks', attachments: [] },
    { id: 'third', role: 'assistant', text: 'Welcome', attachments: [] },
  ];
  snapshot.activity = {
    tools: [{ id: 'second-call', name: 'read', status: 'completed' }],
    output: 'RETAINED_OLD_LOG',
    files: [{ path: 'src/a.ts' }],
    statuses: [],
  };
  for (const activity of [
    snapshot.activity,
    { ...snapshot.activity, tools: [], output: '', files: [] },
  ]) {
    const doc = new JSDOM(renderChatApp({ ...snapshot, activity })).window.document;
    assert.equal(
      doc.querySelector('#turn-first [data-file-open]')?.getAttribute('data-file-open'),
      '/workspace/src/a.ts'
    );
    assert.equal(
      doc.querySelector('#turn-second [data-file-open]')?.getAttribute('data-file-open'),
      '/other/src/a.ts'
    );
    assert.equal(doc.querySelector('#turn-third [data-inline-activity]'), null);
    assert.doesNotMatch(doc.querySelector('#turn-third')!.textContent!, /RETAINED_OLD_LOG|read/);
  }
});

test('attached and captured user files keep Sources available for a plain-text reply', () => {
  const snapshot = createWebviewSnapshot(createInitialControllerState('work', '/tmp/work'), 1, {
    composer: createEmptyComposerState(),
    isTrusted: true,
    folders: [],
  });
  snapshot.messages = [
    {
      id: 'user-files',
      role: 'user',
      text: 'Explain these files',
      attachments: [
        {
          type: 'file',
          name: 'attached.ts',
          mimeType: 'text/plain',
          hasContent: true,
          previewItems: [],
          fileRef: { uri: 'file:///tmp/work/attached.ts', path: '/tmp/work/attached.ts' },
        },
      ],
      capturedContext: [
        {
          kind: 'pickedFile',
          path: 'captured.ts',
          lineStart: 1,
          lineEnd: 1,
          content: 'source',
          fileRef: { uri: 'file:///tmp/work/captured.ts', path: '/tmp/work/captured.ts' },
        },
      ],
    },
    { id: 'plain-answer', role: 'assistant', text: 'Here is the explanation.', attachments: [] },
  ];
  const doc = new JSDOM(renderChatApp(snapshot)).window.document;
  const activity = doc.querySelector<HTMLDetailsElement>(
    '#turn-plain-answer [data-inline-activity]'
  );
  assert.ok(activity, 'source-only replies still have an inline disclosure');
  assert.equal(activity.open, false);
  assert.deepEqual(
    [...activity.querySelectorAll('[data-activity-view="sources"] [data-file-open]')].map((node) =>
      node.getAttribute('data-file-open')
    ),
    ['/tmp/work/captured.ts', '/tmp/work/attached.ts']
  );
  assert.equal(activity.querySelector('[data-activity-tab="agents"]'), null);
});
