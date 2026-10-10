import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import { build } from 'esbuild';
import { createInitialControllerState } from '../../src/state/types';

test('refresh follows newly appended and compacted native leaves instead of cached leaf or model context', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-authoritative-history-'));
  const sessionFile = join(root, 'sessions', 'owned.jsonl');
  await mkdir(join(root, 'sessions'), { recursive: true });
  const records: Array<Record<string, unknown>> = [{ type: 'session', id: 'session', cwd: root }];
  let parentId = 'session';
  for (let index = 0; index < 120; index += 1) {
    const id = `m${index}`;
    records.push({
      type: 'message',
      id,
      parentId,
      message: { id, role: index % 2 ? 'assistant' : 'user', content: `history ${index}` },
    });
    parentId = id;
  }
  records.push({
    type: 'message',
    id: 'user-b',
    parentId,
    message: { id: 'user-b', role: 'user', content: 'new user turn' },
  });
  records.push({
    type: 'message',
    id: 'assistant-c',
    parentId: 'user-b',
    message: { id: 'assistant-c', role: 'assistant', content: 'new assistant turn' },
  });
  records.push({
    type: 'message',
    id: 'abandoned',
    parentId,
    message: { id: 'abandoned', role: 'assistant', content: 'dropped branch' },
  });
  await writeFile(sessionFile, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);

  try {
    const built = await build({
      entryPoints: ['src/sessions/sessionController.ts'],
      bundle: true,
      write: false,
      platform: 'node',
      format: 'cjs',
      external: ['vscode'],
    });
    const require = createRequire(`${process.cwd()}/package.json`);
    const module = { exports: {} as Record<string, any> };
    new Function('require', 'module', 'exports', built.outputFiles[0]!.text)(
      (id: string) => (id === 'vscode' ? {} : require(id)),
      module,
      module.exports
    );
    const controller = Object.create(module.exports.SessionController.prototype);
    controller.state = createInitialControllerState('owned', root);
    controller.state.state.sessionId = 'owned';
    controller.state.state.sessionFile = sessionFile;
    controller.state.leafId = parentId;
    controller.settings = { maxTranscriptItems: 50 };
    let rpcReads = 0;
    let stateReads = 0;
    let activeLeaf = 'assistant-c';
    controller.supervisor = {
      currentGeneration: 7,
      currentClient: {
        getState: async () => {
          stateReads += 1;
          return { sessionId: 'owned', sessionFile, leafId: activeLeaf };
        },
        getMessages: async () => {
          rpcReads += 1;
          return {
            messages: [{ id: 'summary', role: 'assistant', content: 'model-only summary' }],
          };
        },
      },
    };
    controller.fire = () => {};
    const nativeRead = controller.readActiveSessionMessages.bind(controller);
    let reads = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    controller.readActiveSessionMessages = async (...args: unknown[]) => {
      reads += 1;
      await gate;
      return nativeRead(...args);
    };
    const first = controller.refreshMessages();
    const second = controller.refreshMessages();
    await Promise.resolve();
    assert.equal(reads, 1, 'simultaneous refreshes share one session-file scan');
    release();
    await Promise.all([first, second]);
    assert.equal(rpcReads, 0, 'persisted history must win over compacted model context');
    assert.equal(stateReads, 1, 'coalesced refreshes share one authoritative state read');
    assert.equal(controller.state.leafId, 'assistant-c');
    assert.equal(controller.state.state.leafId, 'assistant-c');
    assert.equal(controller.state.messages.length, 122, 'history remains available for UI paging');
    assert.equal(controller.state.messages[0].content, 'history 0');
    assert.equal(controller.state.messages.at(-2).content, 'new user turn');
    assert.equal(controller.state.messages.at(-1).content, 'new assistant turn');
    assert.equal(
      controller.state.messages.some(
        (message: { content?: string }) => message.content === 'dropped branch'
      ),
      false
    );

    records.push({
      type: 'compaction',
      id: 'compact-d',
      parentId: 'assistant-c',
      summary: 'model-only summary',
    });
    await writeFile(sessionFile, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
    activeLeaf = 'compact-d';
    await controller.refreshMessages();
    assert.equal(controller.state.leafId, 'compact-d');
    assert.equal(controller.state.state.leafId, 'compact-d');
    assert.equal(controller.state.messages.at(-1).content, 'new assistant turn');
    assert.equal(
      controller.state.messages.some(
        (message: { content?: string }) => message.content === 'dropped branch'
      ),
      false
    );

    let releaseState!: (value: Record<string, unknown>) => void;
    controller.supervisor.currentClient.getState = () =>
      new Promise((resolve) => {
        releaseState = resolve;
      });
    const before = structuredClone(controller.state.messages);
    const stale = controller.refreshMessages();
    controller.state = {
      ...controller.state,
      state: { ...controller.state.state, sessionId: 'replacement', sessionFile: '/replacement' },
      leafId: 'replacement-leaf',
    };
    releaseState({ sessionId: 'owned', sessionFile, leafId: 'compact-d' });
    await stale;
    assert.deepEqual(controller.state.messages, before, 'stale session refresh cannot overwrite');
    assert.equal(controller.state.leafId, 'replacement-leaf');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
