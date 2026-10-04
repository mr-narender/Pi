import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { createEmptyComposerState } from '../../src/webview/composer';

const secret = 'PRIVATE-CANARY-credentials-path-transcript';
async function load(vscode: any) {
  const result = await build({
    stdin: {
      contents:
        "export {ChatTabManager} from './src/editorTabs/tabManager'; export {createRedactedDiagnosticsExport} from './src/diagnostics/export';",
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    external: ['vscode'],
  });
  const module = { exports: {} as any };
  new Function('require', 'module', 'exports', result.outputFiles[0]!.text)(
    (id: string) => (id === 'vscode' ? vscode : createRequire(`${process.cwd()}/package.json`)(id)),
    module,
    module.exports
  );
  return module.exports;
}
function origin() {
  return {
    generation: 1,
    folder: { name: secret, uri: { fsPath: secret } },
    setDraft() {},
    snapshot: {
      connectionState: 'busy',
      generation: 1,
      restartCount: 2,
      queue: { steering: [secret], followUp: [] },
      state: {
        sessionId: secret,
        sessionFile: secret,
        sessionName: secret,
        model: { provider: secret, id: secret, headers: { authorization: secret } },
        thinkingLevel: 'medium',
        isStreaming: true,
        messageCount: 3,
        pendingMessageCount: 1,
        autoCompactionEnabled: true,
        config: { env: secret, auth: secret },
      },
      lastSessionStats: {
        totalMessages: 9,
        cost: 0.25,
        tokens: {
          input: 100,
          output: 5,
          total: 105,
          cacheRead: Infinity,
          cacheWrite: secret,
          custom: { tool: secret },
        },
        custom: { headers: secret },
        sessionName: secret,
      },
      eventHistory: [{ type: secret, timestamp: secret, data: { message: secret } }],
      uiHistory: [{ method: secret, timestamp: 1, data: { auth: secret } }],
      diagnostics: [{ kind: 'error', timestamp: 1, message: secret, detail: secret }],
      tools: [{ name: secret, args: { key: secret } }],
      stderrTail: [secret],
    },
    prompt() {
      throw new Error('must not prompt');
    },
  };
}
test('debug strict recursive whitelist: raw logs/names/config/auth/tool/custom stats never survive; malformed nested DTOs', async () => {
  const m = await load({});
  const c = origin();
  const logger = {
    health() {
      return { recentLogLines: [secret], env: secret, error: { message: secret } };
    },
  };
  const p = m.createRedactedDiagnosticsExport(logger, c);
  const text = JSON.stringify(p);
  assert.doesNotMatch(
    text,
    /PRIVATE-CANARY|recentLogLines|sessionName|sessionFile|provider|headers|custom|Infinity/
  );
  assert.equal(p.active.stats.totalMessages, 9);
  assert.equal(p.active.stats.cost, 0.25);
  assert.equal(p.active.stats.tokens.input, 100);
  assert.equal(p.active.stats.tokens.cacheRead, undefined);
  assert.equal(p.active.queue.steering, 1);
  assert.equal(p.active.connectionState, 'busy');
  for (const value of [
    null,
    [],
    secret,
    1,
    { tokens: null },
    { tokens: [secret], cost: NaN },
    { tokens: { input: -1, output: secret } },
  ]) {
    (c.snapshot as any).lastSessionStats = value;
    (c.snapshot as any).queue = value;
    const safe = JSON.stringify(m.createRedactedDiagnosticsExport(logger, c));
    assert.doesNotMatch(safe, /PRIVATE-CANARY|NaN|Infinity/);
  }
});

{
  test(`debug actual editor route: inspect exact payload; Done/Copy/Save/cancel/errors/stale/newer/retyped/images`, async () => {
    let choice: string | undefined = 'Done';
    let target: any = { fsPath: '/owned/test.json' };
    let mutate: (() => void) | undefined;
    let mutateSave: (() => void) | undefined;
    let fail = false;
    const previews: string[] = [],
      copies: string[] = [],
      files: string[] = [];
    const m = await load({
      workspace: {
        isTrusted: true,
        fs: {
          writeFile: async (_target: any, bytes: Uint8Array) => {
            if (fail) throw new Error(secret);
            files.push(Buffer.from(bytes).toString());
          },
        },
      },
      env: {
        clipboard: {
          writeText: async (text: string) => {
            if (fail) throw new Error(secret);
            copies.push(text);
          },
        },
      },
      window: {
        showInformationMessage: async (_title: string, options: any) => {
          previews.push(options.detail);
          mutate?.();
          if (fail && choice === 'Done') throw new Error(secret);
          return choice;
        },
        showSaveDialog: async () => {
          mutateSave?.();
          return target;
        },
      },
    });
    const state = createEmptyComposerState();
    const chips = [{ itemId: 'chip', name: secret, mimeType: 'image/png', sizeBytes: 1 }];
    const c = origin();
    const instance = Object.create(m['ChatTabManager'].prototype);
    instance.uiState = {
      captureIdentity: () => ({}),
      getComposerState: async () => structuredClone(state),
      getComposerStateForIdentity: async () => structuredClone(state),
      setComposerState: async (_c: any, s: any) => Object.assign(state, s),
      setComposerStateForIdentity: async (_c: any, _i: any, s: any) => Object.assign(state, s),
    };
    instance.contextForResource = () => ({ controller: c, target: {}, resource: {} });
    instance.renderResource = instance.postSnapshot = async () => {};
    instance.preparePromptContext = () => {
      throw new Error('no context expansion');
    };
    instance.follow = {
      armOnce() {
        throw new Error('no follow');
      },
    };
    const send = (mode = 'prompt') => instance.handleRequestSend({}, mode, true, 'ack');
    const reset = () => {
      state.draft = '/debug';
      state.commandRevision = 0;
      state.composerResetSeq = 0;
      state.pendingImages = structuredClone(chips);
      delete state.localCommandAck;
      delete state.recovery;
      mutate = undefined;
      mutateSave = undefined;
      fail = false;
    };
    for (const mode of ['prompt', 'steer', 'followUp']) {
      reset();
      await send(mode);
      assert.equal(state.draft, '');
      assert.equal(state.localCommandAck, 'ack');
      assert.deepEqual(state.pendingImages, chips);
      assert.doesNotMatch(previews.at(-1)!, /PRIVATE-CANARY/);
      assert.equal(JSON.parse(previews.at(-1)!).active.stats.tokens.input, 100);
    }
    reset();
    (c.snapshot.state as any).model = undefined;
    await send();
    assert.equal(state.draft, '', 'busy diagnostics require no model');
    for (choice of [undefined, 'Cancel']) {
      reset();
      const effects = [copies.length, files.length];
      await send();
      assert.deepEqual([copies.length, files.length], effects);
      assert.equal(state.draft, '');
      assert.equal(state.localCommandConsumed, 'ack');
      assert.equal(state.localCommandAck, undefined);
      assert.equal(state.composerResetSeq, 0);
    }
    for (choice of ['Copy JSON', 'Save JSON']) {
      reset();
      await send();
      assert.equal(state.draft, '');
      assert.equal((choice === 'Copy JSON' ? copies : files).at(-1), previews.at(-1));
    }
    choice = 'Save JSON';
    target = undefined;
    reset();
    await send();
    assert.equal(state.draft, '');
    assert.equal(files.length, 1);
    assert.equal(state.localCommandAck, undefined);
    assert.equal(state.composerResetSeq, 0);
    target = { fsPath: '/owned/test.json' };
    reset();
    mutateSave = () => {
      c.generation++;
    };
    await send();
    assert.equal(files.length, 1, 'stale save dialog must not write');
    assert.equal(state.localCommandAck, undefined);
    assert.equal(state.draft, '');
    reset();
    state.draft = '/debug args';
    const count = previews.length;
    await send();
    assert.equal(previews.length, count);
    assert.match(state.recovery!.detail, /does not accept arguments/);
    for (choice of ['Done', 'Copy JSON', 'Save JSON']) {
      reset();
      fail = true;
      await send();
      assert.equal(state.draft, '');
      assert.equal(state.localCommandAck, undefined);
      assert.doesNotMatch(state.recovery!.detail, /PRIVATE-CANARY/);
    }
    choice = 'Copy JSON';
    for (const change of ['draft', 'revision', 'generation', 'session', 'file', 'images']) {
      reset();
      const before = copies.length;
      mutate = () => {
        if (change === 'draft') state.draft = 'newer';
        if (change === 'revision') state.commandRevision = 1;
        if (change === 'generation') c.generation++;
        if (change === 'session') c.snapshot.state.sessionId += 'new';
        if (change === 'file') c.snapshot.state.sessionFile += 'new';
        if (change === 'images') state.pendingImages.push({ ...chips[0]!, itemId: 'new' });
      };
      await send();
      assert.equal(state.draft, change === 'draft' ? 'newer' : '');
      assert.equal(state.pendingImages.length, change === 'images' ? 2 : 1);
      if (['generation', 'session', 'file'].includes(change)) assert.equal(copies.length, before);
    }
  });
}
