import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import { build } from 'esbuild';
import { createInitialControllerState } from '../../src/state/types';

const compiled = build({
  entryPoints: ['src/sessions/sessionController.ts'],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
  external: ['vscode'],
});

async function Controller(): Promise<any> {
  const require = createRequire(`${process.cwd()}/package.json`);
  const module = { exports: {} as Record<string, any> };
  new Function('require', 'module', 'exports', (await compiled).outputFiles[0]!.text)(
    (id: string) => (id === 'vscode' ? {} : require(id)),
    module,
    module.exports
  );
  return module.exports.SessionController;
}

function controllerState(sessionFile: string, leafId: string) {
  return {
    ...createInitialControllerState('owned', '/workspace'),
    connectionState: 'ready' as const,
    state: { sessionId: 'owned', sessionFile, leafId, isIdle: true },
    leafId,
  };
}

test('pending same-session refresh cannot overwrite a completed tree navigation', async () => {
  const SessionController = await Controller();
  const controller = Object.create(SessionController.prototype);
  const sessionFile = '/workspace/session.jsonl';
  let nativeLeaf = 'old-leaf';
  const client = {
    getState: async () => ({
      sessionId: 'owned',
      sessionFile,
      leafId: nativeLeaf,
      isIdle: true,
    }),
    engineCommand: async () => {
      nativeLeaf = 'new-leaf';
      return { leafId: nativeLeaf };
    },
    getEntries: async () => ({ entries: [{ id: nativeLeaf }], leafId: nativeLeaf }),
    getMessages: async () => assert.fail('persisted branch is available'),
  };
  controller.supervisor = { currentClient: client, currentGeneration: 1 };
  controller.state = controllerState(sessionFile, 'old-leaf');
  controller.settings = { maxTranscriptItems: 1 };
  controller.fire = () => {};
  controller.syncFileReadOffset = async () => {};

  let releaseOld!: () => void;
  let oldReadStarted!: () => void;
  const oldStarted = new Promise<void>((resolve) => {
    oldReadStarted = resolve;
  });
  const oldGate = new Promise<void>((resolve) => {
    releaseOld = resolve;
  });
  let reads = 0;
  controller.readActiveSessionMessages = async (_file: string, leafId: string) => {
    reads += 1;
    if (reads === 1) {
      assert.equal(leafId, 'old-leaf');
      oldReadStarted();
      await oldGate;
      return [{ role: 'assistant', content: 'stale branch' }];
    }
    assert.equal(leafId, 'new-leaf');
    return [{ role: 'assistant', content: 'navigated branch' }];
  };

  const staleRefresh = controller.refreshMessages();
  await oldStarted;
  const intent = controller.captureEngineIntent();
  await intent.run('tree', { targetId: 'new-leaf' }, () => true);
  releaseOld();
  await staleRefresh;

  assert.equal(controller.state.leafId, 'new-leaf');
  assert.deepEqual(controller.state.messages, [{ role: 'assistant', content: 'navigated branch' }]);
});

test('tree completion reconstructs the full persisted compacted branch without get_messages', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-tree-history-'));
  const sessionFile = join(root, 'sessions', 'owned.jsonl');
  await mkdir(join(root, 'sessions'), { recursive: true });
  const records: Array<Record<string, unknown>> = [{ type: 'session', id: 'owned', cwd: root }];
  let parentId: string | null = null;
  for (let index = 0; index < 80; index += 1) {
    const id = `m${index}`;
    records.push({
      type: 'message',
      id,
      parentId,
      message: { id, role: index % 2 ? 'assistant' : 'user', content: `history ${index}` },
    });
    parentId = id;
  }
  records.push({ type: 'compaction', id: 'compact', parentId, summary: 'model context only' });
  records.push({
    type: 'message',
    id: 'newest-dropped',
    parentId: 'm78',
    message: { role: 'assistant', content: 'dropped branch' },
  });
  await writeFile(sessionFile, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);

  try {
    const SessionController = await Controller();
    const controller = Object.create(SessionController.prototype);
    let nativeLeaf = 'm79';
    let messageReads = 0;
    const client = {
      getState: async () => ({
        sessionId: 'owned',
        sessionFile,
        leafId: nativeLeaf,
        isIdle: true,
      }),
      engineCommand: async () => {
        nativeLeaf = 'compact';
        return { leafId: nativeLeaf };
      },
      getEntries: async () => ({ entries: [{ id: nativeLeaf }], leafId: nativeLeaf }),
      getMessages: async () => {
        messageReads += 1;
        return { messages: [{ role: 'assistant', content: 'model context only' }] };
      },
    };
    controller.supervisor = { currentClient: client, currentGeneration: 1 };
    controller.state = controllerState(sessionFile, 'm79');
    controller.settings = { maxTranscriptItems: 5 };
    controller.logger = { warn: () => {} };
    controller.fire = () => {};

    const intent = controller.captureEngineIntent();
    await intent.run('tree', { targetId: 'compact' }, () => true);

    assert.equal(messageReads, 0);
    assert.equal(controller.state.leafId, 'compact');
    assert.equal(controller.state.messages.length, 80);
    assert.equal(controller.state.messages[0].content, 'history 0');
    assert.equal(controller.state.messages.at(-1).content, 'history 79');
    assert.equal(
      controller.state.messages.some(
        (message: { content?: string }) => message.content === 'dropped branch'
      ),
      false
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
