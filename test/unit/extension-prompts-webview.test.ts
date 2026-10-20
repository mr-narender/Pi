import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { renderChatApp } from '../../src/webview/render';
import { createWebviewSnapshot } from '../../src/webview/model';
import { createEmptyComposerState } from '../../src/webview/composer';
import { createInitialControllerState, type WebviewSnapshot } from '../../src/state/types';
import { parseWebviewMessage } from '../../src/webview/messages';
import { workingLabel } from '../../src/webview/working';

function snapshot(extra: Partial<WebviewSnapshot> = {}): WebviewSnapshot {
  return {
    ...createWebviewSnapshot(createInitialControllerState('project', '/tmp/project'), 1, {
      composer: createEmptyComposerState(),
      isTrusted: true,
      folders: [],
    }),
    connectionState: 'ready',
    sessionId: 'session',
    sessionFile: '/tmp/project/session.jsonl',
    catalogGeneration: 1,
    draft: 'Separate composer',
    ...extra,
  };
}
const request = (method: 'input' | 'editor' | 'select' = 'input', id = 'request') => ({
  id,
  requestKey: `key-${id}`,
  method,
  title: '<Release name>',
  placeholder: 'Release name',
  prefill: 'Initial',
  options: ['Current file', 'Workspace'],
});

test('responses require an exact bounded request key and preserve native cancellation', () => {
  const response = { type: 'respondUi', id: 'r', requestKey: 'key-r', cancelled: true };
  assert.deepEqual(parseWebviewMessage(response), response);
  for (const invalid of [
    { ...response, requestKey: '' },
    { ...response, requestKey: undefined },
    { ...response, value: 'x'.repeat(160001) },
  ])
    assert.equal(parseWebviewMessage(invalid), undefined);
});

test('extension input and select/editor Cancel are visible, escaped and separate from composer', () => {
  for (const method of ['input', 'select', 'editor'] as const) {
    const doc = new JSDOM(renderChatApp(snapshot({ approvals: [request(method)] }))).window
      .document;
    const prompt = doc.querySelector('.approval-card')!;
    assert.ok(prompt);
    assert.equal(prompt.querySelector('Release'), null);
    assert.match(prompt.querySelector('[data-ui-cancelled]')!.textContent!, /Cancel/);
    if (method === 'input') {
      assert.equal(prompt.querySelector<HTMLInputElement>('input')!.value, 'Initial');
      assert.equal(
        prompt.querySelector<HTMLInputElement>('input')!.getAttribute('aria-label'),
        '<Release name>'
      );
    }
    assert.equal(
      doc.querySelector<HTMLTextAreaElement>('#composer-field')!.value,
      'Separate composer'
    );
  }
});

