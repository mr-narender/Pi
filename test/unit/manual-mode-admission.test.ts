import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { createInitialControllerState } from '../../src/state/types';

async function fixture() {
  const code = await build({
    stdin: {
      contents:
        "export { SessionController } from './src/sessions/sessionController'; export { syncApprovalGateForWorkspace } from './src/review/approvalGate'; export { beginModelOperation } from './src/commands/modelOperations';",
      resolveDir: process.cwd(),
      loader: 'ts',
    },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    external: ['vscode'],
  });
  let write: () => Promise<void> = async () => {};
  const uri = (fsPath: string) => ({ fsPath, scheme: 'file' });
  const vscode = {
    window: { showWarningMessage: async () => {} },
    Uri: {
      joinPath: (base: { fsPath: string }, ...parts: string[]) => uri(join(base.fsPath, ...parts)),
    },
    workspace: {
      isTrusted: true,
      workspaceFolders: [{ uri: uri('/project') }],
      fs: {
        createDirectory: async () => {},
        readFile: async () => Buffer.from('{}'),
        writeFile: () => write(),
        rename: async () => {},
      },
    },
  };
  const nativeRequire = createRequire(`${process.cwd()}/package.json`);
  const module = { exports: {} as any };
  new Function('require', 'module', 'exports', code.outputFiles[0]!.text)(
    (name: string) => (name === 'vscode' ? vscode : nativeRequire(name)),
    module,
    module.exports
  );
  const owner = Object.create(module.exports.SessionController.prototype);
  owner.state = createInitialControllerState('project', '/project');
  owner.state.connectionState = 'ready';
  owner.state.state = { sessionId: 'session', sessionFile: '/session.jsonl' };
  owner.settings = { additionalArgs: [], offline: false };
  owner.logger = { warn() {}, error() {} };
  owner.folder = { name: 'project', uri: uri('/project') };
  owner.changeEmitter = { fire() {}, dispose() {} };
  owner.extensionUiEmitter = { dispose() {} };
  const calls: unknown[][] = [];
  owner.supervisor = {
    currentGeneration: 1,
    currentClient: {
      prompt: async (...args: unknown[]) => {
        calls.push(args);
        return { disposition: 'started' };
      },
      getCapabilities: async () => {
        calls.push(['capabilities']);
        return { engineCommands: { outbox_prompt: true } };
      },
      getState: async () => {
        calls.push(['state']);
        return { ...owner.state.state, isIdle: true };
      },
    },
    stop: async () => {
      calls.push(['stop']);
    },
    dispose: () => {
      calls.push(['dispose']);
    },
  };
  owner.launchOnce = async () => {
    calls.push(['launch']);
    owner.state.connectionState = 'ready';
  };
  owner.fire = () => {};
  return {
    owner,
    calls,
    sync: (enabled = true) =>
      module.exports.syncApprovalGateForWorkspace(uri('/extension'), enabled),
    setWrite: (value: typeof write) => {
      write = value;
    },
    beginModelOperation: () => module.exports.beginModelOperation(owner),
  };
}

const options = {
  outbox: { sessionId: 'session', sessionFile: '/session.jsonl', requireIdle: true },
};

test('failed Manual Mode sync blocks every prompt mode before native work and successful sync resumes', async () => {
  const f = await fixture();
  f.setWrite(async () => {
    throw new Error('policy storage unavailable');
  });
  await assert.rejects(f.sync(), /policy storage unavailable/);
  for (const mode of ['prompt', 'steer', 'followUp']) {
    await assert.rejects(f.owner.prompt('Unsent draft', mode), /policy storage unavailable/);
  }
  await assert.rejects(
    f.owner.prompt('Queued draft', 'prompt', [], options),
    (error: any) =>
      error.outboxNotDispatched === true && /policy storage unavailable/.test(error.message)
  );
  assert.equal(f.calls.length, 0);
  assert.equal(f.owner.state.connectionState, 'ready');
  f.setWrite(async () => {});
  await f.sync();
  await f.owner.prompt('Retry draft');
  assert.equal(f.calls.length, 1);
});

