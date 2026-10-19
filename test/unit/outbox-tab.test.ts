import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OutboxStore } from '../../src/outbox/store';
import { createEmptyComposerState } from '../../src/webview/composer';
import { chatTargetSessionKey } from '../../src/editorTabs/uriContract';

async function setup(t: test.TestContext) {
  const compiled = await build({
    entryPoints: ['src/editorTabs/tabManager.ts'],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    external: ['vscode'],
  });
  const nativeRequire = createRequire(`${process.cwd()}/package.json`),
    module = { exports: {} as any };
  const vscode = {
    workspace: {
      isTrusted: true,
      getConfiguration: () => ({ get: (_key: string, value: unknown) => value }),
    },
    window: { showWarningMessage() {}, showErrorMessage() {} },
  };
  new Function('require', 'module', 'exports', compiled.outputFiles[0]!.text)(
    (id: string) => (id === 'vscode' ? vscode : nativeRequire(id)),
    module,
    module.exports
  );
  const manager = Object.create(module.exports.ChatTabManager.prototype);
  const root = await mkdtemp(join(tmpdir(), 'pi-outbox-tab-')),
    box = new OutboxStore(root);
  t.after(async () => {
    await box.dispose();
    await rm(root, { recursive: true, force: true });
  });
  const resource = { toString: () => 'pi-chat:/session.chat' };
  const target = {
    kind: 'sessionFile' as const,
    workspaceFolderUri: 'file:///workspace',
    sessionFile: '/session.jsonl',
    sessionId: 'session',
  };
  let composer = createEmptyComposerState();
  composer.draft = 'Queued request';
  composer.commandRevision = 3;
  composer.pendingImages = [
    {
      itemId: 'image',
      name: 'screen.png',
      mimeType: 'image/png',
      sizeBytes: 3,
      inMemoryBase64: 'YWJj',
    },
  ];
  const controller = {
    generation: 1,
    folder: { uri: { toString: () => 'file:///workspace' } },
    outboxCompletionRevision: 0,
    snapshot: {
      connectionState: 'busy',
      runOutcome: 'running',
      state: { sessionFile: '/session.jsonl', sessionId: 'session' },
      draft: composer.draft,
    },
    captureOutboxOrigin: () => () => true,
    isOutboxReady: async () => false,
    setDraft(text: string) {
      this.snapshot.draft = text;
    },
    prompt: async () => {
      throw Error('must not send yet');
    },
  };
  const context = { controller, target, resource };
  Object.assign(manager, {
    outbox: box,
    outboxAcks: new Map(),
    outboxNotices: new Map(),
    outboxBindings: new Map(),
    hosts: new Map([[resource.toString(), {}]]),
    contextForResource: () => context,
    renderResource: async () => {},
    uiState: {
      getComposerStateForIdentity: async () => structuredClone(composer),
      setComposerStateForIdentity: async (_c: any, _t: any, state: any, options: any) => {
        if (
          options?.expectedCommandRevision !== undefined &&
          options.expectedCommandRevision !== (composer.commandRevision ?? 0)
        )
          return;
        state.commandRevision = (composer.commandRevision ?? 0) + 1;
        composer = structuredClone(state);
      },
    },
  });
  return {
    manager,
    box,
    resource,
    target,
    controller,
    get composer() {
      return composer;
    },
    update: () => {
      composer.draft = 'Newer unsent draft';
      composer.commandRevision = (composer.commandRevision ?? 0) + 1;
    },
  };
}

test('busy follow-up is durable before host composer clear; ordinary Pi receives nothing', async (t) => {
  const f = await setup(t);
  let release!: () => void, durable!: () => void;
  const saved = new Promise<void>((resolve) => {
      durable = resolve;
    }),
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
  const enqueue = f.box.enqueue.bind(f.box);
  f.box.enqueue = async (...args) => {
    const item = await enqueue(...args);
    durable();
    await gate;
    return item;
  };
  const send = f.manager.handleRequestSend(f.resource, 'follow_up', 'webview:1');
  await Promise.race([
    saved,
    new Promise((_, reject) =>
      setTimeout(() => reject(Error('follow-up did not enter durable Outbox')), 500)
    ),
  ]);
  assert.equal(f.composer.draft, 'Queued request');
  release();
  await send;
  assert.equal(f.composer.draft, '');
  assert.equal(f.composer.pendingImages.length, 0);
  const key = chatTargetSessionKey(f.target),
    snapshot = await f.box.snapshot(key);
  assert.equal(snapshot.items[0]!.status, 'queued');
  assert.equal((await f.box.payload(key, snapshot.items[0]!.id)).rpcImages[0]!.data, 'YWJj');
  assert.equal(f.manager.outboxAcks.get(f.resource.toString()).accepted, true);
});

test('durable enqueue cannot clear a newer composer revision', async (t) => {
  const f = await setup(t),
    enqueue = f.box.enqueue.bind(f.box);
  f.box.enqueue = async (...args) => {
    const item = await enqueue(...args);
    f.update();
    return item;
  };
  await f.manager.handleRequestSend(f.resource, 'follow_up', 'webview:2');
  assert.equal(f.composer.draft, 'Newer unsent draft');
  assert.equal(f.composer.pendingImages.length, 1);
  assert.equal((await f.box.snapshot(chatTargetSessionKey(f.target))).items.length, 1);
});

