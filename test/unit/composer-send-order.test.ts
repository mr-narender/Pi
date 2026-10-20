import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { build } from 'esbuild';

const compiled = build({
  stdin: {
    contents:
      "export {ChatTabManager} from './src/editorTabs/tabManager';export {ChatUiState} from './src/webview/composerState';export {createEmptyComposerState} from './src/webview/composer';",
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
  external: ['vscode'],
});

async function fixture() {
  const vscode = {
    EventEmitter: class {
      event = () => ({ dispose() {} });
      fire() {}
      dispose() {}
    },
    workspace: {
      isTrusted: true,
      getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }),
    },
    window: {},
  };
  const require = createRequire(`${process.cwd()}/package.json`);
  const module = { exports: {} as Record<string, any> };
  new Function('require', 'module', 'exports', (await compiled).outputFiles[0]!.text)(
    (id: string) => (id === 'vscode' ? vscode : require(id)),
    module,
    module.exports
  );
  const { ChatTabManager, ChatUiState, createEmptyComposerState } = module.exports;
  const stored = new Map<string, unknown>();
  let persist: () => Promise<void> = async () => {};
  const ui = new ChatUiState({
    workspaceState: {
      get: (key: string, fallback: unknown) => stored.get(key) ?? fallback,
      update: async (key: string, value: unknown) => {
        await persist();
        stored.set(key, structuredClone(value));
      },
    },
  });
  const controller: any = {
    folder: { uri: { toString: () => 'file:///owned' } },
    snapshot: { state: { sessionId: 'owned' }, draft: '' },
    setDraft(text: string) {
      this.snapshot.draft = text;
    },
    captureLocalCommandOrigin: () => () => true,
  };
  const target = {
    kind: 'sessionId',
    workspaceFolderUri: 'file:///owned',
    sessionId: 'owned',
  };
  const resource = { toString: () => 'owned-resource' };
  const context = { controller, target, resource };
  const sent: string[] = [];
  const manager = Object.create(ChatTabManager.prototype);
  Object.assign(manager, {
    uiState: ui,
    contextForResource: () => context,
    renderResource: async () => {},
    preparePromptContext: async () => context,
    sendPreview: async (_r: unknown, _c: unknown, _t: unknown, _s: unknown, preview: any) => {
      sent.push(preview.rpcMessage);
    },
    outboxAcks: new Map(),
    hosts: new Map(),
  });
  await ui.setComposerStateForIdentity(controller, target, createEmptyComposerState());
  return {
    manager,
    ui,
    controller,
    target,
    sent,
    useRealSend() {
      manager.sendPreview = ChatTabManager.prototype.sendPreview;
      controller.prompt = async (text: string) => sent.push(text);
    },
    holdPersistence(next: () => Promise<void>) {
      persist = next;
    },
    post: (message: unknown) => manager.onMessage({ resource }, message),
    state: () => ui.getComposerStateForIdentity(controller, target),
    async anotherChat() {
      const otherController = {
        ...controller,
        snapshot: { state: { sessionId: 'other' }, draft: '' },
      };
      const otherTarget = { ...target, sessionId: 'other' };
      const otherResource = { toString: () => 'other-resource' };
      const otherContext = {
        controller: otherController,
        target: otherTarget,
        resource: otherResource,
      };
      manager.contextForResource = (requested: typeof resource) =>
        requested.toString() === resource.toString() ? context : otherContext;
      manager.preparePromptContext = async (requested: typeof resource) =>
        manager.contextForResource(requested);
      await ui.setComposerStateForIdentity(
        otherController,
        otherTarget,
        createEmptyComposerState()
      );
      return (message: unknown) => manager.onMessage({ resource: otherResource }, message);
    },
  };
}