test('prompt waits for policy sync and navigation during the wait never sends into a replacement chat', async () => {
  const f = await fixture();
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.setWrite(() => waiting);
  const sync = f.sync();
  const prompt = f.owner.prompt('pending');
  const rejected = assert.rejects(prompt, /originating chat changed/i);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.calls.length, 0);
  f.owner.navigationEpoch = 1;
  release();
  await sync;
  await rejected;
  assert.equal(f.calls.length, 0);
});

test('policy failure during model preflight or prior SDK admission blocks subsequent native prompts', async () => {
  const f = await fixture();
  const model = f.beginModelOperation();
  const prompt = f.owner.prompt('after model');
  const rejected = assert.rejects(prompt, /policy storage unavailable/);
  await new Promise((resolve) => setImmediate(resolve));
  f.setWrite(async () => {
    throw new Error('policy storage unavailable');
  });
  await assert.rejects(f.sync(), /policy storage unavailable/);
  model.finish();
  await rejected;
  assert.equal(f.calls.length, 0);

  f.setWrite(async () => {});
  await f.sync();
  f.owner.state.state.sdkVersion = '1.3.0';
  f.owner.supervisor.sdkRoot = '/selected/sdk';
  let release!: () => void;
  f.owner.supervisor.currentClient.prompt = async () => {
    f.calls.push(['prompt']);
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return { disposition: 'started' };
  };
  const first = f.owner.prompt('first');
  const second = f.owner.prompt('second');
  const secondRejected = assert.rejects(second, /policy storage unavailable/);
  await new Promise((resolve) => setImmediate(resolve));
  f.setWrite(async () => {
    throw new Error('policy storage unavailable');
  });
  await assert.rejects(f.sync(), /policy storage unavailable/);
  release();
  await first;
  await secondRejected;
  assert.equal(f.calls.length, 1);
});

test('policy sync started by busy-state observers cannot race the native send', async () => {
  const f = await fixture();
  let failure: Promise<void> | undefined;
  f.setWrite(async () => {
    throw new Error('policy storage unavailable');
  });
  f.owner.fire = () => {
    if (f.owner.state.connectionState === 'busy' && !failure) {
      failure = assert.rejects(f.sync(), /policy storage unavailable/);
    }
  };
  await assert.rejects(f.owner.prompt('pending'), /policy storage unavailable/);
  await failure;
  assert.equal(f.calls.length, 0);
  assert.equal(f.owner.state.connectionState, 'ready');
});

test('Abort during policy preflight cancels pending and SDK-queued prompts without discarding drafts', async () => {
  const f = await fixture();
  f.owner.supervisor.sdkRoot = '/selected/sdk';
  f.owner.state.draft = 'Keep my draft';
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.setWrite(() => waiting);
  f.owner.supervisor.currentClient.abort = async () => {
    f.calls.push(['abort']);
  };
  const sync = f.sync();
  const first = f.owner.prompt('queued draft', 'prompt', [], options);
  const second = f.owner.prompt('steer draft', 'steer');
  const firstRejected = assert.rejects(
    first,
    (error: any) =>
      error.outboxNotDispatched === true && /originating chat changed/i.test(error.message)
  );
  const secondRejected = assert.rejects(second, /originating chat changed/i);
  await new Promise((resolve) => setImmediate(resolve));
  await f.owner.abort();
  release();
  await sync;
  await Promise.all([firstRejected, secondRejected]);
  assert.deepEqual(f.calls, [['abort']]);
  assert.equal(f.owner.state.draft, 'Keep my draft');
  await f.owner.prompt('new explicit send after Stop');
  assert.equal(f.calls.length, 2);
});

