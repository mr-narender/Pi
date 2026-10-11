import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, appendFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSessionHistory, SessionHistoryCache } from '../../src/sessions/sessionHistory';

const message = (text: string) => ({ role: 'user', content: [{ type: 'text', text }] });
const entry = (id: string, parentId: string | null, text: string) => ({
  type: 'message',
  id,
  parentId,
  message: message(text),
});

test('streamed history preserves forks, pre-compaction history, images and leaf identity', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-history-'));
  const file = join(dir, 'session.jsonl');
  try {
    const image = {
      role: 'user',
      content: [{ type: 'image', data: 'base64', mimeType: 'image/png' }],
    };
    await writeFile(
      file,
      [
        entry('root', null, 'before'),
        { type: 'compaction', id: 'compact', parentId: 'root', summary: 'summary' },
        { type: 'message', id: 'active', parentId: 'compact', message: image },
        entry('other', 'root', 'wrong branch'),
        null,
        'bad',
      ]
        .map((r) => (typeof r === 'string' ? r : JSON.stringify(r)))
        .join('\n') + '\n{"partial":'
    );
    assert.deepEqual(await readSessionHistory(file, 'active'), [message('before'), image]);
    assert.deepEqual(await readSessionHistory(file, null), []);
    assert.deepEqual(await readSessionHistory(file), [message('before'), message('wrong branch')]);
  } finally {
    await rm(dir, { recursive: true });
  }
});

test('streamed legacy v1 history keeps linear messages', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-history-'));
  try {
    const file = join(dir, 'session.jsonl');
    await writeFile(file, JSON.stringify({ type: 'message', message: message('legacy') }));
    assert.deepEqual(await readSessionHistory(file, null), [message('legacy')]);
  } finally {
    await rm(dir, { recursive: true });
  }
});

test('history cache validates leaf, append, truncation, replacement and deletion', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-history-'));
  const file = join(dir, 'session.jsonl');
  const cache = new SessionHistoryCache();
  try {
    await writeFile(file, JSON.stringify(entry('a', null, 'one')) + '\n');
    const first = await cache.read(file, 'a');
    assert.equal(await cache.read(file, 'a'), first, 'unchanged history reuses parsed result');
    assert.deepEqual(await cache.read(file, null), []);
    await appendFile(file, JSON.stringify(entry('b', 'a', 'two')) + '\n');
    assert.deepEqual(await cache.read(file, 'b'), [message('one'), message('two')]);
    await writeFile(file, JSON.stringify(entry('c', null, 'new')) + '\n');
    assert.deepEqual(await cache.read(file), [message('new')]);
    const replacement = join(dir, 'replacement');
    await writeFile(replacement, JSON.stringify(entry('d', null, 'new')) + '\n');
    await rename(replacement, file);
    assert.deepEqual(await cache.read(file, 'd'), [message('new')]);
    await rm(file);
    await assert.rejects(cache.read(file));
  } finally {
    await rm(dir, { recursive: true });
  }
});

test('large history is returned in full but never retained in the repeat cache', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-history-'));
  try {
    const file = join(dir, 'session.jsonl');
    await writeFile(file, JSON.stringify(entry('a', null, 'x'.repeat(2 * 1024 * 1024))));
    const cache = new SessionHistoryCache();
    assert.notEqual(await cache.read(file), await cache.read(file));
  } finally {
    await rm(dir, { recursive: true });
  }
});