test('a draft update immediately followed by Send submits the typed text', async () => {
  const f = await fixture();
  await Promise.all([
    f.post({ type: 'setDraft', resetSeq: 0, text: 'Send this message' }),
    f.post({ type: 'requestSend', command: 'prompt' }),
  ]);
  assert.deepEqual(f.sent, ['Send this message']);
  assert.equal((await f.state()).draft, '');
});

test('coalesced typing updates submit the final text in delivery order', async () => {
  const f = await fixture();
  await Promise.all([
    f.post({ type: 'setDraft', resetSeq: 0, text: 'Partial' }),
    f.post({ type: 'setDraft', resetSeq: 0, text: 'Final message' }),
    f.post({ type: 'requestSend', command: 'prompt' }),
  ]);
  assert.deepEqual(f.sent, ['Final message']);
});

test('typing publishes before slow persistence without blocking the Send preflight', async () => {
  const f = await fixture();
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  f.holdPersistence(() => held);
  let draftPersisted = false;
  const draft = f
    .post({ type: 'setDraft', resetSeq: 0, text: 'Typed before storage completes' })
    .finally(() => (draftPersisted = true));
  const send = f.post({ type: 'requestSend', command: 'prompt' });
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    const current = await f.state();
    assert.equal(draftPersisted, false);
    assert.equal(current.draft, '');
    assert.equal(current.composerResetSeq, 1, 'Send admitted the newly typed draft');
  } finally {
    release();
  }
  await Promise.all([draft, send]);
  assert.deepEqual(f.sent, ['Typed before storage completes']);
});

test('failed persistence cannot submit an older draft instead of the new text', async () => {
  const f = await fixture();
  await f.post({ type: 'setDraft', resetSeq: 0, text: 'Older draft' });
  f.holdPersistence(async () => {
    throw new Error('Owned storage failure');
  });
  const results = await Promise.allSettled([
    f.post({ type: 'setDraft', resetSeq: 0, text: 'Latest draft' }),
    f.post({ type: 'requestSend', command: 'prompt' }),
  ]);
  assert.ok(results.some((result) => result.status === 'rejected'));
  assert.deepEqual(f.sent, []);
  assert.equal((await f.state()).draft, 'Latest draft');
});

test('draft updates typed before a send reset cannot resurrect submitted text', async () => {
  const f = await fixture();
  const current = await f.state();
  current.draft = 'Keep this later draft';
  current.composerResetSeq = 2;
  await f.ui.setComposerStateForIdentity(f.controller, f.target, current);
  await f.post({ type: 'setDraft', resetSeq: 0, text: 'Already submitted' });
  assert.equal((await f.state()).draft, 'Keep this later draft');
  assert.equal((await f.state()).composerResetSeq, 2);
});

test('coalesced submissions in separate chats keep their own text', async () => {
  const f = await fixture();
  const otherPost = await f.anotherChat();
  await Promise.all([
    f.post({ type: 'setDraft', resetSeq: 0, text: 'First chat' }),
    otherPost({ type: 'setDraft', resetSeq: 0, text: 'Second chat' }),
    f.post({ type: 'requestSend', command: 'prompt' }),
    otherPost({ type: 'requestSend', command: 'prompt' }),
  ]);
  assert.deepEqual([...f.sent].sort(), ['First chat', 'Second chat']);
});

test('a pending send does not block Abort or extension prompt responses', async () => {
  const f = await fixture();
  let entered!: () => void;
  let release!: () => void;
  const sending = new Promise<void>((resolve) => (entered = resolve));
  const held = new Promise<void>((resolve) => (release = resolve));
  const actions: string[] = [];
  f.manager.sendPreview = async () => {
    entered();
    await held;
  };
  f.manager.handleAbort = async () => actions.push('abort');
  f.manager.handleRespondUi = async () => actions.push('respond');
  await f.post({ type: 'setDraft', resetSeq: 0, text: 'Pending send' });
  const send = f.post({ type: 'requestSend', command: 'prompt' });
  await sending;
  try {
    await f.post({ type: 'abort' });
    await f.post({ type: 'respondUi', id: 'owned', requestKey: 'owned-key', value: 'answer' });
    assert.deepEqual(actions, ['abort', 'respond']);
  } finally {
    release();
    await send;
  }
});

