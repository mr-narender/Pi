import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import { mkdtemp, readFile, rm, stat, rename, writeFile, readdir } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildSendPreview,
  acceptedSnapshotFromPreview,
  createEmptyComposerState,
} from '../../src/webview/composer';

async function store(root: string) {
  assert.ok(existsSync('src/outbox/store.ts'), 'the durable extension-owned outbox is missing');
  const { OutboxStore } = await import('../../src/outbox/store.js');
  const box = new OutboxStore(root);
  boxes.push(box);
  return box;
}
const boxes: Array<{ dispose(): Promise<void> }> = [];
test.after(async () => {
  for (const box of boxes) await box.dispose().catch(() => {});
});
function payload() {
  const composer = createEmptyComposerState();
  composer.draft = 'Explain this screenshot';
  composer.pendingImages = [
    {
      itemId: 'image',
      name: 'screen.png',
      mimeType: 'image/png',
      sizeBytes: 3,
      inMemoryBase64: 'YWJj',
    },
  ];
  return acceptedSnapshotFromPreview(buildSendPreview('follow_up', composer), []);
}
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'pi-outbox-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('outbox durably owns frozen payloads and restart pauses unsent work', async (t) => {
  const root = await fixture(t),
    box = await store(root),
    original = payload();
  const item = await box.enqueue('chat-jsonl-1', original, 'submission-1');
  original.rpcImages[0]!.data = 'changed';
  assert.equal((await box.payload('chat-jsonl-1', item.id)).rpcImages[0]!.data, 'YWJj');
  assert.equal((await box.snapshot('another-chat')).items.length, 0);
  await box.dispose();
  const reopened = await store(root);
  assert.equal((await reopened.snapshot('chat-jsonl-1')).items[0]!.status, 'paused');
  assert.equal((await reopened.payload('chat-jsonl-1', item.id)).rpcImages[0]!.data, 'YWJj');
  assert.equal((await stat(box.pathFor('chat-jsonl-1'))).mode & 0o777, 0o600);
});

test('outbox editing holds FIFO; save preserves attachments without sending', async (t) => {
  const box = await store(await fixture(t));
  const first = await box.enqueue('chat', payload(), 's1');
  await box.enqueue('chat', payload(), 's2');
  const editing = await box.action('chat', first.id, first.revision, 'edit');
  assert.equal(await box.next('chat'), undefined);
  const saved = await box.action('chat', first.id, editing!.revision, 'save', 'Updated request');
  assert.equal(saved!.status, 'held');
  assert.equal(await box.next('chat'), undefined);
  const updated = await box.payload('chat', first.id);
  assert.equal(updated.draft, 'Updated request');
  assert.equal(updated.rpcImages[0]!.data, 'YWJj');
  await assert.rejects(box.action('chat', first.id, first.revision, 'remove'), /changed/);
  await box.action('chat', first.id, saved!.revision, 'resume');
  assert.equal((await box.next('chat'))!.id, first.id);
});

test('handoff is persisted before RPC, locks edits, and crash makes delivery unknown', async (t) => {
  const root = await fixture(t),
    box = await store(root);
  const item = await box.enqueue('chat', payload(), 's1');
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  let sends = 0;
  const dispatch = box.dispatch(
    'chat',
    item.id,
    item.revision,
    async (frozen) => {
      sends++;
      assert.equal(frozen.rpcImages[0]!.data, 'YWJj');
      assert.equal(
        JSON.parse(await readFile(box.pathFor('chat'), 'utf8')).items[0].status,
        'sending'
      );
      entered();
      await wait;
      return { disposition: 'started' };
    },
    () => true
  );
  await started;
  await assert.rejects(box.action('chat', item.id, item.revision, 'remove'), /changed|sending/);
  await box.dispose();
  const restarted = await store(root);
  assert.equal((await restarted.snapshot('chat')).items[0]!.status, 'unknown');
  assert.equal(await restarted.next('chat'), undefined);
  release();
  await dispatch; // A late ACK cannot reclaim or overwrite the restarted owner's unknown row.
  assert.equal(sends, 1);
  const row = (await restarted.snapshot('chat')).items[0]!;
  assert.equal(row.status, 'unknown');
});

