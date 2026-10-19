import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';

async function fixture(open = true) {
  const built = await build({
    stdin: {
      contents:
        "export {SessionController} from './src/sessions/sessionController';export {ExtensionUiBroker} from './src/ui/extensionUiBroker';export {createInitialControllerState} from './src/state/types';",
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    external: ['vscode'],
  });
  const require = createRequire(process.cwd() + '/package.json'),
    module = { exports: {} as any };
  const choices: string[] = [],
    writes: string[] = [],
    responses: any[] = [],
    listeners: Array<(request: any) => void> = [],
    changes: Array<() => void> = [];
  new Function('require', 'module', 'exports', built.outputFiles[0]!.text)(
    (name: string) =>
      name === 'vscode'
        ? {
            workspace: { isTrusted: true },
            window: {
              showQuickPick: async () => {
                choices.push('shown');
                return 'Cancel';
              },
            },
          }
        : require(name),
    module,
    module.exports
  );
  const controller = Object.create(module.exports.SessionController.prototype);
  let emissions = 0;
  const client = {
    respondExtensionUi: async (response: any) => {
      responses.push(response);
    },
  };
  Object.assign(controller, {
    state: module.exports.createInitialControllerState('owned', '/owned'),
    supervisor: { currentClient: client, currentGeneration: 1 },
    navigationEpoch: 1,
    authDisposed: false,
    lastLoggedConnectionState: 'ready',
    logger: { info() {} },
    changeEmitter: {
      event: (listener: () => void) => {
        changes.push(listener);
        return {
          dispose() {
            changes.splice(changes.indexOf(listener), 1);
          },
        };
      },
      fire: () => {
        for (const listener of [...changes]) listener();
      },
    },
    extensionUiEmitter: {
      event: (listener: (request: any) => void) => {
        listeners.push(listener);
        return {
          dispose() {
            listeners.splice(listeners.indexOf(listener), 1);
          },
        };
      },
      fire: (request: any) => {
        emissions++;
        for (const listener of [...listeners]) listener(request);
      },
    },
  });
  controller.state.state = { sessionId: 'owned', sessionFile: '/owned/session.jsonl' };
  controller.state.connectionState = 'ready';
  const broker = new module.exports.ExtensionUiBroker(
    { list: () => [controller] },
    {
      updateDraft: async (_c: any, text: string) => {
        writes.push(text);
      },
    },
    () => open,
    () => true,
    () => {}
  );
  return {
    controller,
    client,
    broker,
    choices,
    writes,
    responses,
    get emissions() {
      return emissions;
    },
  };
}
test('connected inline request is admitted once; repeated native id cannot re-emit it', async (t) => {
  const f = await fixture();
  t.after(() => f.broker.dispose());
  const request = {
    type: 'extension_ui_request',
    method: 'confirm',
    id: 'confirm',
    title: 'A fake confirmation',
  };
  f.controller.onExtensionUi(request, f.client);
  assert.equal(f.emissions, 1, 'broker must consume the controller event without re-admission');
  assert.equal(f.controller.snapshot.pendingUi.length, 1);
  assert.equal(typeof f.controller.snapshot.pendingUi[0].requestKey, 'string');
  f.controller.onExtensionUi(request, f.client);
  assert.equal(f.emissions, 1);
});
test('extension draft proposal never replaces unsent text before a choice', async (t) => {
  const f = await fixture();
  t.after(() => f.broker.dispose());
  f.controller.state.draft = 'Keep this unsent draft';
  f.controller.onExtensionUi(
    {
      type: 'extension_ui_request',
      method: 'set_editor_text',
      id: 'proposal',
      text: 'Extension suggestion',
    },
    f.client
  );
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(f.controller.snapshot.draft, 'Keep this unsent draft');
  assert.deepEqual(f.writes, []);
  assert.equal(f.controller.snapshot.pendingUi[0].text, 'Extension suggestion');
});
test('late UI from an obsolete client is ignored', async (t) => {
  const f = await fixture();
  t.after(() => f.broker.dispose());
  f.controller.onExtensionUi(
    { type: 'extension_ui_request', method: 'confirm', id: 'late', title: 'Old client' },
    {}
  );
  assert.equal(f.emissions, 0);
  assert.equal(f.controller.snapshot.pendingUi.length, 0);
});
test('native cancellation retires an uncertain response without retrying it', async (t) => {
  const f = await fixture();
  t.after(() => f.broker.dispose());
  f.client.respondExtensionUi = async (response: any) => {
    f.responses.push(response);
    throw new Error('owned write failure');
  };
  f.controller.onExtensionUi(
    { type: 'extension_ui_request', method: 'input', id: 'input', title: 'Owned input' },
    f.client
  );
  const key = f.controller.snapshot.pendingUi[0].requestKey;
  await f.controller.respondExtensionUi({ id: 'input', value: 'Owned answer' }, key);
  assert.equal(f.controller.snapshot.pendingUi[0].responseState, 'unknown');
  await f.controller.respondExtensionUi({ id: 'input', value: 'Duplicate' }, key);
  assert.equal(f.responses.length, 1);
  f.controller.onExtensionUi(
    {
      type: 'extension_ui_request',
      method: 'cancel',
      id: 'cancel',
      requestId: 'input',
      reason: 'aborted',
    },
    f.client
  );
  assert.deepEqual(f.controller.snapshot.pendingUi, []);
  assert.equal(f.responses.length, 1);
});
test('navigation invalidates a native callback and its old response key', async (t) => {
  const f = await fixture();
  t.after(() => f.broker.dispose());
  f.controller.onExtensionUi(
    { type: 'extension_ui_request', method: 'confirm', id: 'dialog', title: 'Owned confirm' },
    f.client
  );
  const key = f.controller.snapshot.pendingUi[0].requestKey;
  f.controller.navigationEpoch++;
  f.controller.fire();
  await f.controller.respondExtensionUi({ id: 'dialog', confirmed: true }, key);
  assert.deepEqual(f.controller.snapshot.pendingUi, []);
  assert.deepEqual(f.responses, []);
});