test('Send captures the clicked draft while later typing stays unsent', async () => {
  const f = await fixture();
  f.useRealSend();
  await f.post({ type: 'setDraft', resetSeq: 0, text: 'Clicked draft' });
  await Promise.all([
    f.post({ type: 'requestSend', command: 'prompt' }),
    f.post({ type: 'setDraft', resetSeq: 0, text: 'Later unsent draft' }),
  ]);
  assert.deepEqual(f.sent, ['Clicked draft']);
  assert.equal((await f.state()).draft, 'Later unsent draft');
});

test('Send captures the clicked draft before asynchronous attachment validation', async () => {
  const f = await fixture();
  f.useRealSend();
  await f.post({ type: 'setDraft', resetSeq: 0, text: 'Clicked before validation' });
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const validate = f.ui.validateContextItems.bind(f.ui);
  f.ui.validateContextItems = async (...args: unknown[]) => {
    await held;
    return validate(...args);
  };
  const send = f.post({ type: 'requestSend', command: 'prompt' });
  await f.post({ type: 'setDraft', resetSeq: 0, text: 'Typed during validation' });
  release();
  await send;
  assert.deepEqual(f.sent, ['Clicked before validation']);
  assert.equal((await f.state()).draft, 'Typed during validation');
});

test('new typing during session preparation survives the accepted send', async () => {
  const f = await fixture();
  f.useRealSend();
  let entered!: () => void;
  let release!: () => void;
  const preparing = new Promise<void>((resolve) => (entered = resolve));
  const held = new Promise<void>((resolve) => (release = resolve));
  const prepare = f.manager.preparePromptContext.bind(f.manager);
  f.manager.preparePromptContext = async (...args: unknown[]) => {
    entered();
    await held;
    return prepare(...args);
  };
  await f.post({ type: 'setDraft', resetSeq: 0, text: 'Accepted draft' });
  const send = f.post({ type: 'requestSend', command: 'prompt' });
  await preparing;
  await f.post({
    type: 'setDraft',
    resetSeq: (await f.state()).composerResetSeq,
    text: 'Next draft',
  });
  release();
  await send;
  assert.deepEqual(f.sent, ['Accepted draft']);
  assert.equal((await f.state()).draft, 'Next draft');
});

test('Send clears only its own file and image chips when newer attachments arrive', async () => {
  const f = await fixture();
  f.useRealSend();
  const contextItem = (id: string) => ({
    kind: 'pastedText',
    itemId: id,
    workspaceFolder: 'file:///owned',
    workspaceRelativePath: id,
    lineStart: 1,
    lineEnd: 1,
    languageId: 'plaintext',
    sanitizedContent: id,
    capturedAt: new Date(0).toISOString(),
    persistedRef: {
      workspaceRelativePath: id,
      lineStart: 1,
      lineEnd: 1,
      languageId: 'plaintext',
      contentFingerprint: id,
      content: id,
    },
  });
  const image = (id: string) => ({
    itemId: id,
    name: `${id}.png`,
    mimeType: 'image/png',
    sizeBytes: 1,
    inMemoryBase64: 'AQ==',
  });
  const initial = await f.state();
  initial.draft = 'Submitted text';
  initial.pendingContextItems = [contextItem('sent-file')];
  initial.pendingImages = [image('sent-image')];
  await f.ui.setComposerStateForIdentity(f.controller, f.target, initial);
  const send = f.post({ type: 'requestSend', command: 'prompt' });
  await f.ui.setComposerStateForIdentity(f.controller, f.target, {
    ...initial,
    draft: 'Unsent text',
    pendingContextItems: [...initial.pendingContextItems, contextItem('new-file')],
    pendingImages: [...initial.pendingImages, image('new-image')],
  });
  await send;
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0]!, /Submitted text/);
  assert.doesNotMatch(f.sent[0]!, /Unsent text|new-file/);
  const current = await f.state();
  assert.equal(current.draft, 'Unsent text');
  assert.deepEqual(
    current.pendingContextItems.map((item: any) => item.itemId),
    ['new-file']
  );
  assert.deepEqual(
    current.pendingImages.map((item: any) => item.itemId),
    ['new-image']
  );
});

