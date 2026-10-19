import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { parseWebviewMessage } from '../../src/webview/messages';
import { renderChatApp } from '../../src/webview/render';
import { createWebviewSnapshot } from '../../src/webview/model';
import { createEmptyComposerState } from '../../src/webview/composer';
import { createInitialControllerState, type WebviewSnapshot } from '../../src/state/types';
import { resetControllerProjection } from '../../src/state/reducer';

const originKey = JSON.stringify(['/tmp/project/session.jsonl', 'session']);
const catalog = [
  { name: 'read', description: 'Read files', exposure: 'direct' as const },
  { name: 'remote_tool', description: '<script>unsafe</script>', exposure: 'deferred' as const },
];
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
const ready = (requestId: string, extra = {}) => ({
  status: 'ready' as const,
  originKey,
  requestId,
  tools: catalog,
  active: ['read'],
  revision: 'revision-1',
  ...extra,
});

test('model tool persistence hints use native capability rather than assuming resume support', () => {
  const runtimeOnly = new JSDOM(
    renderChatApp(snapshot({ modelTools: ready('read', { persistence: 'runtime-only' }) }))
  ).window.document;
  assert.match(
    runtimeOnly.querySelector('[data-model-tools]')!.textContent!,
    /current Pi runtime only/
  );
  assert.match(
    runtimeOnly.querySelector('[data-model-tools]')!.textContent!,
    /resets when this chat is reopened/
  );
  assert.doesNotMatch(runtimeOnly.querySelector('[data-model-tools]')!.textContent!, /Pi saves it/);
  const afterTurn = new JSDOM(
    renderChatApp(snapshot({ modelTools: ready('read', { persistence: 'after-turn' }) }))
  ).window.document;
  assert.match(
    afterTurn.querySelector('[data-model-tools]')!.textContent!,
    /Pi saves it when a turn runs/
  );
  const unknown = new JSDOM(renderChatApp(snapshot({ modelTools: ready('read') }))).window.document;
  assert.doesNotMatch(
    unknown.querySelector('[data-model-tools]')!.textContent!,
    /Pi saves it|resets when/
  );
});

test('model tool messages require correlated origin/request and bounded unique exact names', () => {
  const read = { type: 'modelToolsRequest', originKey, requestId: 'generation:1' };
  assert.deepEqual(parseWebviewMessage(read), read);
  const apply = {
    type: 'modelToolsApply',
    originKey,
    requestId: 'generation:2',
    revision: 'rev',
    names: ['read'],
  };
  assert.deepEqual(parseWebviewMessage(apply), apply);
  assert.deepEqual(parseWebviewMessage({ ...apply, names: [] }), { ...apply, names: [] });
  for (const invalid of [
    { ...read, requestId: '' },
    { ...read, originKey: '' },
    { ...apply, revision: '' },
    { ...apply, names: ['read', 'read'] },
    { ...apply, names: ['x'.repeat(201)] },
    { ...apply, names: ['bad\nname'] },
    { ...apply, names: Array.from({ length: 513 }, (_, n) => String(n)) },
  ])
    assert.equal(parseWebviewMessage(invalid), undefined);
});

test('Model tools is collapsed and unknown until an explicit native read, never inferred as zero', () => {
  const doc = new JSDOM(renderChatApp(snapshot())).window.document;
  const tools = doc.querySelector<HTMLDetailsElement>('[data-model-tools]')!;
  assert.ok(tools);
  assert.equal(tools.open, false);
  assert.match(tools.textContent!, /Not checked/);
  assert.doesNotMatch(tools.textContent!, /0 selected/);
  assert.ok(tools.querySelector('[data-model-tools-action="edit"]'));
  const unchecked = new JSDOM(
    renderChatApp(
      snapshot({
        modelTools: { status: 'unsupported', originKey, requestId: 'u', tools: [], active: [] },
      })
    )
  ).window.document;
  assert.match(unchecked.querySelector('[data-model-tools]')!.textContent!, /Not reported/);
  assert.doesNotMatch(unchecked.querySelector('[data-model-tools]')!.textContent!, /0 selected/);
});

