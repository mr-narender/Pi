import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, writeFile, rm, rename, utimes } from 'node:fs/promises';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { readRecentSessionsIndex } from '../../src/sessions/recentSessions';
import { createTestDirectory } from '../helpers/temp';

test('metadata scans reuse unchanged files, invalidate replacement and do not reuse deleted paths', async () => {
  const root = await createTestDirectory('metadata-cache-');
  const directory = join(root, 'sessions');
  await mkdir(directory);
  const file = join(directory, 'session.jsonl');
  const context = {
    workspaceName: 'fixture',
    workspacePath: root,
    additionalArgs: ['--session-dir', directory],
  };
  const contents = (name: string) =>
    JSON.stringify({ type: 'session', id: 'test', cwd: root }) +
    '\n' +
    JSON.stringify({ type: 'session_info', name }) +
    '\n';
  await writeFile(file, contents('First'));
  const mutableFs = require('node:fs') as typeof fs;
  const original = mutableFs.createReadStream;
  let reads = 0;
  mutableFs.createReadStream = ((...args: Parameters<typeof fs.createReadStream>) => {
    reads++;
    return original(...args);
  }) as typeof fs.createReadStream;
  try {
    assert.equal((await readRecentSessionsIndex(context)).sessions[0]?.displayName, 'First');
    const afterFirst = reads;
    assert.equal((await readRecentSessionsIndex(context)).sessions[0]?.displayName, 'First');
    assert.equal(reads, afterFirst, 'unchanged metadata must not reopen session');
    await writeFile(join(directory, 'replacement'), contents('Other'));
    const previous = await fs.promises.stat(file);
    await utimes(join(directory, 'replacement'), previous.atime, previous.mtime);
    await rename(join(directory, 'replacement'), file);
    assert.equal((await readRecentSessionsIndex(context)).sessions[0]?.displayName, 'Other');
    await rm(file);
    assert.equal((await readRecentSessionsIndex(context)).sessions.length, 0);
    await writeFile(file, contents('Again'));
    assert.equal((await readRecentSessionsIndex(context)).sessions[0]?.displayName, 'Again');
  } finally {
    mutableFs.createReadStream = original;
    await rm(root, { recursive: true, force: true });
  }
});

test('metadata scan is line-bounded even when no nonempty user prompt exists', async () => {
  const root = await createTestDirectory('metadata-bound-');
  const file = join(root, 'session.jsonl');
  try {
    await writeFile(
      file,
      [
        JSON.stringify({ type: 'session', id: 'test', cwd: root }),
        ...Array.from({ length: 1000 }, (_, index) =>
          JSON.stringify({
            type: 'session_info',
            name: index < 799 ? 'Within bound' : 'Beyond bound',
          })
        ),
      ].join('\n') + '\n'
    );
    const index = await readRecentSessionsIndex({
      workspaceName: 'fixture',
      workspacePath: root,
      additionalArgs: ['--session-dir', root],
    });
    assert.equal(index.sessions[0]?.displayName, 'Within bound');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a 700-session directory stays cached on repeated scans', async () => {
  const root = await createTestDirectory('metadata-scale-');
  const mutableFs = require('node:fs') as typeof fs;
  const original = mutableFs.createReadStream;
  let reads = 0;
  mutableFs.createReadStream = ((...args: Parameters<typeof fs.createReadStream>) => {
    reads++;
    return original(...args);
  }) as typeof fs.createReadStream;
  try {
    for (let index = 0; index < 700; index++) {
      await writeFile(
        join(root, `${index}.jsonl`),
        JSON.stringify({ type: 'session', id: `s${index}`, cwd: root }) + '\n'
      );
    }
    const context = {
      workspaceName: 'fixture',
      workspacePath: root,
      additionalArgs: ['--session-dir', root],
    };
    assert.equal((await readRecentSessionsIndex(context)).sessions.length, 700);
    const afterFirst = reads;
    assert.equal((await readRecentSessionsIndex(context)).sessions.length, 700);
    assert.equal(reads, afterFirst, 'normal large directories must fit in the bounded cache');
  } finally {
    mutableFs.createReadStream = original;
    await rm(root, { recursive: true, force: true });
  }
});

test('large first prompt and image records retain previews and later names within existing line window', async () => {
  const root = await createTestDirectory('metadata-images-');
  try {
    const entries = [
      { type: 'session', id: 'test', cwd: root },
      {
        type: 'message',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'First prompt ' + 'x'.repeat(1024 * 1024) },
            { type: 'image', data: 'a'.repeat(1024 * 1024), mimeType: 'image/png' },
          ],
        },
      },
      ...Array.from({ length: 100 }, () => ({
        type: 'message',
        message: { role: 'assistant', content: 'Synthetic response' },
      })),
      { type: 'session_info', name: 'Renamed after messages' },
    ];
    await writeFile(
      join(root, 'session.jsonl'),
      entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n'
    );
    const context = {
      workspaceName: 'fixture',
      workspacePath: root,
      additionalArgs: ['--session-dir', root],
    };
    const first = (await readRecentSessionsIndex(context)).sessions[0];
    assert.equal(first?.displayName, 'Renamed after messages');
    assert.equal(first?.firstPromptPreview?.startsWith('First prompt '), true);
    assert.deepEqual((await readRecentSessionsIndex(context)).sessions[0], first);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