test('two submissions from the same composer frame do not dispatch twice', async () => {
  const f = await fixture();
  await f.post({ type: 'setDraft', resetSeq: 0, text: 'Send once' });
  await Promise.all([
    f.post({ type: 'requestSend', command: 'prompt' }),
    f.post({ type: 'requestSend', command: 'prompt' }),
  ]);
  assert.deepEqual(f.sent, ['Send once']);
});

test('an attachment-only update cannot restore the submitted text or stale command metadata', async () => {
  const f = await fixture();
  f.useRealSend();
  const image = (id: string) => ({
    itemId: id,
    name: `${id}.png`,
    mimeType: 'image/png',
    sizeBytes: 1,
    inMemoryBase64: 'AQ==',
  });
  const initial = await f.state();
  initial.draft = 'Submitted text';
  initial.pendingImages = [image('submitted')];
  await f.ui.setComposerStateForIdentity(f.controller, f.target, initial);
  const send = f.post({ type: 'requestSend', command: 'prompt' });
  await f.ui.setComposerStateForIdentity(f.controller, f.target, {
    ...initial,
    pendingImages: [...initial.pendingImages, image('new')],
    localCommandAck: 'newer-command',
    focus: 'attach',
  });
  await send;
  const current = await f.state();
  assert.deepEqual(f.sent, ['Submitted text']);
  assert.equal(current.draft, '');
  assert.deepEqual(
    current.pendingImages.map((item: any) => item.itemId),
    ['new']
  );
  assert.equal(current.localCommandAck, 'newer-command');
  assert.equal(current.focus, 'attach');
});

test('a busy-chat submission queues its clicked text and keeps newer input', async () => {
  const f = await fixture();
  const queued: string[] = [];
  f.manager.outbox = {
    enqueue: async (_key: string, accepted: any) => queued.push(accepted.rpcMessage),
    pause: async () => {},
  };
  f.manager.outboxNotices = new Map();
  f.manager.bindOutbox = () => ({ key: 'owned-outbox' });
  f.manager.wakeOutbox = async () => {};
  await f.post({ type: 'setDraft', resetSeq: 0, text: 'Queue this text' });
  await Promise.all([
    f.post({ type: 'requestSend', command: 'follow_up', submissionId: 'owned-submit' }),
    f.post({ type: 'setDraft', resetSeq: 0, text: 'Next unsent text' }),
  ]);
  assert.deepEqual(queued, ['Queue this text']);
  assert.equal((await f.state()).draft, 'Next unsent text');
});

test('a rejected image submission preserves text typed after Send', async () => {
  const f = await fixture();
  const initial = await f.state();
  initial.draft = 'Clicked draft';
  initial.pendingImages = [
    {
      itemId: 'expired',
      name: 'expired.png',
      mimeType: 'image/png',
      sizeBytes: 1,
      requiresReselect: true,
    },
  ];
  await f.ui.setComposerStateForIdentity(f.controller, f.target, initial);
  await Promise.all([
    f.post({ type: 'requestSend', command: 'prompt' }),
    f.post({ type: 'setDraft', resetSeq: 0, text: 'Keep this newer draft' }),
  ]);
  const current = await f.state();
  assert.deepEqual(f.sent, []);
  assert.equal(current.draft, 'Keep this newer draft');
  assert.equal(current.pendingImages[0].requiresReselect, true);
  assert.match(current.recovery.detail, /Reselect expired images/);
});
