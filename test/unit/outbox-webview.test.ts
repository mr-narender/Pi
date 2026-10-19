import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { parseWebviewMessage } from '../../src/webview/messages';
import { renderChatApp } from '../../src/webview/render';
import { createWebviewSnapshot } from '../../src/webview/model';
import { createInitialControllerState, type WebviewSnapshot } from '../../src/state/types';
import { createEmptyComposerState } from '../../src/webview/composer';

function snapshot(overrides: Partial<WebviewSnapshot> = {}): WebviewSnapshot {
  return {
    ...createWebviewSnapshot(createInitialControllerState('file:///tmp/project', 'workspace'), 1, {
      composer: createEmptyComposerState(),
      isTrusted: true,
      folders: [],
    }),
    connectionState: 'busy',
    sessionId: 'session',
    sessionFile: '/tmp/project/session.jsonl',
    isStreaming: true,
    composerResetSeq: 0,
    outbox: {
      key: 'chat-key',
      items: [
        {
          id: 'first',
          revision: 1,
          status: 'queued',
          text: 'Check sign-out',
          files: [{ name: 'flow.png', kind: 'image' }],
        },
      ],
    },
    ...overrides,
  };
}

test('outbox actions validate identity, revision and save-only bounded text at the boundary', () => {
  const base = { type: 'outboxAction', key: 'chat-key', id: 'first', revision: 2 };
  for (const action of ['edit', 'cancel', 'remove', 'resume', 'steer', 'discard'])
    assert.deepEqual(parseWebviewMessage({ ...base, action }), { ...base, action });
  assert.deepEqual(parseWebviewMessage({ ...base, action: 'save', text: 'Changed' }), {
    ...base,
    action: 'save',
    text: 'Changed',
  });
  for (const invalid of [
    { ...base, key: '' },
    { ...base, id: '' },
    { ...base, revision: -1 },
    { ...base, revision: 1.5 },
    { ...base, revision: Infinity },
    { ...base, action: 'retry' },
    { ...base, action: 'save' },
    { ...base, action: 'save', text: 'x'.repeat(160001) },
    { ...base, action: 'remove', text: 'unexpected payload' },
  ])
    assert.equal(parseWebviewMessage(invalid), undefined);
});

test('outbox renders whitespace rows above the composer and distinguishes native queue ownership', () => {
  const doc = new JSDOM(
    renderChatApp(snapshot({ queue: { steering: ['native steer'], followUp: [] } }))
  ).window.document;
  const outbox = doc.querySelector('[data-outbox-key]')!;
  assert.ok(outbox);
  assert.match(outbox.textContent!, /Outbox/);
  assert.match(outbox.textContent!, /flow.png/);
  assert.ok(outbox.querySelector('[data-outbox-action="edit"]'));
  assert.ok(outbox.querySelector('[data-outbox-action="steer"]'));
  assert.equal(outbox.querySelector('.composer-card'), null);
  assert.ok(outbox.compareDocumentPosition(doc.querySelector('#composer-field')!) & 4);
  assert.match(doc.body.textContent!, /Queued with Pi/);
});

test('handed-off and uncertain outbox rows never expose edit, remove or retry controls', () => {
  for (const status of ['sending', 'accepted', 'unknown'] as const) {
    const doc = new JSDOM(
      renderChatApp(
        snapshot({
          outbox: {
            key: 'chat-key',
            items: [
              {
                id: 'locked',
                revision: 2,
                status,
                text: '<img src=x onerror=alert(1)>',
                files: [],
              },
            ],
          },
        })
      )
    ).window.document;
    const row = doc.querySelector('[data-outbox-id="locked"]')!;
    assert.ok(row);
    assert.equal(
      row.querySelector(
        '[data-outbox-action="edit"], [data-outbox-action="remove"], [data-outbox-action="resume"], [data-outbox-action="steer"],textarea,img'
      ),
      null
    );
    assert.equal(!!row.querySelector('[data-outbox-action="discard"]'), status === 'unknown');
    assert.match(row.textContent!, /<img src=x/);
    assert.match(
      row.textContent!,
      status === 'unknown'
        ? /Delivery unconfirmed/
        : status === 'sending'
          ? /Sending/
          : /Received by Pi/
    );
  }
});

