import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

function memento() {
  const data = new Map<string, unknown>();
  return {
    get: (key: string, fallback?: unknown) => data.get(key) ?? fallback,
    update: async (key: string, value: unknown) => {
      data.set(key, value);
    },
  };
}

async function load(workspaceFolders: unknown[]) {
  const uri = (scheme: string, path: string) => ({
    scheme,
    path,
    get fsPath() {
      return fileURLToPath(`file://${path}`);
    },
    toString: () => `${scheme}:${path}`,
  });
  const vscode = {
    workspace: { workspaceFolders },
    Uri: {
      from: ({ scheme, path }: { scheme: string; path: string }) => uri(scheme, path),
      parse: (value: string) => {
        const parsed = new URL(value);
        return uri(parsed.protocol.slice(0, -1), parsed.pathname);
      },
    },
  };
  const result = await build({
    stdin: {
      contents: `export {ChatTabManager} from './src/editorTabs/tabManager';
      export {ChatEditorProvider} from './src/editorTabs/provider';
      export {SessionIndex} from './src/editorTabs/sessionIndex';
      export * from './src/editorTabs/uri';
      export * from './src/editorTabs/uriRegistry';`,
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    external: ['vscode'],
  });
  const module = { exports: {} as any };
  const require = createRequire(`${process.cwd()}/package.json`);
  new Function('require', 'module', 'exports', result.outputFiles[0]!.text)(
    (id: string) => (id === 'vscode' ? vscode : require(id)),
    module,
    module.exports
  );
  return module.exports;
}

test('colliding legacy draft URIs retain their workspace targets and never guess across workspaces', async () => {
  const api = await load([]);
  const shared = memento();
  const folder = memento();
  const workspace = memento();
  api.initChatUriRegistry(shared);
  const draft = api.buildChatUri({
    workspaceFolderUri: 'file:///project',
    kind: 'workspaceDraft',
    draftId: 'd1',
  });
  const first = {
    workspaceFolderUri: 'file:///project',
    kind: 'sessionFile',
    sessionFile: '/sessions/original-a.jsonl',
  };
  const second = { ...first, sessionFile: '/sessions/original-b.jsonl' };
  await folder.update('piRpc.draftBindings', { [draft.toString()]: first });
  await workspace.update('piRpc.draftBindings', { [draft.toString()]: second });
  const firstIndex = new api.SessionIndex(shared, folder);
  assert.deepEqual(firstIndex.resolveTarget(draft), first);
  const secondIndex = new api.SessionIndex(shared, workspace);
  assert.deepEqual(secondIndex.resolveTarget(draft), second);
  assert.deepEqual(firstIndex.resolveTarget(draft), first);
  assert.equal(
    new api.SessionIndex(shared, memento()).resolveTarget(draft),
    undefined,
    'an ambiguous legacy URI cannot become either chat or a new draft'
  );
  const unknownManager = Object.create(api.ChatTabManager.prototype);
  unknownManager.sessions = new api.SessionIndex(shared, memento());
  assert.throws(
    () => new api.ChatEditorProvider(unknownManager).openCustomDocument(draft),
    /identity is unavailable/
  );
  const rebound = { ...second, sessionFile: '/sessions/intentional-fork.jsonl' };
  secondIndex.bind(draft, rebound);
  assert.deepEqual(
    new api.SessionIndex(shared, workspace).resolveTarget(draft),
    rebound,
    'stale legacy data must not override a later deliberate binding'
  );
  assert.deepEqual(
    firstIndex.resolveTarget(draft),
    first,
    'a fork in workspace B must not retarget workspace A'
  );
  firstIndex.unbind(draft.toString());
  assert.deepEqual(
    firstIndex.resolveTarget(draft),
    first,
    'closing and reopening a migrated legacy tab must retain its own JSONL after a collision and fork'
  );
  assert.deepEqual(new api.SessionIndex(shared, folder).resolveTarget(draft), first);
  assert.equal(
    new api.SessionIndex(shared, memento()).resolveTarget(draft),
    undefined,
    'a local legacy fork must not make the ambiguous global identity guessable'
  );
});

test('restored folder and saved-workspace tabs start the same absolute JSONL and recorded folder', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-chat-restore-'));
  try {
    const cwd = join(root, 'nested', 'project');
    await mkdir(cwd, { recursive: true });
    const target = {
      workspaceFolderUri: pathToFileURL(cwd).href,
      kind: 'sessionFile',
      sessionFile: join(root, 'sessions', '--original-folder--', 'original.jsonl'),
    };
    const api = await load([
      { uri: { toString: () => pathToFileURL(root).href }, name: 'Wrong first root' },
    ]);
    const shared = memento();
    const directFolderState = memento();
    api.initChatUriRegistry(shared, directFolderState);
    const existing = api.buildChatUri(target);
    const draft = api.buildChatUri({
      workspaceFolderUri: target.workspaceFolderUri,
      kind: 'workspaceDraft',
      draftId: 'owned-unique-draft',
    });
    new api.SessionIndex(shared, directFolderState).bind(draft, target);
    for (const resource of [existing, draft]) {
      api.__resetChatUriRegistry();
      const savedWorkspaceState = memento();
      api.initChatUriRegistry(shared, savedWorkspaceState);
      const manager = Object.create(api.ChatTabManager.prototype);
      manager.sessions = new api.SessionIndex(shared, savedWorkspaceState);
      manager.lastActivityAt = new Map();
      manager.activeResourceByWorkspace = new Map();
      manager.ensureTracked = () => {};
      manager.renderResource = async () => {};
      let started: string | undefined;
      let folder: any;
      const controller = {
        snapshot: { connectionState: 'stopped' },
        start: async (file: string) => {
          started = file;
        },
        reconcile: async () => {},
      };
      manager.registry = {
        setActive: () => {},
        getOrCreateFor: (_key: string, resolved: unknown) => {
          folder = resolved;
          return controller;
        },
      };
      await manager.activateResource(resource, { startIfStopped: true });
      assert.equal(
        started,
        target.sessionFile,
        'resume must not reconstruct the JSONL from the workspace root'
      );
      assert.equal(
        folder.uri.fsPath,
        cwd,
        'resume uses the recorded folder, not the first workspace root'
      );
      assert.deepEqual(manager.sessions.resolveTarget(resource), target);
    }
    const provider = new api.ChatEditorProvider({ resolveTarget: () => undefined });
    assert.throws(
      () => provider.openCustomDocument({ scheme: 'pi-chat', path: '/unknown.chat' }),
      /identity is unavailable/
    );
    const allocated: any[] = [];
    for (let i = 0; i < 2; i++) {
      const manager = Object.create(api.ChatTabManager.prototype);
      manager.nextSessionNumber = () => 1;
      manager.openTarget = async (value: unknown) => {
        allocated.push(value);
      };
      await manager.openDraftForWorkspace({
        folder: { uri: { toString: () => target.workspaceFolderUri } },
      });
    }
    assert.notEqual(
      api.chatPathFor(allocated[0]),
      api.chatPathFor(allocated[1]),
      'different workspace windows must not reuse the same draft URI'
    );
    const secondWindow = await load([]);
    secondWindow.initChatUriRegistry(shared, memento());
    const firstBindings = new api.SessionIndex(shared, memento());
    const secondBindings = new secondWindow.SessionIndex(shared, memento());
    const firstDraft = api.buildChatUri(allocated[0]);
    const secondDraft = secondWindow.buildChatUri(allocated[1]);
    firstBindings.resolveTarget(firstDraft);
    secondBindings.resolveTarget(secondDraft);
    firstBindings.bind(firstDraft, target);
    const secondTarget = { ...target, sessionFile: join(root, 'another-exact.jsonl') };
    secondBindings.bind(secondDraft, secondTarget);
    api.__resetChatUriRegistry();
    api.initChatUriRegistry(shared, memento());
    const restoredBindings = new api.SessionIndex(shared, memento());
    assert.deepEqual(restoredBindings.resolveTarget(firstDraft), target);
    assert.deepEqual(restoredBindings.resolveTarget(secondDraft), secondTarget);
    firstBindings.unbind(firstDraft.toString());
    assert.deepEqual(
      new api.SessionIndex(shared, memento()).resolveTarget(firstDraft),
      target,
      'closing a window must not erase the identity needed to restore its draft tab'
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