test('one completed reply releases one frozen item; editing holds FIFO without a retry loop', async (t) => {
  const f = await setup(t);
  await f.manager.handleRequestSend(f.resource, 'follow_up', 'webview:3');
  f.update();
  await f.manager.handleRequestSend(f.resource, 'follow_up', 'webview:4');
  const key = chatTargetSessionKey(f.target);
  let sends = 0;
  let entered!: () => void, settled!: () => void;
  const sending = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const delivered = new Promise<void>((resolve) => {
    settled = resolve;
  });
  let checking!: () => void, allowReady!: () => void;
  const checked = new Promise<void>((resolve) => {
    checking = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    allowReady = resolve;
  });
  let timeout: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(
      () =>
        reject(
          Error(
            'Outbox did not finish handoff: ' +
              JSON.stringify([...f.manager.outboxNotices.values()])
          )
        ),
      2000
    );
  });
  t.after(() => clearTimeout(timeout));
  f.manager.renderResource = async () => {
    if (sends === 1 && !f.manager.outboxBindings.get(f.controller)?.running) settled();
  };
  Object.assign(f.controller, {
    isOutboxReady: async () => {
      checking();
      await ready;
      return true;
    },
    prompt: async () => {
      sends++;
      entered();
      return { disposition: 'started' };
    },
  });
  f.controller.snapshot.connectionState = 'ready';
  f.controller.outboxCompletionRevision++;
  // State events may already own the pump. A deduplicated wake returns before that
  // operation finishes, so await observable handoff and completion instead.
  const active = f.manager.wakeOutbox(f.controller);
  await Promise.race([checked, deadline]);
  await f.manager.wakeOutbox(f.controller);
  assert.equal(sends, 0, 'a deduplicated wake is not a dispatch completion promise');
  allowReady();
  await Promise.race([sending, deadline]);
  await Promise.race([delivered, deadline]);
  await active;
  assert.equal(sends, 1, JSON.stringify([...f.manager.outboxNotices.values()]));
  assert.deepEqual(
    (await f.box.snapshot(key)).items.map((row) => row.status),
    ['accepted', 'queued']
  );
  await f.manager.wakeOutbox(f.controller);
  assert.equal(sends, 1);
  const second = (await f.box.snapshot(key)).items[1]!;
  await f.box.action(key, second.id, second.revision, 'edit');
  f.controller.outboxCompletionRevision++;
  await f.manager.wakeOutbox(f.controller);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(sends, 1);
  assert.equal((await f.box.snapshot(key)).items[1]!.status, 'editing');
});

test('closing a tab tears down its controller even when paused storage write fails', async (t) => {
  const f = await setup(t);
  await f.manager.handleRequestSend(f.resource, 'follow_up', 'webview:close');
  let removed = 0,
    warnings = 0;
  const host = { resource: f.resource };
  Object.assign(f.manager, {
    keyFor: () => 'controller-key',
    setUnseenCompletion() {},
    sessions: { unbind() {} },
    cache: { markClosed: async () => {} },
    openChatsEmitter: { fire() {} },
    registry: {
      remove() {
        removed++;
      },
    },
    logger: {
      warn() {
        warnings++;
      },
    },
  });
  f.manager.hosts.set(f.resource.toString(), host);
  f.box.suspend = async () => {
    throw Error('disk unavailable');
  };
  await f.manager.onHostDisposed(host);
  assert.equal(removed, 1);
  assert.equal(warnings, 1);
  assert.equal(f.manager.outboxBindings.size, 0);
  assert.equal(f.manager.hosts.size, 0);
});

test('a ready state event during the last stale busy probe is not lost', async (t) => {
  const f = await setup(t);
  await f.manager.handleRequestSend(f.resource, 'follow_up', 'webview:last-probe');
  const binding = f.manager.outboxBindings.get(f.controller);
  binding.attempts = 20;
  let checking!: () => void,
    release!: () => void,
    sent!: () => void,
    sends = 0,
    checks = 0;
  const delivered = new Promise<void>((resolve) => {
    sent = resolve;
  });
  let settle!: () => void;
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  f.manager.renderResource = async () => {
    if (sends === 1 && !binding.running) settle();
  };
  let timeout: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(Error('readiness wake was lost')), 2000);
  });
  t.after(() => clearTimeout(timeout));
  const entered = new Promise<void>((resolve) => {
      checking = resolve;
    }),
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
  Object.assign(f.controller, {
    isOutboxReady: async () => {
      if (checks++ === 0) {
        checking();
        await gate;
        return false;
      }
      return true;
    },
    prompt: async () => {
      sends++;
      sent();
      return { disposition: 'started' };
    },
  });
  f.controller.snapshot.connectionState = 'ready';
  f.controller.outboxCompletionRevision++;
  const active = f.manager.wakeOutbox(f.controller);
  await entered;
  f.manager.observeOutbox(f.controller); // Native readiness changed while the old busy result was in flight.
  release();
  await active;
  await Promise.race([delivered, deadline]);
  await Promise.race([settled, deadline]);
  await f.box.snapshot(chatTargetSessionKey(f.target));
  assert.equal(sends, 1, 'the readiness event must request another check after the active probe');
});