test('editing an outbox row has a separate labeled editor and explicit Save/Cancel only', () => {
  const doc = new JSDOM(
    renderChatApp(
      snapshot({
        draft: 'Separate current draft',
        outbox: {
          key: 'chat-key',
          items: [
            {
              id: 'first',
              revision: 3,
              status: 'editing',
              text: 'Queued draft',
              files: [{ name: 'source.ts', kind: 'file' }],
            },
          ],
        },
      })
    )
  ).window.document;
  assert.equal(
    doc.querySelector<HTMLTextAreaElement>('#composer-field')!.value,
    'Separate current draft'
  );
  assert.equal(
    doc.querySelector<HTMLTextAreaElement>('[data-outbox-editor]')!.value,
    'Queued draft'
  );
  assert.ok(doc.querySelector('[data-outbox-action="save"]'));
  assert.ok(doc.querySelector('[data-outbox-action="cancel"]'));
  assert.equal(
    doc.querySelector('[data-outbox-action="resume"], [data-outbox-action="steer"]'),
    null
  );
  assert.match(doc.body.textContent!, /Save keeps it paused/);
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
    url: 'https://webview.test/',
    runScripts: 'outside-only',
  });
  const w = dom.window;
  const posted: Array<Record<string, unknown>> = [];
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
  const send = async (overrides: Partial<WebviewSnapshot> = {}) => {
    w.dispatchEvent(
      new w.MessageEvent('message', { data: { type: 'snapshot', snapshot: snapshot(overrides) } })
    );
    await new Promise((resolve) => setTimeout(resolve, 180));
  };
  const click = (action: string) =>
    w.document.querySelector<HTMLButtonElement>(`[data-outbox-action="${action}"]`)!.click();
  return { dom, w, posted, send, click };
}

test('outbox save uses its row revision and never submits or clears the separate composer', async () => {
  const f = await frame();
  try {
    await f.send({
      draft: 'Current draft',
      outbox: {
        key: 'chat-key',
        items: [{ id: 'first', revision: 3, status: 'editing', text: 'Before', files: [] }],
      },
    });
    const editor = f.w.document.querySelector<HTMLTextAreaElement>('[data-outbox-editor]')!;
    editor.value = 'Changed queued message';
    editor.dispatchEvent(new f.w.Event('input', { bubbles: true }));
    f.click('save');
    assert.deepEqual(
      JSON.parse(JSON.stringify(f.posted.filter((x) => x.type === 'outboxAction').at(-1))),
      {
        type: 'outboxAction',
        key: 'chat-key',
        id: 'first',
        revision: 3,
        action: 'save',
        text: 'Changed queued message',
      }
    );
    assert.equal(
      f.w.document.querySelector<HTMLTextAreaElement>('#composer-field')!.value,
      'Current draft'
    );
    assert.equal(f.posted.filter((x) => x.type === 'requestSend').length, 0);
  } finally {
    f.dom.window.close();
  }
});

test('passive snapshots preserve an outbox edit and IME without moving focus to the composer', async () => {
  const f = await frame();
  try {
    const outbox = {
      key: 'chat-key',
      items: [{ id: 'first', revision: 3, status: 'editing' as const, text: 'Before', files: [] }],
    };
    await f.send({ draft: 'Separate', outbox });
    const editor = f.w.document.querySelector<HTMLTextAreaElement>('[data-outbox-editor]')!;
    editor.focus();
    editor.value = 'Unsent edited value';
    editor.setSelectionRange(3, 6);
    editor.dispatchEvent(new f.w.CompositionEvent('compositionstart', { bubbles: true }));
    editor.dispatchEvent(new f.w.Event('input', { bubbles: true }));
    await f.send({ sequence: 2, draft: 'Separate', outbox });
    assert.equal(f.w.document.querySelector('[data-outbox-editor]'), editor);
    assert.equal(editor.value, 'Unsent edited value');
    assert.equal(f.w.document.activeElement, editor);
    f.click('save');
    assert.equal(
      f.posted.filter((x) => x.type === 'outboxAction').length,
      0,
      'IME must complete before Save'
    );
    editor.dispatchEvent(new f.w.CompositionEvent('compositionend', { bubbles: true }));
    f.click('save');
    assert.equal(f.posted.filter((x) => x.type === 'outboxAction').length, 1);
  } finally {
    f.dom.window.close();
  }
});

