import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { PassThrough, Writable } from 'node:stream';
import { createNativeFixture, spawnNativeSdkHost } from '../helpers/nativeFixture';
import { RpcClient } from '../../src/rpc/client';
import { RpcTransport } from '../../src/rpc/transport';
import { createInitialControllerState } from '../../src/state/types';

for (const mode of ['shared', 'dedicated'] as const) {
  test(
    `actual compiled controller + current native ${mode}: replacement identity, leaf, transcript, watcher, busy/stale and quit ACK`,
    { timeout: 15000 },
    async () => {
      const fixture = await createNativeFixture('scopes');
      let host: Awaited<ReturnType<typeof spawnNativeSdkHost>> | undefined;
      let transport: RpcTransport | undefined;
      let controller: any;
      try {
        const output = await build({
          entryPoints: ['src/sessions/sessionController.ts'],
          bundle: true,
          write: false,
          platform: 'node',
          format: 'cjs',
          external: ['vscode'],
        });
        const require = createRequire(`${process.cwd()}/package.json`);
        const module = { exports: {} as any };
        new Function('require', 'module', 'exports', output.outputFiles[0]!.text)(
          (id: string) => (id === 'vscode' ? {} : require(id)),
          module,
          module.exports
        );
        host = await spawnNativeSdkHost(fixture, mode, 'engine');
        const responses = new PassThrough();
        let buffer = '';
        let opened!: (reply: any) => void;
        const ready = new Promise<any>((resolve) => {
          opened = resolve;
        });
        host.child.stdout!.on('data', (chunk) => {
          buffer += chunk;
          let i;
          while ((i = buffer.indexOf('\n')) >= 0) {
            const { d } = JSON.parse(buffer.slice(0, i));
            buffer = buffer.slice(i + 1);
            if (d.command === 'open') opened(d);
            else responses.write(JSON.stringify(d) + '\n');
          }
        });
        const input = new Writable({
          write(chunk, _encoding, callback) {
            host!.child.stdin!.write(
              JSON.stringify({ k: 'one', d: JSON.parse(String(chunk)) }) + '\n',
              callback
            );
          },
        });
        transport = new RpcTransport(input, responses, host.child.stderr!, {
          maxRecordBytes: 1000000,
          maxBufferBytes: 1000000,
          maxPendingRequests: 64,
          maxQueuedWrites: 64,
        });
        const client = new RpcClient(1, transport, { shortTimeoutMs: 5000, longTimeoutMs: 5000 });
        host.child.stdin!.write(JSON.stringify({ k: 'one', d: host.open }) + '\n');
        assert.equal((await ready).success, true);
        const file = join(fixture.cwd, 'controller-owned.jsonl');
        const timestamp = '2024-01-01T00:00:00.000Z';
        await writeFile(
          file,
          [
            { type: 'session', version: 3, id: 'controller-owned', timestamp, cwd: fixture.cwd },
            {
              type: 'model_change',
              id: 'model',
              parentId: null,
              timestamp,
              provider: 'fixture-alpha',
              modelId: 'ping',
            },
            {
              type: 'message',
              id: 'user',
              parentId: 'model',
              timestamp,
              message: { role: 'user', content: 'owned prompt', timestamp: 1 },
            },
          ]
            .map((e) => JSON.stringify(e))
            .join('\n') + '\n'
        );
        await client.switchSession(file);
        controller = Object.create(module.exports.SessionController.prototype);
        controller.supervisor = { currentClient: client, currentGeneration: 1 };
        controller.folder = {
          name: 'owned',
          uri: { fsPath: fixture.cwd, toString: () => 'file:///owned' },
        };
        controller.logger = { info: () => {}, warn: () => {} };
        controller.settings = { maxTranscriptItems: 400 };
        controller.changeEmitter = { fire: () => {} };
        controller.state = {
          ...createInitialControllerState('owned', fixture.cwd),
          connectionState: 'ready',
          state: await client.getState(),
        };
        await controller.refreshEntries();
        const originalLeaf = controller.snapshot.leafId;
        const treeIntent = controller.captureEngineIntent();
        const treeResult = await treeIntent.run(
          'tree',
          { targetId: 'user', summarize: false },
          () => true
        );
        assert.equal(treeResult.editorText, 'owned prompt');
        assert.equal(treeIntent.valid(), false);
        assert.equal(treeResult.valid(), true);
        assert.equal(controller.snapshot.leafId, 'model');
        assert.equal(controller.snapshot.messages.length, 0);
        assert.equal(controller.snapshot.state.sessionId, 'controller-owned');
        const restoreTree = controller.captureEngineIntent();
        await restoreTree.run('tree', { targetId: originalLeaf }, () => true);
        const trustIntent = controller.captureEngineIntent();
        const loadedTrust = (await trustIntent.trust()).loaded;
        await trustIntent.run('trust', { decision: true }, () => true);
        assert.equal((await controller.captureEngineIntent().trust()).loaded, loadedTrust);
        await controller.captureEngineIntent().run('trust', { decision: null }, () => true);
        const reloadIntent = controller.captureEngineIntent();
        if (mode === 'dedicated') {
          const history = JSON.stringify(controller.snapshot.entries);
          assert.equal((await reloadIntent.run('reload', {}, () => true)).cancelled, false);
          assert.equal(JSON.stringify(controller.snapshot.entries), history);
        } else
          await assert.rejects(
            reloadIntent.run('reload', {}, () => true),
            /does not support/
          );
        const blockedEngine = controller.captureEngineIntent();
        controller.state.queue.followUp = ['owned queue'];
        await assert.rejects(
          blockedEngine.run('tree', { targetId: 'user' }, () => true),
          /queued work/
        );
        controller.state.queue.followUp = [];
        const first = controller.captureLifecycleIntent();
        const cloned = await first.run('clone', undefined, first.valid);
        assert.equal(cloned.cancelled, false);
        assert.equal(cloned.valid(), true);
        assert.equal(first.valid(), false);
        assert.notEqual(controller.snapshot.state.sessionId, 'controller-owned');
        assert.equal(controller.watchedSessionFile, controller.snapshot.state.sessionFile);
        assert.ok(controller.snapshot.entries.some((e: any) => e.id === 'user'));
        const forkIntent = controller.captureLifecycleIntent();
        const forked = await forkIntent.run('fork', 'user', forkIntent.valid);
        assert.equal(forked.editorText, 'owned prompt');
        assert.ok(!controller.snapshot.entries.some((e: any) => e.id === 'user'));
        const fresh = controller.captureLifecycleIntent();
        await fresh.run('new', undefined, fresh.valid);
        assert.equal(controller.snapshot.messages.length, 0);
        const resume = controller.captureLifecycleIntent();
        await resume.run('resume', file, resume.valid);
        assert.equal(controller.snapshot.state.sessionId, 'controller-owned');
        const stale = controller.captureLifecycleIntent();
        controller.supervisor.currentGeneration++;
        await assert.rejects(stale.run('new', undefined, stale.valid), /changed/);
        controller.supervisor.currentGeneration--;
        controller.state.queue.followUp = ['owned queued'];
        const busy = controller.captureLifecycleIntent();
        await assert.rejects(busy.run('clone', undefined, busy.valid), /queued work/);
        controller.state.queue.followUp = [];
        const quit = controller.captureLifecycleIntent();
        assert.equal((await quit.run('quit', undefined, quit.valid)).cancelled, false);
        assert.equal(fixture.requests, 0);
      } finally {
        controller?.disarmSessionFileWatcher();
        transport?.disconnect(new Error('owned shutdown'));
        if (host && host.child.exitCode === null && host.child.signalCode === null) {
          const exit = new Promise((resolve) => host!.child.once('exit', resolve));
          host.child.kill('SIGKILL');
          await exit;
        }
        await fixture.dispose();
      }
    }
  );
}