test('Model tools appears exactly once in Chat settings including empty and deferred chats', () => {
  for (const messages of [
    [],
    [{ id: 'reply', role: 'assistant', text: 'Done', attachments: [] }],
    [
      { id: 'old', role: 'assistant', text: 'Old', attachments: [] },
      { id: 'new', role: 'assistant', text: '', attachments: [] },
    ],
  ]) {
    const doc = new JSDOM(renderChatApp(snapshot({ messages }))).window.document;
    assert.equal(doc.querySelectorAll('[data-model-tools]').length, 1);
    assert.equal(doc.querySelectorAll('#chat-settings [data-model-tools]').length, 1);
    assert.equal(doc.querySelector('[data-inline-activity] [data-model-tools]'), null);
    assert.equal(doc.querySelector('.composer-dock [data-model-tools]'), null);
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
  const click = (action: string) =>
    w.document.querySelector<HTMLButtonElement>(`[data-model-tools-action="${action}"]`)!.click();
  const checkbox = (name: string) =>
    w.document.querySelector<HTMLInputElement>(`[data-model-tool-name="${name}"]`)!;
  const request = () => posted.filter((m) => m.type === 'modelToolsRequest').at(-1)!;
  return { dom, w, posted, send, click, checkbox, request };
}

test('Edit alone lazily reads catalog; Cancel changes neither native tools nor the composer', async () => {
  const f = await frame();
  try {
    await f.send();
    assert.equal(f.request(), undefined);
    f.click('edit');
    const request = f.request();
    assert.equal(request.originKey, originKey);
    assert.equal(typeof request.requestId, 'string');
    f.click('edit');
    assert.equal(f.posted.filter((m) => m.type === 'modelToolsRequest').length, 1);
    await f.send({ sequence: 2, modelTools: ready(request.requestId as string) });
    assert.equal(f.checkbox('read').checked, true);
    assert.equal(f.w.document.querySelector('[data-model-tools] script'), null);
    f.checkbox('read').click();
    f.click('cancel');
    assert.equal(f.posted.filter((m) => m.type === 'modelToolsApply').length, 0);
    assert.equal(
      f.w.document.querySelector<HTMLTextAreaElement>('#composer-field')!.value,
      'Separate composer'
    );
    assert.equal(
      f.w.document.querySelector<HTMLElement>('[data-model-tools-editor]')!.hidden,
      true
    );
    await f.send({
      sequence: 3,
      isStreaming: true,
      modelTools: ready(request.requestId as string),
    });
    assert.match(
      f.w.document.querySelector('[data-model-tools-count]')!.textContent!,
      /last checked/
    );
    assert.equal(f.posted.filter((m) => m.type === 'modelToolsRequest').length, 1);
  } finally {
    f.dom.window.close();
  }
});

test('Apply sends exact drafted names and native revision without claiming success before acknowledgement', async () => {
  const f = await frame();
  try {
    await f.send();
    f.click('edit');
    const read = f.request();
    await f.send({ sequence: 2, modelTools: ready(read.requestId as string) });
    f.checkbox('read').click();
    f.checkbox('remote_tool').click();
    f.click('apply');
    const apply = f.posted.filter((m) => m.type === 'modelToolsApply').at(-1)!;
    assert.deepEqual(JSON.parse(JSON.stringify(apply.names)), ['remote_tool']);
    assert.equal(apply.revision, 'revision-1');
    assert.equal(apply.originKey, originKey);
    assert.notEqual(apply.requestId, read.requestId);
    assert.equal(
      f.w.document.querySelector<HTMLButtonElement>('[data-model-tools-action="apply"]')!.disabled,
      true
    );
    assert.match(f.w.document.querySelector('[data-model-tools]')!.textContent!, /Applying/);
    await f.send({ sequence: 3, modelTools: ready(read.requestId as string) });
    assert.equal(
      f.checkbox('remote_tool').checked,
      true,
      'old read cannot replace the draft or settle Apply'
    );
    await f.send({
      sequence: 4,
      modelTools: ready(apply.requestId as string, {
        tools: [],
        active: ['read'],
        revision: 'revision-2',
        message: 'Pi retained a deferred tool.',
      }),
    });
    assert.equal(
      f.w.document.querySelector<HTMLElement>('[data-model-tools-editor]')!.hidden,
      true
    );
    assert.match(f.w.document.querySelector('[data-model-tools]')!.textContent!, /1 selected/);
    assert.match(f.w.document.querySelector('[data-model-tools]')!.textContent!, /Pi retained/);
  } finally {
    f.dom.window.close();
  }
});

test('busy snapshots and stale Apply errors preserve checkbox draft, focus and separate composer', async () => {
  const f = await frame();
  try {
    await f.send();
    f.click('edit');
    const read = f.request();
    await f.send({ sequence: 2, modelTools: ready(read.requestId as string) });
    f.checkbox('remote_tool').click();
    f.checkbox('remote_tool').focus();
    await f.send({
      sequence: 3,
      connectionState: 'busy',
      isStreaming: true,
      modelTools: ready(read.requestId as string),
    });
    assert.equal(f.checkbox('remote_tool').checked, true);
    assert.equal(f.w.document.activeElement, f.checkbox('remote_tool'));
    f.click('apply');
    assert.equal(f.posted.filter((m) => m.type === 'modelToolsApply').length, 0);
    await f.send({ sequence: 4, modelTools: ready(read.requestId as string) });
    f.click('apply');
    const apply = f.posted.filter((m) => m.type === 'modelToolsApply').at(-1)!;
    await f.send({
      sequence: 5,
      modelTools: {
        status: 'stale',
        originKey,
        requestId: apply.requestId as string,
        tools: [],
        active: [],
        message: 'Tool catalog changed; cancel and reopen.',
      },
    });
    assert.equal(f.checkbox('remote_tool').checked, true);
    assert.match(f.w.document.querySelector('[data-model-tools]')!.textContent!, /catalog changed/);
    assert.equal(
      f.w.document.querySelector<HTMLButtonElement>('[data-model-tools-action="apply"]')!.disabled,
      true
    );
    f.click('apply');
    assert.equal(f.posted.filter((m) => m.type === 'modelToolsApply').length, 1);
    assert.equal(
      f.w.document.querySelector<HTMLTextAreaElement>('#composer-field')!.value,
      'Separate composer'
    );
  } finally {
    f.dom.window.close();
  }
});

test('runtime/session changes invalidate the editor and old replies cannot reopen it', async () => {
  const f = await frame();
  try {
    await f.send();
    f.click('edit');
    const read = f.request();
    await f.send({ sequence: 2, modelTools: ready(read.requestId as string) });
    f.checkbox('remote_tool').click();
    await f.send({ sequence: 3, catalogGeneration: 2 });
    await f.send({
      sequence: 4,
      catalogGeneration: 2,
      modelTools: ready(read.requestId as string),
    });
    assert.equal(
      f.w.document.querySelector<HTMLElement>('[data-model-tools-editor]')!.hidden,
      true
    );
    f.click('apply');
    assert.equal(f.posted.filter((m) => m.type === 'modelToolsApply').length, 0);
  } finally {
    f.dom.window.close();
  }
});

test('lifecycle reset clears cached model tool catalog without fetching or restoring tool names', () => {
  const state = {
    ...createInitialControllerState('project', '/tmp/project'),
    modelTools: ready('old'),
  };
  assert.equal(resetControllerProjection(state).modelTools, undefined);
});