test('failed durable write retains the old queue; delivery error never automatically retries', async (t) => {
  const root = await fixture(t),
    directory = join(root, 'private'),
    box = await store(directory);
  const item = await box.enqueue('chat', payload(), 's1');
  await rename(directory, `${directory}-old`);
  await writeFile(directory, 'not a directory');
  await assert.rejects(box.enqueue('chat', payload(), 's2'));
  assert.equal((await box.snapshot('chat')).items.length, 1);
  await rm(directory);
  await rename(`${directory}-old`, directory);
  await assert.rejects(
    box.dispatch(
      'chat',
      item.id,
      item.revision,
      async () => {
        throw new Error('transport failed');
      },
      () => true
    )
  );
  assert.equal((await box.snapshot('chat')).items[0]!.status, 'unknown');
  assert.equal(await box.next('chat'), undefined);
});

test('pre-call invalidation pauses a provably unsent row; unknown discard never replays later work', async (t) => {
  const box = await store(await fixture(t));
  const item = await box.enqueue('chat', payload(), 's1');
  let checks = 0,
    sends = 0;
  await assert.rejects(
    box.dispatch(
      'chat',
      item.id,
      item.revision,
      async () => {
        sends++;
        return {};
      },
      () => ++checks === 1
    )
  );
  assert.equal(sends, 0);
  let row = (await box.snapshot('chat')).items[0]!;
  assert.equal(row.status, 'paused');
  await assert.rejects(
    box.dispatch(
      'chat',
      row.id,
      row.revision,
      async () => {
        throw new Error('unknown');
      },
      () => true
    )
  );
  row = (await box.snapshot('chat')).items[0]!;
  await box.enqueue('chat', payload(), 's2');
  await box.action('chat', row.id, row.revision, 'discard');
  assert.equal((await box.snapshot('chat')).items[0]!.status, 'paused');
  assert.equal(await box.next('chat'), undefined);
});

test('metadata projections exclude RPC bytes; failed oversized edit retains durable original context', async (t) => {
  const box = await store(await fixture(t)),
    frozen = payload();
  frozen.serializedContextEnvelope = 'x'.repeat(190000);
  frozen.rpcMessage = `${frozen.draft}\n\n${frozen.serializedContextEnvelope}`;
  const row = await box.enqueue('chat', frozen, 's1');
  assert.equal('payload' in row, false);
  assert.equal('payload' in (await box.next('chat'))!, false);
  const editing = await box.action('chat', row.id, row.revision, 'edit');
  await assert.rejects(box.action('chat', row.id, editing!.revision, 'save', 'a'.repeat(160000)));
  const unchanged = await box.payload('chat', row.id);
  assert.equal(unchanged.rpcMessage, frozen.rpcMessage);
  const saved = await box.action('chat', row.id, editing!.revision, 'save', 'Updated');
  assert.equal(
    (await box.payload('chat', saved!.id)).rpcMessage,
    `Updated\n\n${frozen.serializedContextEnvelope}`
  );
});

test('live ownership is exclusive per chat and disposal allows paused recovery', async (t) => {
  const root = await fixture(t),
    first = await store(root),
    second = await store(root);
  await first.enqueue('same-chat', payload(), 'first');
  const observed = await second.snapshot('same-chat');
  assert.equal(observed.readOnly, true);
  assert.equal(observed.items.length, 1);
  await assert.rejects(second.enqueue('same-chat', payload(), 'duplicate'), /ownership/);
  await second.enqueue('independent-chat', payload(), 'independent');
  await first.dispose();
  const recovered = await second.snapshot('same-chat');
  assert.notEqual(recovered.readOnly, true);
  assert.equal(recovered.items[0]!.status, 'paused');
});

