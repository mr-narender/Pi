import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { CORE_SLASH_NAMES, parseCoreSlash } from '../../src/commands/coreSlash';
import { createInitialControllerState } from '../../src/state/types';

// Execute the real controller with ONLY the VS Code module stubbed. No start,
// settings, credentials, native process or provider calls are needed here.
test('core safety: controller blocks every core command in all send modes before client/state effects', async () => {
  const result = await build({
    entryPoints: ['src/sessions/sessionController.ts'],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    external: ['vscode'],
  });
  const require = createRequire(`${process.cwd()}/package.json`);
  const module = { exports: {} as Record<string, any> };
  new Function('require', 'module', 'exports', result.outputFiles[0]!.text)(
    (id: string) => (id === 'vscode' ? {} : require(id)),
    module,
    module.exports
  );
  const Controller = module.exports.SessionController;
  const controllers = [0, 1].map(() => Object.create(Controller.prototype));
  let clientCalls = 0;
  let stateEvents = 0;
  for (const controller of controllers) {
    controller.state = createInitialControllerState('fixture', '/tmp/fixture');
    controller.requireClient = () => {
      clientCalls++;
      throw new Error('Unexpected native call');
    };
    controller.fire = () => {
      stateEvents++;
    };
    controller.selfWriteAt = 123;
  }
  for (const controller of controllers) {
    const before = structuredClone(controller.state);
    for (const name of CORE_SLASH_NAMES) {
      for (const mode of ['prompt', 'steer', 'followUp']) {
        await assert.rejects(
          controller.prompt(` /${name}\targument `, mode, [{ type: 'image', data: 'AAAA' }]),
          /local GUI command/
        );
        assert.deepEqual(controller.state, before);
        assert.equal(controller.selfWriteAt, 123);
      }
    }
  }
  assert.equal(clientCalls, 0);
  assert.equal(stateEvents, 0);
});

test('core safety: exact boundaries and raw arguments match native command families', () => {
  assert.equal(CORE_SLASH_NAMES.length, 27);
  assert.equal(new Set(CORE_SLASH_NAMES).size, 27);
  assert.deepEqual(parseCoreSlash(' /model provider/org/model:high '), {
    name: 'model',
    args: 'provider/org/model:high',
  });
  assert.deepEqual(parseCoreSlash('/export "my file.jsonl"'), {
    name: 'export',
    args: '"my file.jsonl"',
  });
  for (const text of ['/modelish', '/skill:model x', '/extension:model x', '/model/x', '/Model']) {
    assert.equal(parseCoreSlash(text), undefined);
  }
});

test('busy send choices use Pi 1.0.4 atomic prompt streaming behavior without aborting', async () => {
  const result = await build({
    entryPoints: ['src/sessions/sessionController.ts'],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    external: ['vscode'],
  });
  const require = createRequire(`${process.cwd()}/package.json`);
  const module = { exports: {} as Record<string, any> };
  new Function('require', 'module', 'exports', result.outputFiles[0]!.text)(
    (id: string) => (id === 'vscode' ? {} : require(id)),
    module,
    module.exports
  );
  const controller = Object.create(module.exports.SessionController.prototype);
  controller.state = {
    ...createInitialControllerState('fixture', '/tmp/fixture'),
    connectionState: 'busy',
    state: { isStreaming: true },
  };
  const calls: unknown[][] = [];
  let aborts = 0;
  controller.supervisor = {
    currentClient: {
      prompt: async (...args: unknown[]) => calls.push(args),
      steer: async () => assert.fail('legacy steer command must not be used'),
      followUp: async () => assert.fail('legacy follow_up command must not be used'),
      abort: async () => {
        aborts += 1;
      },
    },
  };
  controller.fire = () => {};
  const images = [{ type: 'image', mimeType: 'image/png', data: 'AAAA' }];
  await controller.prompt('guide now', 'steer', images);
  await controller.prompt('then continue', 'followUp', images);
  assert.deepEqual(calls, [
    ['guide now', images, 'steer'],
    ['then continue', images, 'followUp'],
  ]);
  assert.equal(aborts, 0);
});

test('native compaction blocks mutating sends and settings before RPC while abort remains available', async () => {
  const result = await build({
    entryPoints: ['src/sessions/sessionController.ts'],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    external: ['vscode'],
  });
  const require = createRequire(`${process.cwd()}/package.json`);
  const module = { exports: {} as Record<string, any> };
  new Function('require', 'module', 'exports', result.outputFiles[0]!.text)(
    (id: string) => (id === 'vscode' ? {} : require(id)),
    module,
    module.exports
  );
  const controller = Object.create(module.exports.SessionController.prototype);
  controller.state = {
    ...createInitialControllerState('fixture', '/tmp/fixture'),
    connectionState: 'busy',
    state: { isStreaming: false, isCompacting: true },
  };
  const calls: string[] = [];
  controller.supervisor = {
    currentClient: {
      prompt: async () => calls.push('prompt'),
      setModel: async () => calls.push('model'),
      getThinkingCapabilities: async () => calls.push('thinking'),
      savePreference: async () => calls.push('preference'),
      newSession: async () => calls.push('lifecycle'),
      abort: async () => calls.push('abort'),
    },
    stop: async () => calls.push('stop'),
  };
  controller.fire = () => {};

  for (const mode of ['prompt', 'steer', 'followUp'] as const) {
    await assert.rejects(controller.prompt('blocked', mode), /Compaction is in progress/);
  }
  await assert.rejects(controller.selectModel('provider', 'model'), /Compaction is in progress/);
  await assert.rejects(controller.setThinkingLevel('high'), /Compaction is in progress/);
  await assert.rejects(
    controller.savePreference('defaultProvider', 'provider', 'revision', false),
    /Compaction is in progress/
  );
  await assert.rejects(controller.newSession(), /Compaction is in progress/);
  assert.deepEqual(calls, [], 'blocked mutations do not reach native RPC');

  await controller.abort();
  assert.deepEqual(calls, ['abort'], 'Stop remains available during compaction');
  await controller.stop();
  assert.deepEqual(calls, ['abort', 'stop'], 'controller shutdown remains available');

  const disposed: string[] = [];
  const disposable = Object.create(module.exports.SessionController.prototype);
  disposable.state = {
    ...createInitialControllerState('fixture', '/tmp/fixture'),
    state: { isCompacting: true },
  };
  disposable.changeEmitter = { fire: () => {}, dispose: () => disposed.push('change') };
  disposable.extensionUiEmitter = { dispose: () => disposed.push('extension') };
  disposable.disarmSessionFileWatcher = () => {};
  disposable.stop = async () => disposed.push('stop');
  disposable.supervisor = { dispose: () => disposed.push('supervisor') };
  assert.doesNotThrow(() => disposable.dispose());
  assert.deepEqual(disposed, ['stop', 'supervisor', 'change', 'extension']);
});
