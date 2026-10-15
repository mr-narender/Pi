import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { build } from 'esbuild';
import { createInitialControllerState } from '../../src/state/types';
import { createEmptyComposerState } from '../../src/webview/composer';
import { createWebviewSnapshot } from '../../src/webview/model';
import { renderChatApp } from '../../src/webview/render';

test('stock Pi 1.2.0 completion without a leaf identity retains persisted user and provider error', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-native-rpc-history-'));
  const sessionFile = join(root, 'session.jsonl');
  const user = { role: 'user', timestamp: 1, content: [{ type: 'text', text: 'show my result' }] };
  const assistant = {
    role: 'assistant',
    timestamp: 2,
    content: [],
    stopReason: 'error',
    errorMessage: 'Provider request failed: HTTP 520',
  };
  await writeFile(
    sessionFile,
    [
      { type: 'session', id: 'session', cwd: root },
      { type: 'message', id: 'u', parentId: null, message: user },
      { type: 'message', id: 'a', parentId: 'u', message: assistant },
    ]
      .map((record) => JSON.stringify(record))
      .join('\n') + '\n'
  );
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
    controller.state = createInitialControllerState('remote', root);
    controller.state.state = { sessionId: 'session', sessionFile };
    controller.state.messages = [user];
    controller.logger = { warn() {} };
    controller.fire = () => {};
    let leaf: undefined | null | string;
    let rpcReads = 0;
    controller.supervisor = {
      currentGeneration: 1,
      currentClient: {
        // Stock rpc-mode get_state omits leafId; the SDK host adds it.
        getState: async () => ({
          sessionId: 'session',
          sessionFile,
          ...(leaf === undefined ? {} : { leafId: leaf }),
          isStreaming: false,
        }),
        getMessages: async () => {
          rpcReads++;
          return { messages: [user, assistant] };
        },
      },
    };
    controller.onEvent({ type: 'message_end', message: assistant });
    controller.onEvent({ type: 'agent_settled' });
    await controller.refreshMessages();
    assert.deepEqual(controller.state.messages, [user, assistant]);
    assert.equal(controller.state.runOutcome, 'failed');
    assert.equal(controller.state.connectionState, 'ready');
    assert.equal(rpcReads, 0, 'persisted display history wins over model context');
    const snapshot = createWebviewSnapshot(controller.state, 1, {
      composer: createEmptyComposerState(),
      isTrusted: true,
      folders: [],
    });
    const html = renderChatApp(snapshot);
    assert.match(html, /show my result/);
    assert.match(html, /HTTP 520/);
    assert.doesNotMatch(html, /class="empty-state"/);
    leaf = 'a';
    await controller.refreshMessages();
    assert.deepEqual(
      controller.state.messages,
      [user, assistant],
      'SDK leaf selection remains authoritative'
    );
    leaf = null;
    await controller.refreshMessages();
    assert.deepEqual(controller.state.messages, [], 'explicit root selection remains empty');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
