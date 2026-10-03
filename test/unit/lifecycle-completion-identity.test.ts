import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { createInitialControllerState } from '../../src/state/types';

for (const mismatch of ['sessionId', 'sessionFile', 'leafId'])
  test(`captured lifecycle completion rejects unexpected ${mismatch} without rollback`, async () => {
    const output = await build({
      entryPoints: ['src/sessions/sessionController.ts'],
      bundle: true,
      write: false,
      platform: 'node',
      format: 'cjs',
      external: ['vscode'],
    });
    const module = { exports: {} as any };
    const require = createRequire(`${process.cwd()}/package.json`);
    new Function('require', 'module', 'exports', output.outputFiles[0]!.text)(
      (id: string) => (id === 'vscode' ? {} : require(id)),
      module,
      module.exports
    );
    const controller = Object.create(module.exports.SessionController.prototype);
    const origin = { sessionId: 'old', sessionFile: '/owned/old.jsonl' };
    const expected = { sessionId: 'new', sessionFile: '/owned/new.jsonl', leafId: 'new-leaf' };
    let switched = false;
    const client = {
      getState: async () =>
        switched
          ? { ...expected, ...(mismatch === 'leafId' ? {} : { [mismatch]: 'unexpected' }) }
          : origin,
      getMessages: async () => ({ messages: [] }),
      getEntries: async () => ({ entries: [], leafId: 'unexpected' }),
      replaceChat: async () => {
        switched = true;
        return { cancelled: false, replacementIdentity: expected };
      },
    };
    controller.supervisor = { currentClient: client, currentGeneration: 1 };
    controller.folder = { uri: { fsPath: '/owned' } };
    controller.state = {
      ...createInitialControllerState('owned', '/owned'),
      connectionState: 'ready',
      state: origin,
      leafId: 'old-leaf',
      messages: [{ role: 'user', content: 'owned outgoing history' }],
      draft: 'owned draft',
    };
    controller.fire = () => {};
    controller.refreshMessages = async () => {};
    controller.refreshEntries = async () => {
      controller.state.leafId = 'unexpected';
    };
    const intent = controller.captureLifecycleIntent();
    await assert.rejects(
      intent.run('new', undefined, intent.valid),
      /replacement (identity|branch)/
    );
    assert.equal(
      controller.snapshot.messages.length,
      1,
      'uncertain completion preserves outgoing history'
    );
    assert.equal(
      controller.snapshot.state.sessionId,
      'old',
      'uncertain completion must not retarget projection'
    );
    assert.equal(controller.snapshot.draft, 'owned draft');
    assert.equal(switched, true, 'native replacement already happened; no fabricated rollback');
    assert.equal(
      controller.snapshot.connectionState,
      'faulted',
      'uncertain native identity cannot accept sends'
    );
  });
