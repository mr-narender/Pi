import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { createInitialControllerState } from '../../src/state/types';

const compiled = build({
  entryPoints: ['src/sessions/sessionController.ts'],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
  external: ['vscode'],
});
async function controller() {
  const require = createRequire(`${process.cwd()}/package.json`);
  const module = { exports: {} as Record<string, any> };
  new Function('require', 'module', 'exports', (await compiled).outputFiles[0]!.text)(
    (id: string) => (id === 'vscode' ? {} : require(id)),
    module,
    module.exports
  );
  const result = Object.create(module.exports.SessionController.prototype);
  result.logger = { warn() {}, info() {} };
  return result;
}

test('controller reads authoritative history through worker with explicit null leaf', async () => {
  const value = await controller();
  const messages = [{ role: 'assistant', content: 'worker history' }];
  value.sessionIndex = {
    async readHistory(file: string, leaf: unknown) {
      assert.equal(file, '/remote/session');
      assert.equal(leaf, null);
      return messages;
    },
  };
  assert.equal(await value.readActiveSessionMessages('/remote/session', null), messages);
});

test('history worker timeout never falls back inline or presents an empty ready chat', async () => {
  const value = await controller();
  const timeout = Object.assign(new Error('history worker timed out'), {
    name: 'SessionIndexTimeoutError',
  });
  value.sessionIndex = {
    async readHistory() {
      throw timeout;
    },
  };
  await assert.rejects(value.readActiveSessionMessages('/does-not-exist'), {
    name: 'SessionIndexTimeoutError',
  });
  value.state = {
    ...createInitialControllerState('owned', '/workspace'),
    connectionState: 'ready',
    switchingSession: true,
  };
  value.supervisor = {
    currentClient: {
      async getState() {
        return { sessionFile: '/remote/session', leafId: 'a' };
      },
      async getCommands() {
        return {};
      },
      async getSessionStats() {
        return {};
      },
    },
  };
  value.captureLocalCommandOrigin = () => () => true;
  value.addDiagnostic = () => {};
  value.fire = () => {};
  await assert.rejects(value.reconcile(), { name: 'SessionIndexTimeoutError' });
  assert.equal(value.state.connectionState, 'faulted');
  assert.equal(value.state.switchingSession, false);
});
