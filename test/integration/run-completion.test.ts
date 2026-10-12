import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { createInitialControllerState } from '../../src/state/types';
import { reduceEvent } from '../../src/state/reducer';

async function classes(notifications: unknown[] = []) {
  const compiled = await build({
    stdin: {
      contents:
        "export { SessionController } from './src/sessions/sessionController'; export { ChatTabManager } from './src/editorTabs/tabManager';",
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    external: ['vscode'],
    plugins: [
      {
        name: 'owned-notifications',
        setup(builder) {
          builder.onResolve({ filter: /(^|\/)notifier$/ }, () => ({
            path: 'owned-notifier',
            external: true,
          }));
        },
      },
    ],
  });
  const require = createRequire(`${process.cwd()}/package.json`);
  const vscode = {
    workspace: { getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }) },
    window: { state: { focused: false } },
  };
  const module = { exports: {} as any };
  new Function('require', 'module', 'exports', compiled.outputFiles[0]!.text)(
    (id: string) =>
      id === 'vscode'
        ? vscode
        : id === 'owned-notifier'
          ? { notifier: { notify: (value: unknown) => notifications.push(value) } }
          : require(id),
    module,
    module.exports
  );
  return module.exports;
}

test('only successfully settled runs trigger completion review and notifications', async () => {
  const notices: unknown[] = [];
  const { ChatTabManager } = await classes(notices);
  const manager = Object.create(ChatTabManager.prototype);
  const reviews: string[] = [];
  Object.assign(manager, {
    lastRunOutcome: new WeakMap(),
    busySince: new WeakMap(),
    sessions: { ownerOf: () => undefined },
    hosts: new Map(),
    turnReview: {
      onTurnStart() {
        reviews.push('start');
      },
      onTurnEnd() {
        reviews.push('complete');
      },
    },
  });
  for (const outcome of ['aborted', 'failed', 'completed'] as const) {
    let state = createInitialControllerState('owned', '/owned');
    const controller = {
      folder: { uri: { fsPath: '/owned' } },
      get snapshot() {
        return state;
      },
    };
    const update = (event: any) => {
      state = reduceEvent(state, event);
      manager.detectTurnCompletion(controller);
    };
    update({ type: 'agent_start' });
    manager.busySince.set(controller, Date.now() - 5000);
    if (outcome === 'failed')
      update({ type: 'message_end', message: { role: 'assistant', stopReason: 'error' } });
    update({ type: 'agent_end', messages: [], willRetry: false });
    assert.equal(reviews.filter((value) => value === 'complete').length, 0);
    update({ type: 'agent_settled', aborted: outcome === 'aborted' });
    update({ type: 'compaction_start' });
    update({ type: 'compaction_end' });
  }
  assert.equal(reviews.filter((value) => value === 'complete').length, 1);
  assert.equal(notices.length, 1);
});

