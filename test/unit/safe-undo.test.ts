import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import {
  mkdtemp,
  readFile,
  writeFile,
  rm,
  stat,
  chmod,
  mkdir,
  rename,
  symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { computeHunks } from '../../src/review/hunks';

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'pi-safe-undo-'));
  const path = join(directory, 'file.txt');
  const uri = { fsPath: path, toString: () => path };
  const notices: string[] = [];
  const documents: any[] = [];
  const output = await build({
    stdin: {
      contents:
        "export * from './src/review/safeUndo'; export { TurnReview } from './src/review/turnReview'; export { InlineReview } from './src/review/inlineReview';",
      resolveDir: process.cwd(),
      loader: 'ts',
    },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    external: ['vscode'],
  });
  const module = { exports: {} as any };
  const require = createRequire(`${process.cwd()}/package.json`);
  const vscodeStub: any = {
    Uri: { file: (fsPath: string) => ({ fsPath, toString: () => fsPath }) },
    EventEmitter: class {
      event = () => ({ dispose() {} });
      fire() {}
    },
    Range: class {
      constructor(..._args: any[]) {}
    },
    WorkspaceEdit: class {
      replace() {}
    },
    workspace: { isTrusted: true, textDocuments: documents },
    window: {
      showWarningMessage: async (message: string) => {
        notices.push(message);
        return 'Keep current file';
      },
    },
  };
  new Function('require', 'module', 'exports', output.outputFiles[0]!.text)(
    (name: string) => (name === 'vscode' ? vscodeStub : require(name)),
    module,
    module.exports
  );
  return {
    ...module.exports,
    path,
    uri,
    notices,
    documents,
    vscode: vscodeStub,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

test('safe Undo restores exact unchanged bytes including CRLF, binary data and mode', async () => {
  const f = await fixture();
  try {
    const before = Buffer.from([0xff, 0x0d, 0x0a, 0]);
    await writeFile(f.path, 'Pi result\r\n', { mode: 0o755 });
    const after = await f.captureUndoState(f.uri);
    assert.equal(await f.restoreUndoFile(f.uri, after, before), true);
    assert.deepEqual(await readFile(f.path), before);
    assert.equal((await stat(f.path)).mode & 0o777, 0o755);
    assert.equal(f.notices.length, 0);
  } finally {
    await f.cleanup();
  }
});

test('card Undo needs saved post-state and never guesses repeated or deleted regions', async () => {
  const f = await fixture();
  try {
    const changes = [{ oldText: 'before', newText: 'Pi result' }];
    await writeFile(f.path, 'Pi result');
    assert.equal(await f.undoTextChanges(f.uri, undefined, changes, () => true), false);
    const after = await f.captureUndoState(f.uri);
    await writeFile(f.path, 'my prefix Pi result');
    assert.equal(await f.undoTextChanges(f.uri, after, changes, () => true), false);
    assert.equal(await readFile(f.path, 'utf8'), 'my prefix Pi result');
    assert.equal(
      f.reverseEditReplacements('same same', [{ oldText: 'before', newText: 'same' }]),
      undefined
    );
    assert.equal(
      f.reverseEditReplacements('remaining', [{ oldText: 'deleted', newText: '' }]),
      undefined
    );
    assert.equal(
      f.reverseEditReplacements('C', [
        { oldText: 'A', newText: 'B' },
        { oldText: 'B', newText: 'C' },
      ]),
      'A'
    );
  } finally {
    await f.cleanup();
  }
});

test('canonical ancestor changes cannot redirect Undo outside its recorded folder', async () => {
  const f = await fixture();
  try {
    const root = join(f.path, '..', 'root');
    const sub = join(root, 'sub');
    const outside = join(f.path, '..', 'outside');
    await mkdir(sub, { recursive: true });
    const uri = { fsPath: join(sub, 'nested.txt') };
    await writeFile(uri.fsPath, 'Pi result');
    const after = await f.captureUndoState(uri);
    await rename(sub, outside);
    await symlink(outside, sub, 'dir');
    assert.equal(await f.matchesUndoState(uri, after), false);
    await assert.rejects(f.resolveUndoUri(root, 'sub/nested.txt'), /outside/);
    await assert.rejects(f.resolveUndoUri(root, '../outside/missing.txt'), /outside/);
    assert.equal(await readFile(join(outside, 'nested.txt'), 'utf8'), 'Pi result');
  } finally {
    await f.cleanup();
  }
});

async function turnFixture(nested = false) {
  const f = await fixture();
  const root = join(f.path, '..', 'repository');
  const cwd = nested ? join(root, 'nested') : root;
  await mkdir(cwd, { recursive: true });
  const exec = promisify(execFile);
  const git = async (...args: string[]) => (await exec('git', args, { cwd: root })).stdout;
  await git('init', '-q');
  const path = join(cwd, 'file.txt');
  await writeFile(path, 'before\r\n');
  await git('add', '.');
  await git(
    '-c',
    'user.name=Pi test',
    '-c',
    'user.email=pi-test@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-qm',
    'fixture'
  );
  const saved = new Map<string, any>();
  const memento = {
    get: (key: string, fallback: any) => saved.get(key) ?? fallback,
    update: async (key: string, value: any) => {
      saved.set(key, JSON.parse(JSON.stringify(value)));
    },
  };
  const controller = {
    folder: { uri: { fsPath: cwd } },
    snapshot: {
      state: { sessionFile: 'owned-session.jsonl' },
      messages: [] as any[],
      runOutcome: 'completed',
    },
  };
  const warnings: string[] = [];
  const review = new f.TurnReview(
    {
      info() {},
      warn(message: string) {
        warnings.push(message);
      },
    },
    memento
  );
  const originalGit = review.git.bind(review);
  review.git = async (...args: any[]) => {
    try {
      return await originalGit(...args);
    } catch (error) {
      warnings.push(`fixture git ${String(args[1])}: ${String(error)}`);
      throw error;
    }
  };
  return { ...f, root, cwd, path, git, controller, review, memento, warnings };
}

async function piWrite(f: any, text: string) {
  const tool = {
    id: `write-${Date.now()}`,
    name: 'write',
    args: { path: f.path, content: text },
    startedAt: Date.now(),
    endedAt: undefined as number | undefined,
  };
  f.controller.snapshot.tools = [tool];
  await f.review.observeTools(f.controller);
  await writeFile(f.path, text);
  tool.endedAt = Date.now();
  await f.review.observeTools(f.controller);
}

for (const nested of [false, true])
  test(`turn Undo restores exact file without altering staging (nested=${nested})`, async () => {
    const f = await turnFixture(nested);
    try {
      await writeFile(f.path, 'staged');
      await f.git('add', '.');
      await writeFile(f.path, 'before\r\n');
      const index = await f.git('ls-files', '-s');
      await f.review.onTurnStart(f.controller);
      await chmod(f.path, 0o755);
      await piWrite(f, 'Pi result\r\n');
      await f.review.onTurnEnd(f.controller, { silent: true });
      const record = f.review.history[0];
      assert.ok(record?.changes[0]?.afterSha, 'saved byte-exact post-result evidence');
      assert.equal(record.changes[0].file, 'file.txt');
      const restored = new f.TurnReview({ info() {}, warn() {} }, f.memento);
      assert.equal(
        await restored.revertFile(restored.history[0], restored.history[0].changes[0]),
        true
      );
      assert.equal(await readFile(f.path, 'utf8'), 'before\r\n');
      assert.equal((await stat(f.path)).mode & 0o777, 0o644);
      assert.equal(await f.git('ls-files', '-s'), index);
    } finally {
      await f.cleanup();
    }
  });

test('turn Undo keeps newer files and missing legacy or before evidence; post refs remain rooted', async () => {
  const f = await turnFixture();
  try {
    await f.review.onTurnStart(f.controller);
    assert.ok(
      f.review.snapshots.has(f.controller),
      f.warnings.join('\n') || 'before snapshot exists'
    );
    await piWrite(f, 'Pi result');
    await f.review.onTurnEnd(f.controller, { silent: true });
    const record = f.review.history[0];
    const change = record.changes[0];
    assert.ok((await f.git('show-ref')).includes(change.afterRef));
    await writeFile(f.path, 'newer work');
    assert.equal(await f.review.revertFile(record, change), false);
    assert.equal(await f.review.revertFile(record, { ...change, after: undefined }), false);
    assert.equal(await f.review.revertFile({ ...record, sha: '0'.repeat(40) }, change), false);
    assert.equal(await readFile(f.path, 'utf8'), 'newer work');
  } finally {
    await f.cleanup();
  }
});

test('non-git card Undo uses completion evidence and rejects the same snippet after newer edits', async () => {
  const f = await fixture();
  try {
    const controller = {
      folder: { uri: { fsPath: join(f.path, '..') } },
      snapshot: {
        state: { sessionFile: 'one.jsonl' },
        messages: [] as any[],
        runOutcome: 'completed',
      },
    };
    const review = new f.TurnReview({ info() {}, warn() {} });
    await writeFile(f.path, 'before');
    await review.onTurnStart(controller);
    controller.snapshot.messages = [
      {
        role: 'assistant',
        content: [
          {
            type: 'toolCall',
            id: 'call-one',
            name: 'edit',
            arguments: { path: f.path, oldText: 'before', newText: 'Pi result' },
          },
        ],
      },
      { role: 'toolResult', toolCallId: 'call-one', isError: false },
    ];
    const tool = {
      id: 'call-one',
      name: 'edit',
      args: { path: f.path, oldText: 'before', newText: 'Pi result' },
      startedAt: Date.now(),
      endedAt: undefined as number | undefined,
    };
    (controller.snapshot as any).tools = [tool];
    await review.observeTools(controller);
    await writeFile(f.path, 'Pi result');
    tool.endedAt = Date.now();
    await review.observeTools(controller);
    await review.onTurnEnd(controller, { silent: true });
    assert.equal(await review.undoEdit(controller, 'call-one', () => true), true);
    assert.equal(await readFile(f.path, 'utf8'), 'before');
    await writeFile(f.path, 'newer Pi result');
    assert.equal(await review.undoEdit(controller, 'call-one', () => true), false);
    assert.equal(await readFile(f.path, 'utf8'), 'newer Pi result');
    assert.equal(await review.undoEdit(controller, 'forged-call', () => true), false);
  } finally {
    await f.cleanup();
  }
});

test('private file permissions remain private after a normal turn Undo', async () => {
  const f = await turnFixture();
  try {
    await chmod(f.path, 0o600);
    await f.review.onTurnStart(f.controller);
    await piWrite(f, 'Pi result');
    await f.review.onTurnEnd(f.controller, { silent: true });
    assert.ok(f.review.history[0], f.warnings.join('\n') || 'completed turn is recorded');
    assert.equal(
      await f.review.revertFile(f.review.history[0], f.review.history[0].changes[0]),
      true
    );
    assert.equal((await stat(f.path)).mode & 0o777, 0o600);
  } finally {
    await f.cleanup();
  }
});

test('tool evidence from a previous session or invalidated native origin is never adopted', async () => {
  const f = await fixture();
  try {
    let live = true;
    const tool = {
      id: 'same-call',
      name: 'edit',
      args: { path: f.path, oldText: 'before', newText: 'Pi result' },
      startedAt: Date.now(),
      endedAt: undefined as number | undefined,
    };
    const controller = {
      folder: { uri: { fsPath: join(f.path, '..') } },
      captureFileUndoOrigin: () => () => live,
      snapshot: { state: { sessionFile: 'old-session' }, tools: [tool], messages: [] },
    };
    const review = new f.TurnReview({ info() {}, warn() {} });
    await writeFile(f.path, 'Pi result');
    await review.observeTools(controller);
    controller.snapshot.state.sessionFile = 'new-session';
    tool.endedAt = Date.now();
    await review.observeTools(controller);
    assert.equal(review.editResults.length, 0);
    tool.endedAt = undefined;
    await review.observeTools(controller);
    tool.endedAt = Date.now();
    const pending = review.observeTools(controller);
    live = false;
    await pending;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(review.editResults.length, 0);
    assert.equal(review.toolCaptures.size, 0);
  } finally {
    await f.cleanup();
  }
});

test('newer edits between tool completion and agent completion are never adopted as the Pi result', async () => {
  const f = await turnFixture();
  try {
    await f.review.onTurnStart(f.controller);
    await piWrite(f, 'Pi result');
    await writeFile(f.path, 'my later work while Pi summarizes');
    await f.review.onTurnEnd(f.controller, { silent: true });
    assert.equal(
      await f.review.revertFile(f.review.history[0], f.review.history[0].changes[0]),
      false
    );
    assert.equal(await readFile(f.path, 'utf8'), 'my later work while Pi summarizes');
    assert.equal(f.review.toolCaptures.has(f.controller), false);
    assert.equal(f.review.pendingTools.has(f.controller), false);
  } finally {
    await f.cleanup();
  }
});

test('a new run or navigation during card Undo invalidates the pending restore', async () => {
  const f = await fixture();
  try {
    let currentOrigin = true;
    await writeFile(f.path, 'Pi result');
    const after = await f.captureUndoState(f.uri);
    const cwd = join(f.path, '..');
    const controller = {
      folder: { uri: { fsPath: cwd } },
      captureFileUndoOrigin: () => () => currentOrigin,
      snapshot: {
        state: { sessionFile: 'owned-session' },
        messages: [
          {
            role: 'assistant',
            content: [
              {
                type: 'toolCall',
                id: 'owned-call',
                name: 'edit',
                arguments: { path: f.path, oldText: 'before', newText: 'Pi result' },
              },
            ],
          },
        ],
      },
    };
    const review = new f.TurnReview({ info() {}, warn() {} });
    review.editResults.push({
      session: 'owned-session',
      callId: 'owned-call',
      cwd,
      path: f.path,
      after,
    });
    const pending = review.undoEdit(controller, 'owned-call', () => true);
    currentOrigin = false;
    assert.equal(await pending, false);
    assert.equal(await readFile(f.path, 'utf8'), 'Pi result');
  } finally {
    await f.cleanup();
  }
});

test('inline Undo never adopts an external disk write after saving its own edit', async () => {
  const f = await fixture();
  try {
    await writeFile(f.path, 'Pi result\n');
    const expected = await f.captureUndoState(f.uri);
    let text = 'Pi result\n';
    const document = {
      uri: f.uri,
      version: 1,
      isDirty: false,
      lineCount: 2,
      getText: () => text,
      save: async () => {
        await writeFile(f.path, 'external writer\n');
        return true;
      },
    };
    f.documents.push(document);
    f.vscode.workspace.openTextDocument = async () => document;
    f.vscode.workspace.applyEdit = async () => {
      text = 'before\n';
      return true;
    };
    const entry = {
      before: 'before\n',
      text,
      expected,
      hunks: await computeHunks('before\n', text),
    };
    const review = Object.create(f.InlineReview.prototype);
    review.active = new Map([[f.path, entry]]);
    await review.revertHunk(f.path, 0);
    assert.equal(entry.expected.digest, expected.digest);
    assert.equal(await readFile(f.path, 'utf8'), 'external writer\n');
  } finally {
    await f.cleanup();
  }
});

for (const failure of ['dirty', 'apply', 'save'] as const)
  test(`inline Undo protects the document on ${failure} failure`, async () => {
    const f = await fixture();
    try {
      await writeFile(f.path, 'Pi result\n');
      const expected = await f.captureUndoState(f.uri);
      let applied = 0;
      let saved = 0;
      const document = {
        uri: f.uri,
        version: 1,
        isDirty: failure === 'dirty',
        lineCount: 2,
        getText: () => (failure === 'dirty' ? 'my unsaved work' : 'Pi result\n'),
        save: async () => {
          saved++;
          return false;
        },
      };
      f.documents.push(document);
      f.vscode.workspace.openTextDocument = async () => document;
      f.vscode.workspace.applyEdit = async () => {
        applied++;
        return failure !== 'apply';
      };
      const review = Object.create(f.InlineReview.prototype);
      review.active = new Map([
        [
          f.path,
          {
            before: 'before\n',
            text: 'Pi result\n',
            expected,
            hunks: await computeHunks('before\n', 'Pi result\n'),
          },
        ],
      ]);
      if (failure === 'dirty') {
        await review.revertHunk(f.path, 0);
        assert.equal(applied, 0);
      } else {
        await assert.rejects(
          review.revertHunk(f.path, 0),
          failure === 'apply' ? /apply Undo/ : /save Undo/
        );
      }
      assert.equal(saved, failure === 'save' ? 1 : 0);
      assert.equal(await readFile(f.path, 'utf8'), 'Pi result\n');
    } finally {
      await f.cleanup();
    }
  });

for (const kind of ['modified', 'created', 'legacy', 'dirty', 'deleted-recreated'] as const) {
  test(`safe Undo preserves ${kind} current content`, async () => {
    const f = await fixture();
    try {
      if (kind !== 'deleted-recreated') await writeFile(f.path, 'Pi result');
      const after = kind === 'legacy' ? undefined : await f.captureUndoState(f.uri);
      if (kind === 'dirty')
        f.documents.push({ uri: f.uri, isDirty: true, getText: () => 'my unsaved work' });
      else await writeFile(f.path, 'newer work');
      assert.equal(
        await f.restoreUndoFile(f.uri, after, kind === 'created' ? null : Buffer.from('before')),
        false
      );
      assert.equal(await readFile(f.path, 'utf8'), kind === 'dirty' ? 'Pi result' : 'newer work');
      assert.equal(f.notices.length, 1);
    } finally {
      await f.cleanup();
    }
  });
}

test('safe Undo deletes an unchanged Pi-created file and restores a still-deleted file', async () => {
  const f = await fixture();
  try {
    await writeFile(f.path, 'created by Pi');
    const after = await f.captureUndoState(f.uri);
    assert.equal(await f.restoreUndoFile(f.uri, after, null), true);
    await assert.rejects(readFile(f.path), { code: 'ENOENT' });
    const missing = await f.captureUndoState(f.uri);
    assert.equal(await f.restoreUndoFile(f.uri, missing, Buffer.from('before')), true);
    assert.equal(await readFile(f.path, 'utf8'), 'before');
  } finally {
    await f.cleanup();
  }
});
