import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInitialControllerState } from '../../src/state/types';
import { createTestDirectory } from '../helpers/temp';

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

test('unpersisted new session does not report a history worker failure', async () => {
  const root = await createTestDirectory('unpersisted-history-');
  try {
    const value = await controller();
    const warnings: string[] = [];
    value.logger.warn = (message: string) => warnings.push(message);
    value.sessionIndex = {
      async readHistory() {
        // Worker transport preserves the message, not the filesystem error code.
        throw new Error('ENOENT: no such file or directory, stat new session');
      },
    };
    assert.equal(await value.readActiveSessionMessages(join(root, 'new.jsonl')), undefined);
    assert.deepEqual(warnings, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('real worker failures still report fallback and local read failures', async () => {
  const root = await createTestDirectory('history-fallback-');
  try {
    const file = join(root, 'existing.jsonl');
    const message = { role: 'assistant', content: 'saved history' };
    await writeFile(file, JSON.stringify({ type: 'message', id: 'a', message }) + '\n');
    const value = await controller();
    const warnings: string[] = [];
    value.logger.warn = (message: string) => warnings.push(message);
    value.sessionIndex = {
      async readHistory() {
        throw new Error('EACCES: permission denied');
      },
    };
    assert.deepEqual(await value.readActiveSessionMessages(file), [message]);
    assert.match(warnings[0]!, /History worker unavailable.*EACCES/);
    warnings.length = 0;
    assert.equal(await value.readActiveSessionMessages(root), undefined);
    assert.ok(warnings.some((warning) => /Could not read local transcript/.test(warning)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
