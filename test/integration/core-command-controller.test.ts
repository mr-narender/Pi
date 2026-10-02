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