function typeComposer(f: Awaited<ReturnType<typeof frame>>, text: string) {
  const composer = f.w.document.querySelector<HTMLTextAreaElement>('#composer-field')!;
  composer.value = text;
  composer.dispatchEvent(new f.w.Event('input', { bubbles: true }));
  return composer;
}
function submit(f: Awaited<ReturnType<typeof frame>>) {
  f.w.document.querySelector<HTMLButtonElement>('#composer-send-button')!.click();
  return f.posted.filter((message) => message.type === 'requestSend').at(-1)!
    .submissionId as string;
}
const originKey = JSON.stringify(['/tmp/project/session.jsonl', 'session']);

test('busy follow-up retains input until durable correlated ack and suppresses repeated Enter/click', async () => {
  const f = await frame();
  try {
    await f.send();
    const composer = typeComposer(f, 'Queue this once');
    const id = submit(f);
    assert.ok(id);
    submit(f);
    composer.dispatchEvent(
      new f.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    );
    assert.equal(f.posted.filter((message) => message.type === 'requestSend').length, 1);
    assert.equal(composer.value, 'Queue this once');
    await f.send({
      sequence: 2,
      draft: '',
      composerResetSeq: 99,
      outboxAck: { submissionId: 'previous-generation', originKey, frame: 0, accepted: true },
    });
    assert.equal(composer.value, 'Queue this once');
    await f.send({
      sequence: 3,
      draft: '',
      composerResetSeq: 1,
      outboxAck: { submissionId: id, originKey, frame: 0, accepted: true },
    });
    assert.equal(f.w.document.querySelector<HTMLTextAreaElement>('#composer-field')!.value, '');
    typeComposer(f, 'New unsent text');
    await f.send({
      sequence: 4,
      draft: '',
      composerResetSeq: 99,
      outboxAck: { submissionId: id, originKey, frame: 0, accepted: true },
    });
    assert.equal(
      f.w.document.querySelector<HTMLTextAreaElement>('#composer-field')!.value,
      'New unsent text'
    );
    typeComposer(f, 'Still new');
    assert.equal(f.posted.filter((message) => message.type === 'setDraft').at(-1)!.resetSeq, 1);
  } finally {
    f.dom.window.close();
  }
});

test('outbox enqueue ack preserves newer text and image chips, and rejection permits deliberate resubmit', async () => {
  const f = await frame();
  try {
    await f.send();
    typeComposer(f, 'Submitted original');
    const id = submit(f);
    typeComposer(f, 'New separate text');
    const image = { itemId: 'new-image', name: 'new.png', mimeType: 'image/png', sizeBytes: 1 };
    await f.send({ sequence: 2, draft: 'New separate text', pendingImages: [image] });
    await f.send({
      sequence: 3,
      draft: '',
      composerResetSeq: 1,
      pendingImages: [],
      outboxAck: { submissionId: id, originKey, frame: 0, accepted: true },
    });
    assert.equal(
      f.w.document.querySelector<HTMLTextAreaElement>('#composer-field')!.value,
      'New separate text'
    );
    assert.match(f.w.document.body.textContent!, /new.png/);
    const next = submit(f);
    await f.send({
      sequence: 4,
      draft: '',
      composerResetSeq: 1,
      outboxAck: { submissionId: next, originKey, frame: 1, accepted: false },
    });
    assert.equal(
      f.w.document.querySelector<HTMLTextAreaElement>('#composer-field')!.value,
      'New separate text'
    );
    submit(f);
    assert.equal(f.posted.filter((message) => message.type === 'requestSend').length, 3);
  } finally {
    f.dom.window.close();
  }
});

test('discarding an unknown copy carries only its current identity and revision', async () => {
  const f = await frame();
  try {
    await f.send({
      outbox: {
        key: 'chat-key',
        items: [
          {
            id: 'uncertain',
            revision: 8,
            status: 'unknown',
            text: 'Already may be received',
            files: [],
          },
        ],
      },
    });
    f.click('discard');
    assert.deepEqual(
      JSON.parse(
        JSON.stringify(f.posted.filter((message) => message.type === 'outboxAction').at(-1))
      ),
      { type: 'outboxAction', key: 'chat-key', id: 'uncertain', revision: 8, action: 'discard' }
    );
    assert.equal(f.posted.filter((message) => message.type === 'requestSend').length, 0);
  } finally {
    f.dom.window.close();
  }
});