test('Abort during the final policy wait prevents native dispatch and preserves outbox ownership', async () => {
  const f = await fixture();
  f.owner.state.draft = 'Keep this draft too';
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.setWrite(() => waiting);
  f.owner.supervisor.currentClient.abort = async () => {
    f.calls.push(['abort']);
  };
  let sync: Promise<void> | undefined;
  f.owner.fire = () => {
    if (f.owner.state.connectionState === 'busy' && !sync) sync = f.sync();
  };
  const prompt = f.owner.prompt('queued draft', 'prompt', [], options);
  const rejected = assert.rejects(
    prompt,
    (error: any) =>
      error.outboxNotDispatched === true && /originating chat changed/i.test(error.message)
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(sync, 'observer started a policy sync at final admission');
  await f.owner.abort();
  release();
  await sync;
  await rejected;
  assert.deepEqual(f.calls, [['capabilities'], ['state'], ['abort']]);
  assert.equal(f.owner.state.draft, 'Keep this draft too');
  assert.equal(f.owner.state.runOutcome, 'aborted');
  assert.equal(f.owner.state.connectionState, 'ready');
  assert.equal(f.owner.state.state.isStreaming, false);
  await f.owner.prompt('explicit fresh send');
  assert.equal(f.calls.length, 4);
});

test('cancelled optimistic admission preserves existing native work, events, navigation and newer sends', async () => {
  for (const newer of ['already-busy', 'event', 'navigation', 'send']) {
    const f = await fixture();
    if (newer === 'already-busy') {
      f.owner.state.connectionState = 'busy';
      f.owner.state.state.isStreaming = true;
    }
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.setWrite(() => waiting);
    f.owner.supervisor.currentClient.abort = async () => {
      f.calls.push(['abort']);
    };
    let sync: Promise<void> | undefined;
    f.owner.fire = () => {
      if (f.owner.state.connectionState === 'busy' && !sync) sync = f.sync();
    };
    const pending = f.owner.prompt('old draft');
    const rejected = assert.rejects(pending, /originating chat changed/i);
    await new Promise((resolve) => setImmediate(resolve));
    await f.owner.abort();
    let fresh: Promise<void> | undefined;
    if (newer === 'event') f.owner.onEvent({ type: 'agent_start' });
    if (newer === 'navigation') {
      f.owner.navigationEpoch = 1;
      f.owner.state = {
        ...f.owner.state,
        connectionState: 'ready',
        state: { ...f.owner.state.state, isStreaming: false },
      };
    }
    if (newer === 'send') fresh = f.owner.prompt('new explicit send');
    release();
    await sync;
    await rejected;
    await fresh;
    assert.equal(f.owner.state.connectionState, newer === 'navigation' ? 'ready' : 'busy', newer);
    assert.equal(f.owner.state.state.isStreaming, newer !== 'navigation', newer);
    if (newer === 'event') assert.notEqual(f.owner.state.runOutcome, 'aborted');
    if (newer === 'send') assert.equal(f.calls.length, 2, 'only the fresh send dispatches');
  }
});

test('repeated Stop during the final policy wait clears only the unsent optimistic busy state', async () => {
  const f = await fixture();
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.setWrite(() => waiting);
  f.owner.supervisor.currentClient.abort = async () => {
    f.calls.push(['abort']);
  };
  let sync: Promise<void> | undefined;
  f.owner.fire = () => {
    if (f.owner.state.connectionState === 'busy' && !sync) sync = f.sync();
  };
  const prompt = f.owner.prompt('unsent');
  const rejected = assert.rejects(prompt, /originating chat changed/i);
  await new Promise((resolve) => setImmediate(resolve));
  await f.owner.abort();
  await f.owner.abort();
  release();
  await sync;
  await rejected;
  assert.deepEqual(f.calls, [['abort'], ['abort']]);
  assert.equal(f.owner.state.connectionState, 'ready');
  assert.equal(f.owner.state.state.isStreaming, false);
  assert.equal(f.owner.state.runOutcome, 'aborted');
});

test('deferred startup owns one launch and stop, disposal or navigation invalidates that ownership', async () => {
  for (const cancel of ['none', 'stop', 'dispose', 'navigation']) {
    const f = await fixture();
    f.owner.state.connectionState = 'stopped';
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.setWrite(() => waiting);
    const sync = f.sync();
    const first = f.owner.start();
    const second = f.owner.start();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.calls.length, 0);
    if (cancel === 'stop') await f.owner.stop();
    if (cancel === 'dispose') f.owner.dispose();
    if (cancel === 'navigation') f.owner.navigationEpoch = 1;
    release();
    await sync;
    await Promise.all([first, second]);
    assert.equal(
      f.calls.filter(([name]) => name === 'launch').length,
      cancel === 'none' ? 1 : 0,
      cancel
    );
    assert.equal(f.owner.startInProgress, false);
  }
});