const bundle = build({
  entryPoints: ['src/webview/media/chat.ts'],
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'iife',
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
      postMessage: (message: Record<string, unknown>) => posted.push(message),
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
  const post = (extra: Partial<WebviewSnapshot> = {}) => {
    w.dispatchEvent(
      new w.MessageEvent('message', { data: { type: 'snapshot', snapshot: snapshot(extra) } })
    );
  };
  const send = async (extra: Partial<WebviewSnapshot> = {}) => {
    post(extra);
    await new Promise((resolve) => setTimeout(resolve, 180));
  };
  return { dom, w, posted, send, post };
}

test('prompt editing survives unrelated snapshots without focus or composer draft loss', async () => {
  const f = await frame();
  try {
    await f.send({ approvals: [request('editor')] });
    const field = f.w.document.querySelector<HTMLTextAreaElement>('.approval-editor')!;
    field.value = 'My extension answer';
    field.focus();
    field.setSelectionRange(3, 12);
    field.dispatchEvent(new f.w.Event('input', { bubbles: true }));
    await f.send({ approvals: [request('editor')], statuses: { work: 'Working' }, sequence: 2 });
    const current = f.w.document.querySelector<HTMLTextAreaElement>('.approval-editor')!;
    assert.equal(current.value, 'My extension answer');
    assert.equal(f.w.document.activeElement, current);
    assert.equal(current.selectionStart, 3);
    assert.equal(current.selectionEnd, 12);
    assert.equal(
      f.w.document.querySelector<HTMLTextAreaElement>('#composer-field')!.value,
      'Separate composer'
    );
  } finally {
    f.dom.window.close();
  }
});

test('quiet activity shares one inspector and preserves explicit disclosure and prompt editing', async () => {
  const f = await frame();
  const live: Partial<WebviewSnapshot> = {
    bindingState: 'current',
    connectionState: 'busy',
    isStreaming: true,
    currentAssistantMessageId: 'quiet-reply',
    approvals: [request('editor')],
    messages: [
      {
        id: 'quiet-reply',
        role: 'assistant',
        text: '',
        attachments: [],
        blocks: [
          { kind: 'tool', name: 'bash', callId: 'check', args: '{"command":"PRIVATE_ARGS"}' },
          {
            kind: 'toolResult',
            name: 'bash',
            callId: 'check',
            text: 'RAW_FAILURE_LOG',
            isError: true,
          },
          { kind: 'text', text: 'The changes are ready for checking.' },
        ],
      },
    ],
  };
  try {
    await f.send(live);
    const panel = f.w.document.querySelector<HTMLDetailsElement>('[data-inline-activity]')!;
    assert.equal(panel.open, false, 'live errors must not open activity');
    const footer = f.w.document.querySelector<HTMLButtonElement>(
      '[data-inline-activity] > summary'
    )!;
    assert.ok(footer);
    assert.equal(
      footer
        .closest('.assistant-turn')!
        .querySelector('.message-card .json-view, .message-card pre'),
      null
    );
    assert.equal(f.w.document.querySelector('.turn-issue'), null);
    assert.match(panel.querySelector('.activity-attention')!.textContent!, /Failure reported/);
    const raw = f.w.document.querySelector<HTMLDetailsElement>('[data-raw-details]')!;
    assert.equal(raw.open, false);
    assert.match(raw.querySelector('summary')!.textContent!, /Failed/);
    assert.equal(f.w.document.querySelectorAll('[data-inline-activity]').length, 1);
    assert.equal(f.w.document.querySelectorAll('#chat-settings [data-model-tools]').length, 1);
    assert.equal(f.w.document.querySelectorAll('#chat-settings .mcp-connections').length, 1);
    assert.equal(panel.querySelector('[data-model-tools], .mcp-connections'), null);
    assert.equal(
      f.w.document.querySelector('[data-ui-cancelled]')!.closest('[data-inline-activity]'),
      null
    );
    footer.click();
    assert.equal(panel.open, true);
    raw.open = true;
    panel.open = false;
    const editor = f.w.document.querySelector<HTMLTextAreaElement>('.approval-editor')!;
    editor.value = 'My multiline\nanswer';
    editor.focus();
    editor.setSelectionRange(3, 12);
    await f.send({ ...live, sequence: 2, statuses: { changed: 'Still checking' } });
    assert.equal(
      f.w.document.querySelector<HTMLDetailsElement>('[data-inline-activity]')!.open,
      false
    );
    assert.equal(f.w.document.querySelector<HTMLDetailsElement>('[data-raw-details]')!.open, true);
    assert.equal(f.w.document.querySelector('.approval-editor'), editor);
    assert.equal(editor.value, 'My multiline\nanswer');
    assert.equal(editor.selectionStart, 3);
    assert.equal(editor.selectionEnd, 12);
    assert.equal(f.w.document.activeElement, editor);
  } finally {
    f.dom.window.close();
  }
});

test('streamed activity file actions and non-button file mentions keep their real handlers', async () => {
  const f = await frame();
  const messages = (args: string): WebviewSnapshot['messages'] => [
    {
      id: 'stream-actions',
      role: 'assistant',
      text: '',
      attachments: [],
      blocks: [
        { kind: 'thinking', text: 'Inspect `src/extra.ts`.' },
        { kind: 'tool', name: 'write', callId: 'write-stream', args },
        { kind: 'text', text: 'Writing the update.' },
      ],
    },
  ];
  try {
    const live = {
      bindingState: 'current' as const,
      connectionState: 'busy' as const,
      isStreaming: true,
      currentAssistantMessageId: 'stream-actions',
      typewriterSpeed: 'off' as const,
    };
    await f.send({ ...live, messages: messages('{}') });
    f.w.document.querySelector<HTMLButtonElement>('[data-inline-activity] > summary')!.click();
    await f.send({
      ...live,
      sequence: 2,
      messages: messages('{"path":"src/added.ts","content":"updated"}'),
    });
    f.w.document.querySelector<HTMLButtonElement>('[data-file-diff="src/added.ts"]')!.click();
    f.w.document.querySelector<HTMLButtonElement>('.ed-undo')!.click();
    const mention = f.w.document.querySelector<HTMLElement>('[data-file-open="src/extra.ts"]')!;
    assert.ok(mention);
    assert.notEqual(mention.tagName, 'BUTTON');
    mention.click();
    assert.ok(
      f.posted.some((message) => message.type === 'openDiff' && message.path === 'src/added.ts')
    );
    assert.ok(
      f.posted.some(
        (message) => message.type === 'screenRevert' && message.callId === 'write-stream'
      )
    );
    assert.equal(
      f.posted.filter((message) => message.type === 'openFile' && message.path === 'src/extra.ts')
        .length,
      1
    );
  } finally {
    f.dom.window.close();
  }
});

test('same-count request replacement replaces the field, and Cancel never submits its text', async () => {
  const f = await frame();
  try {
    await f.send({ approvals: [request('editor', 'old')] });
    f.w.document.querySelector<HTMLTextAreaElement>('.approval-editor')!.value = 'Old answer';
    await f.send({ approvals: [request('editor', 'new')], sequence: 2 });
    const cancel = f.w.document.querySelector<HTMLButtonElement>('[data-ui-cancelled]')!;
    assert.equal(cancel.getAttribute('data-ui-id'), 'new');
    assert.equal(
      f.w.document.querySelector<HTMLTextAreaElement>('.approval-editor')!.value,
      'Initial'
    );
    cancel.click();
    assert.deepEqual(
      f.posted
        .filter((message) => message.type === 'respondUi')
        .map((message) => [message.id, message.cancelled, message.value]),
      [['new', true, undefined]]
    );
  } finally {
    f.dom.window.close();
  }
});

test('live startup prompts enable Submit and Cancel before the session open acknowledgement', async () => {
  for (const connectionState of ['starting', 'handshaking'] as const) {
    const startup = {
      connectionState,
      bindingState: 'current' as const,
      sessionId: undefined,
      sessionFile: undefined,
    };
    for (const method of ['input', 'editor', 'select', 'confirm'] as const) {
      const doc = new JSDOM(
        renderChatApp(snapshot({ ...startup, approvals: [{ ...request(), method }] }))
      ).window.document;
      const buttons = [...doc.querySelectorAll<HTMLButtonElement>('.approval-btn')];
      assert.ok(buttons.length >= 2);
      assert.ok(
        buttons.every((button) => !button.disabled),
        `${connectionState} ${method}`
      );
    }
    const f = await frame();
    try {
      await f.send({ ...startup, approvals: [request()] });
      const field = f.w.document.querySelector<HTMLInputElement>('.approval-input')!;
      const submit = f.w.document.querySelector<HTMLButtonElement>('[data-ui-input-submit]')!;
      assert.equal(field.disabled || field.readOnly, false);
      assert.equal(submit.disabled, false);
      field.value = 'Startup answer';
      submit.click();
      await f.send({ ...startup, sequence: 2, approvals: [request('input', 'cancel')] });
      const cancel = f.w.document.querySelector<HTMLButtonElement>('[data-ui-cancelled]')!;
      assert.equal(cancel.disabled, false);
      cancel.click();
      await f.send({ ...startup, sequence: 3, approvals: [request('input', 'enter')] });
      const next = f.w.document.querySelector<HTMLInputElement>('.approval-input')!;
      next.value = 'Entered answer';
      next.dispatchEvent(new f.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      assert.deepEqual(
        f.posted
          .filter((message) => message.type === 'respondUi')
          .map((message) => [message.id, message.value, message.cancelled]),
        [
          ['request', 'Startup answer', undefined],
          ['cancel', undefined, true],
          ['enter', 'Entered answer', undefined],
        ]
      );
    } finally {
      f.dom.window.close();
    }
  }
});

test('startup prompts keep cached, switching, stopped and unconfirmed requests disabled', async () => {
  const f = await frame();
  try {
    const blocked: Partial<WebviewSnapshot>[] = [
      { bindingState: 'cached' },
      { switchingSession: true },
      { connectionState: 'stopped' },
      { connectionState: 'faulted' },
      { approvals: [{ ...request(), responseState: 'sending' }] },
      { approvals: [{ ...request(), responseState: 'unknown' }] },
      { approvals: [{ ...request(), requestKey: '' }] },
    ];
    for (const [index, extra] of blocked.entries()) {
      const state = snapshot({
        connectionState: 'starting',
        bindingState: 'current',
        approvals: [request()],
        sequence: index + 1,
        ...extra,
      });
      const doc = new JSDOM(renderChatApp(state)).window.document;
      assert.ok(
        [...doc.querySelectorAll<HTMLButtonElement>('.approval-btn')].every(
          (button) => button.disabled
        )
      );
      await f.send(state);
      const submit = f.w.document.querySelector<HTMLButtonElement>('[data-ui-input-submit]')!;
      assert.equal(submit.disabled, true);
      submit.click();
    }
    await f.send({
      connectionState: 'starting',
      sequence: 8,
      approvals: [request('input', 'expired')],
    });
    const expired = f.w.document.querySelector<HTMLButtonElement>('[data-ui-input-submit]')!;
    assert.equal(expired.disabled, false);
    await f.send({ connectionState: 'starting', sequence: 9, approvals: [] });
    expired.click();
    assert.equal(f.posted.filter((message) => message.type === 'respondUi').length, 0);
  } finally {
    f.dom.window.close();
  }
});

test('inline input submits once, respects IME composition, and Cancel sends no value', async () => {
  const f = await frame();
  try {
    await f.send({ approvals: [request()] });
    const field = f.w.document.querySelector<HTMLInputElement>('.approval-input')!;
    field.value = 'x'.repeat(160001);
    f.w.document.querySelector<HTMLButtonElement>('[data-ui-input-submit]')!.click();
    assert.equal(f.posted.filter((message) => message.type === 'respondUi').length, 0);
    assert.match(
      f.w.document.querySelector('.approval-card')!.textContent!,
      /160,000 characters or fewer/
    );
    field.value = 'Release candidate';
    field.dispatchEvent(new f.w.CompositionEvent('compositionstart', { bubbles: true }));
    const submit = f.w.document.querySelector<HTMLButtonElement>('[data-ui-input-submit]')!;
    submit.click();
    assert.equal(f.posted.filter((message) => message.type === 'respondUi').length, 0);
    field.dispatchEvent(new f.w.CompositionEvent('compositionend', { bubbles: true }));
    field.dispatchEvent(new f.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    submit.click();
    const response = f.posted.filter((message) => message.type === 'respondUi');
    assert.equal(response.length, 1);
    assert.deepEqual(
      [response[0]!.requestKey, response[0]!.value],
      ['key-request', 'Release candidate']
    );
    await f.send({ sequence: 2, approvals: [request('input', 'other')] });
    f.w.document.querySelector<HTMLButtonElement>('[data-ui-cancelled]')!.click();
    const cancel = f.posted.filter((message) => message.type === 'respondUi').at(-1)!;
    assert.equal(cancel.cancelled, true);
    assert.equal(cancel.value, undefined);
  } finally {
    f.dom.window.close();
  }
});

const proposal = {
  id: 'proposal',
  requestKey: 'key-proposal',
  method: 'set_editor_text' as const,
  prefill: '<New extension text>',
  draftRevision: 1,
  draftResetSeq: 0,
};
test('held IME Enter does not submit an inline input after composition ends', async () => {
  const f = await frame();
  try {
    await f.send({ approvals: [request()] });
    const field = f.w.document.querySelector<HTMLInputElement>('.approval-input')!;
    field.value = 'Composed answer';
    field.dispatchEvent(new f.w.CompositionEvent('compositionstart', { bubbles: true }));
    field.dispatchEvent(new f.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    field.dispatchEvent(new f.w.CompositionEvent('compositionend', { bubbles: true }));
    field.dispatchEvent(
      new f.w.KeyboardEvent('keydown', { key: 'Enter', repeat: true, bubbles: true })
    );
    assert.equal(f.posted.filter((message) => message.type === 'respondUi').length, 0);
    field.dispatchEvent(new f.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    const responses = f.posted.filter((message) => message.type === 'respondUi');
    assert.equal(responses.length, 1);
    assert.equal(responses[0]!.value, 'Composed answer');
  } finally {
    f.dom.window.close();
  }
});

test('draft proposal waits for Use or Keep and newer typing disables stale Use', async () => {
  const f = await frame();
  try {
    await f.send({ approvals: [proposal] });
    const composer = f.w.document.querySelector<HTMLTextAreaElement>('#composer-field')!;
    assert.equal(composer.value, 'Separate composer');
    assert.equal(
      f.w.document.querySelector('.approval-proposal')!.textContent,
      '<New extension text>'
    );
    composer.value = 'New local draft';
    composer.dispatchEvent(new f.w.Event('input', { bubbles: true }));
    const use = f.w.document.querySelector<HTMLButtonElement>('[data-ui-draft-use]')!;
    assert.equal(use.disabled, true);
    use.click();
    assert.equal(f.posted.filter((message) => message.type === 'respondUi').length, 0);
    f.w.document.querySelector<HTMLButtonElement>('[data-ui-confirmed="false"]')!.click();
    const keep = f.posted.filter((message) => message.type === 'respondUi').at(-1)!;
    assert.equal(keep.confirmed, false);
    assert.equal(composer.value, 'New local draft');
  } finally {
    f.dom.window.close();
  }
});

test('even an empty composer stages a suggestion and protects typing before Use', async () => {
  const f = await frame();
  try {
    await f.send({ draft: '', approvals: [proposal] });
    const composer = f.w.document.querySelector<HTMLTextAreaElement>('#composer-field')!;
    assert.equal(composer.value, '');
    assert.equal(f.posted.filter((message) => message.type === 'respondUi').length, 0);
    composer.value = 'Typed while the suggestion arrived';
    composer.dispatchEvent(new f.w.Event('input', { bubbles: true }));
    const use = f.w.document.querySelector<HTMLButtonElement>('[data-ui-draft-use]')!;
    assert.equal(use.disabled, true);
    use.click();
    assert.equal(f.posted.filter((message) => message.type === 'respondUi').length, 0);
    assert.equal(composer.value, 'Typed while the suggestion arrived');
  } finally {
    f.dom.window.close();
  }
});

test('Use delayed acknowledgement cannot overwrite newer text or image attachments', async () => {
  const f = await frame();
  try {
    await f.send({ approvals: [proposal] });
    f.w.document.querySelector<HTMLButtonElement>('[data-ui-draft-use]')!.click();
    assert.equal(f.posted.filter((message) => message.type === 'respondUi').length, 1);
    const composer = f.w.document.querySelector<HTMLTextAreaElement>('#composer-field')!;
    assert.equal(composer.value, 'Separate composer');
    composer.value = 'Later local typing';
    composer.dispatchEvent(new f.w.Event('input', { bubbles: true }));
    const image = { itemId: 'later-image', name: 'later.png', mimeType: 'image/png', sizeBytes: 1 };
    await f.send({ sequence: 2, approvals: [proposal], pendingImages: [image] });
    await f.send({
      sequence: 3,
      approvals: [],
      draft: proposal.prefill,
      composerResetSeq: 1,
      pendingImages: [],
      extensionUiDraftAck: {
        requestKey: proposal.requestKey,
        originKey: JSON.stringify(['/tmp/project/session.jsonl', 'session']),
        frame: 0,
        accepted: true,
      },
    });
    assert.equal(
      f.w.document.querySelector<HTMLTextAreaElement>('#composer-field')!.value,
      'Later local typing'
    );
    assert.match(f.w.document.querySelector('.composer-dock')!.textContent!, /later.png/);
    const rebased = f.posted.filter(
      (message) => message.type === 'setDraft' && message.resetSeq === 1
    );
    assert.equal(rebased.length, 1);
    assert.equal(rebased[0]!.text, 'Later local typing');
  } finally {
    f.dom.window.close();
  }
});

test('coalesced duplicate Use acknowledgements rebase newer input exactly once', async () => {
  const f = await frame();
  try {
    await f.send({ approvals: [proposal] });
    f.w.document.querySelector<HTMLButtonElement>('[data-ui-draft-use]')!.click();
    const composer = f.w.document.querySelector<HTMLTextAreaElement>('#composer-field')!;
    composer.value = 'Newest input';
    composer.dispatchEvent(new f.w.Event('input', { bubbles: true }));
    f.post({ sequence: 2, connectionState: 'busy', isStreaming: true, approvals: [proposal] });
    const ackSnapshot = {
      connectionState: 'busy' as const,
      isStreaming: true,
      approvals: [],
      draft: proposal.prefill,
      composerResetSeq: 1,
      extensionUiDraftAck: {
        requestKey: proposal.requestKey,
        originKey: JSON.stringify(['/tmp/project/session.jsonl', 'session']),
        frame: 0,
        accepted: true,
      },
    };
    f.post({ ...ackSnapshot, sequence: 3 });
    await f.send({ ...ackSnapshot, sequence: 4 });
    assert.equal(
      f.w.document.querySelector<HTMLTextAreaElement>('#composer-field')!.value,
      'Newest input'
    );
    const rebases = f.posted.filter(
      (message) => message.type === 'setDraft' && message.resetSeq === 1
    );
    assert.equal(rebases.length, 1);
    assert.equal(rebases[0]!.text, 'Newest input');
  } finally {
    f.dom.window.close();
  }
});

test('matching Use acknowledgement applies text and stale repeated acknowledgements cannot clear later input', async () => {
  const f = await frame();
  try {
    await f.send({ approvals: [proposal] });
    f.w.document.querySelector<HTMLButtonElement>('[data-ui-draft-use]')!.click();
    const ack = {
      requestKey: proposal.requestKey,
      originKey: JSON.stringify(['/tmp/project/session.jsonl', 'session']),
      frame: 0,
      accepted: true,
    };
    await f.send({
      sequence: 2,
      approvals: [],
      draft: proposal.prefill,
      composerResetSeq: 1,
      extensionUiDraftAck: ack,
    });
    const composer = f.w.document.querySelector<HTMLTextAreaElement>('#composer-field')!;
    assert.equal(composer.value, proposal.prefill);
    composer.value = 'Typed after acknowledgement';
    composer.dispatchEvent(new f.w.Event('input', { bubbles: true }));
    await f.send({
      sequence: 3,
      approvals: [],
      draft: proposal.prefill,
      composerResetSeq: 1,
      extensionUiDraftAck: ack,
    });
    assert.equal(
      f.w.document.querySelector<HTMLTextAreaElement>('#composer-field')!.value,
      'Typed after acknowledgement'
    );
    await f.send({
      sequence: 4,
      approvals: [],
      draft: 'Explicit later prefill',
      composerResetSeq: 2,
    });
    assert.equal(
      f.w.document.querySelector<HTMLTextAreaElement>('#composer-field')!.value,
      'Explicit later prefill'
    );
  } finally {
    f.dom.window.close();
  }
});

test('wrong request, origin or reset acknowledgement never commits a proposed replacement', async () => {
  for (const mismatch of [
    { requestKey: 'wrong' },
    { originKey: 'different-chat' },
    { frame: 99 },
    { accepted: false },
  ]) {
    const f = await frame();
    try {
      await f.send({ approvals: [proposal] });
      f.w.document.querySelector<HTMLButtonElement>('[data-ui-draft-use]')!.click();
      await f.send({
        sequence: 2,
        draft: 'Must not replace',
        composerResetSeq: 1,
        approvals: [],
        extensionUiDraftAck: {
          requestKey: proposal.requestKey,
          originKey: JSON.stringify(['/tmp/project/session.jsonl', 'session']),
          frame: 0,
          accepted: true,
          ...mismatch,
        },
      });
      assert.equal(
        f.w.document.querySelector<HTMLTextAreaElement>('#composer-field')!.value,
        'Separate composer'
      );
    } finally {
      f.dom.window.close();
    }
  }
});

test('two draft proposals cannot replace the pending Use acknowledgement lease', async () => {
  const f = await frame();
  try {
    const second = { ...proposal, id: 'second', requestKey: 'key-second', prefill: 'Second text' };
    await f.send({ approvals: [proposal, second] });
    const uses = [...f.w.document.querySelectorAll<HTMLButtonElement>('[data-ui-draft-use]')];
    uses[0]!.click();
    uses[1]!.click();
    assert.equal(f.posted.filter((message) => message.type === 'respondUi').length, 1);
    await f.send({
      sequence: 2,
      approvals: [second],
      draft: proposal.prefill,
      composerResetSeq: 1,
      extensionUiDraftAck: {
        requestKey: proposal.requestKey,
        originKey: JSON.stringify(['/tmp/project/session.jsonl', 'session']),
        frame: 0,
        accepted: true,
      },
    });
    assert.equal(
      f.w.document.querySelector<HTMLTextAreaElement>('#composer-field')!.value,
      proposal.prefill
    );
  } finally {
    f.dom.window.close();
  }
});

test('unknown response is read-only, and a detached old request cannot respond to a new lifecycle', async () => {
  const f = await frame();
  try {
    await f.send({ approvals: [request()] });
    const oldSubmit = f.w.document.querySelector<HTMLButtonElement>('[data-ui-input-submit]')!;
    await f.send({ sequence: 2, approvals: [{ ...request(), responseState: 'unknown' }] });
    assert.equal(f.w.document.querySelector<HTMLInputElement>('.approval-input')!.readOnly, true);
    assert.match(
      f.w.document.querySelector('.approval-card')!.textContent!,
      /could not be confirmed/
    );
    oldSubmit.click();
    assert.equal(f.posted.filter((message) => message.type === 'respondUi').length, 0);
    oldSubmit.remove();
    await f.send({
      sequence: 3,
      sessionId: 'new-chat',
      catalogGeneration: 2,
      approvals: [request('input', 'new')],
    });
    oldSubmit.disabled = false;
    oldSubmit.click();
    assert.equal(f.posted.filter((message) => message.type === 'respondUi').length, 0);
    const newField = f.w.document.querySelector<HTMLInputElement>('.approval-input')!;
    assert.notEqual(f.w.document.activeElement, newField);
  } finally {
    f.dom.window.close();
  }
});

test('compatibility details stay below the input and dismiss without pretending to be an approval', async () => {
  const notice = {
    id: 'notice',
    requestKey: 'key-notice',
    method: 'unsupported_ui' as const,
    uiCapability: 'custom',
  };
  const s = snapshot({ approvals: [notice], connectionState: 'busy', isStreaming: true });
  assert.doesNotMatch(workingLabel(s), /approval/);
  const f = await frame();
  try {
    await f.send(s);
    const details = f.w.document.querySelector<HTMLDetailsElement>('#addon-details')!;
    assert.ok(details);
    assert.equal(details.open, false);
    assert.equal(f.w.document.querySelector('.approval-card'), null);
    assert.match(details.textContent!, /Custom view/);
    assert.doesNotMatch(f.w.document.body.textContent!, /terminal-only|Use the extension in Pi/);
    assert.ok(details.previousElementSibling?.classList.contains('composer-card'));
    const dismiss = f.w.document.querySelector<HTMLButtonElement>('[data-ui-cancelled]')!;
    assert.equal(dismiss.textContent, 'Dismiss');
    dismiss.click();
    const response = f.posted.filter((message) => message.type === 'respondUi').at(-1)!;
    assert.equal(response.requestKey, notice.requestKey);
    assert.equal(response.cancelled, true);
    await f.send({ ...s, approvals: [{ ...notice, responseState: 'unknown' }], sequence: 2 });
    assert.match(
      f.w.document.querySelector('#addon-details')!.textContent!,
      /will not be sent again/
    );
    assert.equal(
      f.w.document.querySelector<HTMLButtonElement>('[data-ui-cancelled]')!.disabled,
      true
    );
  } finally {
    f.dom.window.close();
  }
});

test('add-on status and text widgets are escaped, below the composer and hidden when empty', () => {
  const empty = new JSDOM(renderChatApp(snapshot())).window.document;
  assert.equal(empty.querySelector('#addon-details'), null);
  const doc = new JSDOM(
    renderChatApp(
      snapshot({
        statuses: {
          '<addon>': '<script>unsafe</script>',
          color: '\u001b[31mReady\u001b[0m',
          credential: 'Bearer ' + 'x'.repeat(40),
        },
        widgets: [
          { key: 'Search', lines: ['Index ready', 'Two lines'], placement: 'aboveEditor' },
          { key: 'Semantic', lines: ['Building'], placement: 'belowEditor' },
        ],
        approvals: [request('input')],
      })
    )
  ).window.document;
  const details = doc.querySelector<HTMLDetailsElement>('#addon-details')!;
  assert.ok(details);
  assert.equal(details.open, false);
  assert.equal(details.querySelector('script, addon'), null);
  assert.match(details.textContent!, /<addon>/);
  assert.match(details.textContent!, /<script>unsafe<\/script>/);
  assert.match(details.textContent!, /Index ready\nTwo lines/);
  assert.match(details.textContent!, /Building/);
  assert.match(details.textContent!, /Ready/);
  assert.match(details.textContent!, /\[REDACTED\]/);
  assert.doesNotMatch(details.textContent!, /\u001b|xxxxxxxx|\[31m/);
  assert.ok(details.closest('.composer-dock'));
  assert.ok(details.previousElementSibling?.classList.contains('composer-card'));
  assert.ok(doc.querySelector('.approval-card .approval-input'), 'real input stays interactive');
});

test('add-on disclosure and unsent draft survive streaming status changes and reset for another chat', async () => {
  const f = await frame();
  try {
    await f.send({ statuses: { search: 'First status' } });
    const details = f.w.document.querySelector<HTMLDetailsElement>('#addon-details')!;
    assert.ok(details);
    details.open = true;
    const composer = f.w.document.querySelector<HTMLTextAreaElement>('#composer-field')!;
    composer.value = 'My unsent text';
    composer.dispatchEvent(new f.w.Event('input', { bubbles: true }));
    await f.send({
      sequence: 2,
      connectionState: 'busy',
      isStreaming: true,
      statuses: { search: 'Second status' },
    });
    assert.equal(f.w.document.querySelector<HTMLDetailsElement>('#addon-details')!.open, true);
    assert.match(f.w.document.querySelector('#addon-details')!.textContent!, /Second status/);
    assert.equal(
      f.w.document.querySelector<HTMLTextAreaElement>('#composer-field')!.value,
      'My unsent text'
    );
    await f.send({ sequence: 3, statuses: {} });
    assert.equal(f.w.document.querySelector('#addon-details'), null);
    await f.send({ sequence: 4, statuses: { search: 'Returned' } });
    assert.equal(f.w.document.querySelector<HTMLDetailsElement>('#addon-details')!.open, true);
    await f.send({
      sequence: 5,
      sessionFile: '/tmp/project/other.jsonl',
      statuses: { search: 'Other chat' },
    });
    assert.equal(f.w.document.querySelector<HTMLDetailsElement>('#addon-details')!.open, false);
  } finally {
    f.dom.window.close();
  }
});