test('missing snapshot never adopts or overwrites an outbox created by another window', async (t) => {
  const root = await fixture(t),
    observer = await store(root),
    owner = await store(root),
    key = 'snapshot-race',
    file = observer.pathFor(key);
  let missing!: () => void,
    resumeSnapshot!: () => void,
    captured!: () => void,
    resumeRead!: () => void;
  const missingFile = new Promise<void>((resolve) => {
    missing = resolve;
  });
  const snapshotGate = new Promise<void>((resolve) => {
    resumeSnapshot = resolve;
  });
  const capturedRead = new Promise<void>((resolve) => {
    captured = resolve;
  });
  const readGate = new Promise<void>((resolve) => {
    resumeRead = resolve;
  });
  const originalLstat = fs.lstat,
    originalRead = fs.readFile;
  let intercepted = false,
    reads = 0;
  const lstatMock = mock.method(fs, 'lstat', async (...args: Parameters<typeof fs.lstat>) => {
    if (String(args[0]) === file && !intercepted) {
      intercepted = true;
      try {
        return await originalLstat(...args);
      } catch (error) {
        assert.equal((error as NodeJS.ErrnoException).code, 'ENOENT');
        missing();
        await snapshotGate;
        throw error;
      }
    }
    return originalLstat(...args);
  });
  const readMock = mock.method(fs, 'readFile', async (...args: Parameters<typeof fs.readFile>) => {
    const bytes = await originalRead(...args);
    if (String(args[0]) === file) {
      reads++;
      captured();
      await readGate;
    }
    return bytes;
  });
  syncBuiltinESMExports();
  const snapshot = observer.snapshot(key);
  try {
    await missingFile;
    const first = await owner.enqueue(key, payload(), 'first');
    resumeSnapshot();
    await Promise.race([snapshot, capturedRead]);
    const second = await owner.enqueue(key, payload(), 'second');
    resumeRead();
    const observed = await snapshot;
    const stored = JSON.parse(await originalRead(file, 'utf8'));
    assert.deepEqual(
      stored.items.map((item: { id: string }) => item.id),
      [first.id, second.id]
    );
    assert.ok(stored.items.every((item: { status: string }) => item.status === 'queued'));
    assert.deepEqual(observed, { key, items: [] });
    assert.equal(reads, 0, 'a missing snapshot must not read or adopt a later owner record');
  } finally {
    resumeSnapshot();
    resumeRead();
    await snapshot.catch(() => {});
    lstatMock.mock.restore();
    readMock.mock.restore();
    syncBuiltinESMExports();
  }
});

test('storage failure during suspend or dispose still releases live ownership', async (t) => {
  for (const operation of ['suspend', 'dispose'] as const) {
    const root = await fixture(t),
      directory = join(root, 'private'),
      box = await store(directory);
    await box.enqueue('chat', payload(), 's1');
    await rename(directory, `${directory}-old`);
    await writeFile(directory, 'not a directory');
    await assert.rejects(operation === 'dispose' ? box.dispose() : box.suspend('chat'));
    await rm(directory);
    await rename(`${directory}-old`, directory);
    const other = await store(directory),
      snapshot = await other.snapshot('chat');
    assert.equal(snapshot.readOnly, undefined);
    assert.equal(snapshot.items[0]!.status, 'paused');
  }
});

test('full record quota rejects new chats but permits existing removal and reclaims accepted data', async (t) => {
  const root = await fixture(t),
    box = await store(root),
    item = await box.enqueue('chat', payload(), 's1');
  for (let i = 0; i < 127; i++) await writeFile(box.pathFor(`seed-${i}`), '{}', { mode: 0o600 });
  await assert.rejects(box.enqueue('new-chat', payload(), 's2'), /full/);
  assert.equal((await readdir(root)).filter((name) => name.endsWith('.json')).length, 128);
  await box.action('chat', item.id, item.revision, 'remove');
  const fresh = await box.enqueue('new-chat', payload(), 's2');
  await box.dispatch(
    'new-chat',
    fresh.id,
    fresh.revision,
    async () => ({ disposition: 'started' }),
    () => true
  );
  assert.equal(existsSync(box.pathFor('new-chat')), false);
});

test('missing native acknowledgement retains frozen payload as unknown without resending', async (t) => {
  const box = await store(await fixture(t)),
    row = await box.enqueue('chat', payload(), 's1');
  let calls = 0;
  await assert.rejects(
    box.dispatch(
      'chat',
      row.id,
      row.revision,
      async () => {
        calls++;
        return undefined;
      },
      () => true
    ),
    /confirmed/
  );
  assert.equal((await box.snapshot('chat')).items[0]!.status, 'unknown');
  assert.equal((await box.payload('chat', row.id)).rpcImages[0]!.data, 'YWJj');
  assert.equal(await box.next('chat'), undefined);
  assert.equal(calls, 1);
  const malformed = await box.enqueue('malformed', payload(), 's2');
  await assert.rejects(
    box.dispatch(
      'malformed',
      malformed.id,
      malformed.revision,
      async () => ({ disposition: ['started'] }),
      () => true
    ),
    /confirmed/
  );
  assert.equal((await box.snapshot('malformed')).items[0]!.status, 'unknown');
  assert.equal((await box.payload('malformed', malformed.id)).rpcImages[0]!.data, 'YWJj');
});