test('Manual Mode rejects disabled extensions on startup and all prompt admissions, while automatic mode respects argv', async () => {
  for (const argument of ['--no-extensions', '-ne']) {
    const f = await fixture();
    f.owner.settings.additionalArgs = [argument];
    await f.sync();
    f.owner.state.connectionState = 'stopped';
    await assert.rejects(f.owner.start(), /Manual Mode requires Pi extensions/);
    assert.equal(f.owner.startInProgress, false);
    f.owner.state.connectionState = 'ready';
    for (const mode of ['prompt', 'steer', 'followUp']) {
      await assert.rejects(
        f.owner.prompt('retained draft', mode),
        /Manual Mode requires Pi extensions/
      );
    }
    await assert.rejects(
      f.owner.prompt('outbox draft', 'prompt', [], options),
      (error: any) =>
        error.outboxNotDispatched === true &&
        /Manual Mode requires Pi extensions/.test(error.message)
    );
    assert.deepEqual(f.calls, []);
    await f.sync(false);
    f.owner.state.connectionState = 'stopped';
    await f.owner.start();
    await f.owner.prompt('automatic');
    assert.equal(f.calls.length, 2);
    assert.deepEqual(f.owner.settings.additionalArgs, [argument]);
  }
});

test('a recovered automatic runtime with extensions disabled cannot accept Manual Mode prompts', async () => {
  const f = await fixture();
  await f.sync(false);
  f.owner.state.connectionState = 'stopped';
  f.owner.launchOnce = async (_session: string, attempt: { noExtensions: boolean }) => {
    f.calls.push(['launch', attempt.noExtensions]);
    if (!attempt.noExtensions) throw new Error('extension startup failed');
    f.owner.state.connectionState = 'ready';
  };
  await f.owner.start();
  assert.equal(f.owner.runtimeExtensionsDisabled, true);
  await f.owner.prompt('automatic after fallback');
  assert.throws(() => f.owner.assertManualModeAvailable(), /Manual Mode requires Pi extensions/);
  assert.equal(
    f.owner.state.connectionState,
    'busy',
    'availability refusal never interrupts the active automatic run'
  );
  await f.sync();
  const calls = f.calls.length;
  await assert.rejects(f.owner.prompt('Manual draft'), /Manual Mode requires Pi extensions/);
  assert.equal(f.calls.length, calls, 'unguarded fallback host receives no Manual Mode prompt');
  await f.sync(false);
  await f.owner.prompt('automatic again');
  assert.equal(f.calls.length, calls + 1);
});

test('Manual Mode enable validation rejects explicit disabled extensions while the effective mode remains automatic', async () => {
  const f = await fixture();
  await f.sync(false);
  for (const argument of ['--no-extensions', '-ne']) {
    f.owner.settings.additionalArgs = [argument];
    assert.throws(() => f.owner.assertManualModeAvailable(), /Manual Mode requires Pi extensions/);
    await f.owner.prompt('automatic remains allowed');
  }
  f.owner.settings.additionalArgs = [];
  assert.doesNotThrow(() => f.owner.assertManualModeAvailable());
  assert.equal(f.calls.length, 2);
});

test('a fresh start or restart waits out obsolete deferred startup and launches exactly once', async () => {
  for (const restart of [false, true]) {
    const f = await fixture();
    f.owner.state.connectionState = 'stopped';
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.setWrite(() => waiting);
    const sync = f.sync();
    const old = f.owner.start();
    await new Promise((resolve) => setImmediate(resolve));
    let fresh: Promise<void>;
    if (restart) fresh = f.owner.restart();
    else {
      await f.owner.stop();
      fresh = f.owner.start();
    }
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.calls.filter(([name]) => name === 'launch').length, 0);
    release();
    await sync;
    await Promise.all([old, fresh]);
    assert.equal(f.calls.filter(([name]) => name === 'launch').length, 1);
    assert.equal(f.owner.state.connectionState, 'ready');
  }
});

test('another Stop cancels a fresh startup waiting behind obsolete policy preparation', async () => {
  const f = await fixture();
  f.owner.state.connectionState = 'stopped';
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.setWrite(() => waiting);
  const sync = f.sync();
  const old = f.owner.start();
  await f.owner.stop();
  const fresh = f.owner.start();
  await f.owner.stop();
  release();
  await sync;
  await Promise.all([old, fresh]);
  assert.equal(f.calls.filter(([name]) => name === 'launch').length, 0);
  assert.equal(f.owner.state.connectionState, 'stopped');
});
