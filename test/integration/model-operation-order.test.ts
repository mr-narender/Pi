import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { createInitialControllerState } from '../../src/state/types';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test('model operations: supersede catalog, serialize setters, and gate actual controller prompt', async () => {
  const result = await build({
    stdin: {
      contents:
        "export {handleLocalCommand} from './src/commands/localCommand'; export {SessionController} from './src/sessions/sessionController';",
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    external: ['vscode'],
  });
  const module = { exports: {} as Record<string, any> };
  const require = createRequire(`${process.cwd()}/package.json`);
  new Function('require', 'module', 'exports', result.outputFiles[0]!.text)(
    (id: string) => (id === 'vscode' ? {} : require(id)),
    module,
    module.exports
  );
  const { handleLocalCommand, SessionController } = module.exports;
  const models = [
    { provider: 'p', id: 'older' },
    { provider: 'p', id: 'newer' },
  ];
  const catalog = deferred<typeof models>();
  const setter = deferred<void>();
  const refresh = deferred<Record<string, unknown>>();
  const events: string[] = [];
  const controller = Object.create(SessionController.prototype);
  controller.state = createInitialControllerState('fixture', '/tmp/fixture');
  controller.state.state.sessionId = 'origin';
  controller.fire = () => {};
  let calls = 0;
  controller.getAvailableModels = () => (++calls === 1 ? catalog.promise : Promise.resolve(models));
  const client = {
    setModel: async (_p: string, id: string) => {
      events.push(id);
      if (id === 'older') await setter.promise;
    },
    getState: async () => {
      events.push('refresh');
      return refresh.promise;
    },
    prompt: async () => {
      assert.equal(controller.snapshot.state.thinkingLevel, 'high');
      events.push('prompt');
    },
  };
  controller.supervisor = { currentClient: client };
  const run = (id: string) =>
    handleLocalCommand(
      controller,
      { draft: `/model p/${id}` },
      async () => ({ draft: 'new draft' }),
      async () => {
        throw new Error('stale ack');
      },
      async () => {}
    );
  const old = run('older');
  const catalogPrompt = controller.prompt('after pending catalog');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(events, []);
  refresh.resolve({ model: models[1], thinkingLevel: 'high' });
  await run('newer');
  await catalogPrompt;
  catalog.resolve(models);
  await old;
  assert.deepEqual(events, ['newer', 'refresh', 'prompt']);
  events.length = 0;
  const pending = run('older');
  await new Promise((r) => setImmediate(r));
  const newer = run('newer');
  const prompt = controller.prompt('ordinary');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(events, ['older']);
  setter.resolve();
  await Promise.all([pending, newer, prompt]);
  assert.deepEqual(events, ['older', 'refresh', 'newer', 'refresh', 'prompt']);
  controller.getAvailableModels = async () => {
    throw new Error('catalog unavailable');
  };
  await run('older');
  await controller.prompt('after failure');
  assert.equal(events.at(-1), 'prompt');
});
