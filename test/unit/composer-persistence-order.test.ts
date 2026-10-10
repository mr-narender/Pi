import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { build } from 'esbuild';
import { createEmptyComposerState, fingerprint } from '../../src/webview/composer';

async function chatUiState(vscode: unknown) {
  const compiled = await build({
    entryPoints: ['src/webview/composerState.ts'],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    external: ['vscode'],
  });
  const require = createRequire(`${process.cwd()}/package.json`);
  const module = { exports: {} as Record<string, any> };
  new Function('require', 'module', 'exports', compiled.outputFiles[0]!.text)(
    (id: string) => (id === 'vscode' ? vscode : require(id)),
    module,
    module.exports
  );
  return module.exports.ChatUiState;
}

test('a completed send stays cleared after restart when an older draft write was in flight', async () => {
  const stored = new Map<string, unknown>();
  let writes = 0;
  const workspaceState = {
    get: (key: string, fallback: unknown) => stored.get(key) ?? fallback,
    update: async (key: string, value: unknown) => {
      const call = ++writes;
      if (call === 1) await new Promise((resolve) => setTimeout(resolve, 30));
      stored.set(key, structuredClone(value));
    },
  };
  const vscode = {
    EventEmitter: class {
      event = () => ({ dispose() {} });
      fire() {}
      dispose() {}
    },
    workspace: { isTrusted: true },
  };
  const ChatUiState = await chatUiState(vscode);
  const controller = {
    folder: { uri: { toString: () => 'file:///workspace' } },
    snapshot: { state: { sessionId: 'sid' }, draft: '' },
    setDraft() {},
  };
  const identity = { workspaceFolderUri: 'file:///workspace', kind: 'sessionId', sessionId: 'sid' };
  const context = { workspaceState };
  const ui = new ChatUiState(context);
  const submitted = createEmptyComposerState();
  submitted.draft = 'already sent';
  submitted.pendingImages = [
    { itemId: 'image', name: 'sent.png', mimeType: 'image/png', sizeBytes: 1 },
  ];
  const staleWrite = ui.setComposerStateForIdentity(controller, identity, submitted);
  await new Promise((resolve) => setImmediate(resolve));

  const cleared = await ui.getComposerStateForIdentity(controller, identity);
  cleared.draft = '';
  cleared.pendingImages = [];
  cleared.composerResetSeq = 1;
  const clearWrite = ui.setComposerStateForIdentity(controller, identity, cleared);
  await Promise.all([staleWrite, clearWrite]);

  const restarted = new ChatUiState(context);
  const restored = await restarted.getComposerStateForIdentity(controller, identity);
  assert.equal(restored.draft, '');
  assert.deepEqual(restored.pendingImages, []);
  assert.equal(writes, 2);
});

test('a delayed attachment revalidation cannot overwrite a newer send clear', async () => {
  let enterValidation!: () => void;
  let releaseValidation!: () => void;
  const validationEntered = new Promise<void>((resolve) => (enterValidation = resolve));
  const validationReleased = new Promise<void>((resolve) => (releaseValidation = resolve));
  const stored = new Map<string, unknown>();
  const workspaceState = {
    get: (key: string, fallback: unknown) => stored.get(key) ?? fallback,
    update: async (key: string, value: unknown) => stored.set(key, structuredClone(value)),
  };
  const vscode = {
    EventEmitter: class {
      event = () => ({ dispose() {} });
      fire() {}
      dispose() {}
    },
    Range: class {
      constructor(..._args: unknown[]) {}
    },
    Uri: {
      file: (path: string) => ({ fsPath: path }),
      joinPath: (_root: unknown, path: string) => ({ fsPath: `/workspace/${path}` }),
    },
    workspace: {
      isTrusted: true,
      openTextDocument: async () => {
        enterValidation();
        await validationReleased;
        return {
          lineCount: 1,
          languageId: 'plaintext',
          lineAt: () => ({ text: 'attached content' }),
          getText: () => 'attached content',
        };
      },
    },
  };
  const ChatUiState = await chatUiState(vscode);
  const controller = {
    folder: {
      uri: { fsPath: '/workspace', toString: () => 'file:///workspace' },
    },
    snapshot: { state: { sessionId: 'sid' }, draft: '' },
    setDraft() {},
  };
  const identity = { workspaceFolderUri: 'file:///workspace', kind: 'sessionId', sessionId: 'sid' };
  const ui = new ChatUiState({ workspaceState });
  const attached = createEmptyComposerState();
  attached.draft = 'send this';
  attached.pendingContextItems = [
    {
      kind: 'pickedFile',
      itemId: 'file-1',
      workspaceFolder: 'file:///workspace',
      workspaceRelativePath: 'notes.txt',
      lineStart: 1,
      lineEnd: 1,
      languageId: 'plaintext',
      sanitizedContent: 'attached content',
      capturedAt: new Date(0).toISOString(),
      persistedRef: {
        workspaceRelativePath: 'notes.txt',
        lineStart: 1,
        lineEnd: 1,
        languageId: 'plaintext',
        contentFingerprint: fingerprint('attached content'),
      },
    },
  ];
  await ui.setComposerStateForIdentity(controller, identity, attached);

  const staleRead = ui.getComposerStateForIdentity(controller, identity);
  await validationEntered;
  const cleared = createEmptyComposerState();
  cleared.composerResetSeq = 1;
  await ui.setComposerStateForIdentity(controller, identity, cleared);
  releaseValidation();

  const observed = await staleRead;
  assert.equal(observed.draft, '');
  assert.deepEqual(observed.pendingContextItems, []);
  assert.equal(observed.composerResetSeq, 1);
  const current = await ui.getComposerStateForIdentity(controller, identity);
  assert.equal(current.draft, '');
  assert.deepEqual(current.pendingContextItems, []);
  assert.equal(current.composerResetSeq, 1);
});