test('editor cannot retain a stale value across a changed row revision or another chat', async () => {
  const f = await frame();
  try {
    const row = {
      id: 'first',
      revision: 1,
      status: 'editing' as const,
      text: 'Original',
      files: [],
    };
    await f.send({ outbox: { key: 'chat-key', items: [row] } });
    const editor = f.w.document.querySelector<HTMLTextAreaElement>('[data-outbox-editor]')!;
    editor.value = 'Stale local edit';
    await f.send({
      sequence: 2,
      outbox: { key: 'chat-key', items: [{ ...row, revision: 2, text: 'Current saved value' }] },
    });
    assert.equal(
      f.w.document.querySelector<HTMLTextAreaElement>('[data-outbox-editor]')!.value,
      'Current saved value'
    );
    f.click('save');
    assert.equal(f.posted.filter((message) => message.type === 'outboxAction').at(-1)!.revision, 2);
    await f.send({
      sequence: 3,
      sessionFile: '/tmp/another.jsonl',
      outbox: { key: 'other-chat', items: [{ ...row, revision: 2, text: 'Other chat value' }] },
    });
    assert.equal(
      f.w.document.querySelector<HTMLTextAreaElement>('[data-outbox-editor]')!.value,
      'Other chat value'
    );
  } finally {
    f.dom.window.close();
  }
});

test('settled outbox ack retires so later host prefill and attachments are visible', async () => {
  const f = await frame();
  try {
    await f.send();
    typeComposer(f, 'Queued');
    const id = submit(f);
    await f.send({
      sequence: 2,
      draft: '',
      composerResetSeq: 1,
      outboxAck: { submissionId: id, originKey, frame: 0, accepted: true },
    });
    await f.send({
      sequence: 3,
      draft: 'Host prefill',
      composerResetSeq: 2,
      pendingImages: [{ itemId: 'later', name: 'later.png', mimeType: 'image/png', sizeBytes: 1 }],
    });
    assert.equal(
      f.w.document.querySelector<HTMLTextAreaElement>('#composer-field')!.value,
      'Host prefill'
    );
    assert.match(f.w.document.body.textContent!, /later.png/);
  } finally {
    f.dom.window.close();
  }
});
test('another-window ownership makes all outbox controls and editor read-only', async () => {
  const f = await frame();
  try {
    const row = { id: 'first', revision: 1, status: 'editing' as const, text: 'Text', files: [] };
    await f.send({ outbox: { key: 'chat-key', items: [row] } });
    await f.send({
      sequence: 2,
      outbox: {
        key: 'chat-key',
        items: [row],
        readOnly: true,
        notice: 'Outbox is open in another VS Code window.',
      },
    });
    assert.equal(
      f.w.document.querySelector<HTMLTextAreaElement>('[data-outbox-editor]')!.readOnly,
      true
    );
    for (const button of f.w.document.querySelectorAll<HTMLButtonElement>('[data-outbox-action]'))
      assert.equal(button.disabled, true);
    f.click('save');
    assert.equal(f.posted.filter((message) => message.type === 'outboxAction').length, 0);
  } finally {
    f.dom.window.close();
  }
});

for (const accepted of [true, false]) {
  test(`completed outbox ack releases legacy pending send when frame is preserved (${accepted})`, async () => {
    const f = await frame();
    try {
      await f.send();
      typeComposer(f, 'Submitted text');
      const id = submit(f);
      typeComposer(f, 'Newer text retained by host');
      await f.send({
        sequence: 2,
        draft: 'Newer text retained by host',
        composerResetSeq: 0,
        outboxAck: { submissionId: id, originKey, frame: 0, accepted },
      });
      assert.equal(
        f.w.document.querySelector<HTMLTextAreaElement>('#composer-field')!.value,
        'Newer text retained by host'
      );
      await f.send({
        sequence: 3,
        draft: '',
        composerResetSeq: 1,
        pendingImages: [
          {
            itemId: 'explicit-next',
            name: 'explicit-next.png',
            mimeType: 'image/png',
            sizeBytes: 1,
          },
        ],
      });
      assert.equal(
        f.w.document.querySelector<HTMLTextAreaElement>('#composer-field')!.value,
        '',
        'a later explicit host reset belongs to the current composer'
      );
      assert.match(f.w.document.body.textContent!, /explicit-next.png/);
    } finally {
      f.dom.window.close();
    }
  });
}