test('aborted/failed settled events do not schedule extension auto-compaction or Continue', async () => {
  const { SessionController } = await classes();
  for (const outcome of ['aborted', 'failed']) {
    const controller = Object.create(SessionController.prototype);
    controller.state = {
      ...createInitialControllerState('owned', '/owned'),
      connectionState: 'busy',
      runOutcome: outcome === 'failed' ? 'failed' : 'running',
    };
    controller.fire = () => {};
    controller.refreshMessages = async () => {};
    let compactions = 0;
    controller.maybeAutoCompact = async () => {
      compactions++;
    };
    controller.onEvent({ type: 'agent_settled', aborted: outcome === 'aborted' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(compactions, 0);
  }
});

for (const phase of ['stats', 'compact'] as const) {
  for (const action of ['abort', 'new prompt'] as const) {
    test(`${action} during auto-compaction ${phase} prevents a stale Continue`, async () => {
      const { SessionController } = await classes();
      const controller = Object.create(SessionController.prototype);
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const prompts: string[] = [];
      let compactions = 0;
      const client = {
        async getSessionStats() {
          if (phase === 'stats') {
            entered();
            await gate;
          }
          return { contextUsage: { percent: 90 } };
        },
        async abort() {},
        async prompt(message: string) {
          prompts.push(message);
        },
      };
      Object.assign(controller, {
        state: {
          ...createInitialControllerState('owned', '/owned'),
          connectionState: 'ready',
          runOutcome: 'completed',
        },
        supervisor: { currentClient: client, currentGeneration: 1 },
        logger: { info() {} },
        fire() {},
        async compact() {
          compactions++;
          if (phase === 'compact') {
            entered();
            await gate;
          }
        },
        async refreshState() {},
        async refreshMessages() {},
      });
      const pending = controller.maybeAutoCompact();
      await started;
      if (action === 'abort') await controller.abort();
      else await controller.prompt('owned new task');
      release();
      await pending;
      assert.ok(!prompts.includes('Continue.'));
      assert.equal(compactions, phase === 'stats' ? 0 : 1);
      assert.deepEqual(prompts, action === 'abort' ? [] : ['owned new task']);
    });
  }
}

for (const disposition of ['handled', 'rejected', 'queued', 'started-before-handled'] as const) {
  test(`prompt ${disposition} preserves truthful state without fake completion`, async () => {
    const notices: unknown[] = [];
    const { SessionController, ChatTabManager } = await classes(notices);
    const controller = Object.create(SessionController.prototype);
    const manager = Object.create(ChatTabManager.prototype);
    let reviews = 0;
    Object.assign(manager, {
      lastRunOutcome: new WeakMap(),
      busySince: new WeakMap(),
      sessions: { ownerOf: () => undefined },
      hosts: new Map(),
      turnReview: {
        onTurnStart() {},
        onTurnEnd() {
          reviews++;
        },
      },
    });
    manager.lastRunOutcome.set(controller, 'completed');
    const client = {
      async prompt() {
        if (disposition === 'rejected') throw new Error('owned preflight rejection');
        if (disposition === 'started-before-handled') controller.onEvent({ type: 'agent_start' });
        return { disposition: disposition === 'queued' ? 'queued' : 'handled' };
      },
    };
    Object.assign(controller, {
      state: {
        ...createInitialControllerState('owned', '/owned'),
        connectionState: 'ready',
        runOutcome: 'completed',
        draft: 'owned draft',
        state: { isStreaming: false },
      },
      supervisor: { currentClient: client, currentGeneration: 1 },
      logger: { info() {} },
      fire() {
        manager.detectTurnCompletion(controller);
      },
    });
    if (disposition === 'rejected')
      await assert.rejects(controller.prompt('owned input'), /preflight rejection/);
    else await controller.prompt('owned input');
    const noRun = disposition === 'handled' || disposition === 'rejected';
    assert.equal(controller.state.connectionState, noRun ? 'ready' : 'busy');
    assert.equal(
      controller.state.runOutcome,
      disposition === 'started-before-handled' ? 'running' : undefined
    );
    assert.equal(controller.state.draft, 'owned draft');
    assert.equal(reviews, 0);
    assert.equal(notices.length, 0);
  });
}

test('handled prompt during another active run retains that run and its steering availability', async () => {
  const { SessionController } = await classes();
  const controller = Object.create(SessionController.prototype);
  Object.assign(controller, {
    state: {
      ...createInitialControllerState('owned', '/owned'),
      connectionState: 'busy',
      runOutcome: 'running',
      state: { isStreaming: true },
    },
    supervisor: {
      currentClient: {
        async prompt() {
          return { disposition: 'handled' };
        },
      },
      currentGeneration: 1,
    },
    fire() {},
  });
  await controller.prompt('owned intercepted steering', 'steer');
  assert.equal(controller.state.connectionState, 'busy');
  assert.equal(controller.state.runOutcome, 'running');
  assert.equal(controller.state.state.isStreaming, true);
});
