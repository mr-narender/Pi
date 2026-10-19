import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { createEmptyComposerState } from '../../src/webview/composer';

async function fixture() {
  const result = await build({
    entryPoints: ['src/editorTabs/tabManager.ts'],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    external: ['vscode'],
  });
  const require = createRequire(`${process.cwd()}/package.json`),
    module = { exports: {} as any };
  new Function('require', 'module', 'exports', result.outputFiles[0]!.text)(
    (name: string) => (name === 'vscode' ? { workspace: { isTrusted: true } } : require(name)),
    module,
    module.exports
  );
  const manager = Object.create(module.exports.ChatTabManager.prototype);
  const resource = { toString: () => 'pi-chat:/owned.chat' };
  const target = {
    kind: 'sessionFile',
    workspaceFolderUri: 'file:///owned',
    sessionFile: '/owned/session.jsonl',
  };
  const proposal = {
    type: 'extension_ui_request',
    id: 'proposal',
    requestKey: 'nonce',
    method: 'set_editor_text',
    text: 'Suggested replacement',
  };
  let composer = createEmptyComposerState();
  composer.draft = 'My existing draft';
  composer.commandRevision = 4;
  composer.composerResetSeq = 2;
  composer.pendingImages = [
    {
      itemId: 'image',
      name: 'image.png',
      mimeType: 'image/png',
      sizeBytes: 3,
      inMemoryBase64: 'YWJj',
    },
  ];
  let alive = true,
    nativeCalls = 0;
  const controller = {
    snapshot: { state: { sessionFile: target.sessionFile, sessionId: 'owned' } },
    isExtensionUiRequestValid: () => alive,
    extensionUiRequest: () => (alive ? proposal : undefined),
    updateExtensionUiRequest: (_id: string, _key: string, patch: object) =>
      Object.assign(proposal, patch),
    completeExtensionUiRequest: () => {
      alive = false;
    },
    respondExtensionUi: async () => {
      nativeCalls++;
    },
  };
  const context = { controller, target, resource };
  Object.assign(manager, {
    extensionUiDrafts: new Map(),
    extensionUiDraftAcks: new Map(),
    sessions: { ownerOf: () => resource },
    contextForResource: () => context,
    renderResource: async () => {},
    uiState: {
      getComposerStateForIdentity: async () => structuredClone(composer),
      setComposerStateForIdentity: async (
        _c: unknown,
        _t: unknown,
        state: typeof composer,
        options: { expectedCommandRevision: number }
      ) => {
        if (options.expectedCommandRevision !== composer.commandRevision) return;
        state.commandRevision = (composer.commandRevision ?? 0) + 1;
        composer = structuredClone(state);
      },
    },
  });
  return {
    manager,
    controller,
    context,
    proposal,
    resource,
    get composer() {
      return composer;
    },
    get nativeCalls() {
      return nativeCalls;
    },
    edit: () => {
      composer.draft = 'Newer typing';
      composer.commandRevision!++;
    },
    empty: () => {
      composer.draft = '';
    },
    invalidate: () => {
      alive = false;
    },
  };
}
test('staged extension text preserves draft and images until explicit Use, then commits once with reset ACK', async () => {
  const f = await fixture();
  await f.manager.presentDraftProposal(f.controller, f.proposal);
  assert.equal(f.composer.draft, 'My existing draft');
  assert.equal(f.composer.composerResetSeq, 2);
  await f.manager.handleRespondUi(f.context, 'proposal', undefined, true, false, 'nonce');
  assert.equal(f.composer.draft, 'Suggested replacement');
  assert.equal(f.composer.pendingImages[0]?.inMemoryBase64, 'YWJj');
  assert.equal(f.composer.composerResetSeq, 3);
  assert.deepEqual(f.manager.extensionUiDraftAcks.get(f.resource.toString()), {
    requestKey: 'nonce',
    originKey: JSON.stringify(['/owned/session.jsonl', 'owned']),
    frame: 2,
    accepted: true,
  });
  assert.equal(f.nativeCalls, 0, 'fire-and-forget suggestions never send callback responses');
});

test('empty draft also stages text until Use, preserving unsynchronized browser typing', async () => {
  const f = await fixture();
  f.empty();
  await f.manager.presentDraftProposal(f.controller, f.proposal);
  assert.equal(f.composer.draft, '');
  assert.equal(f.composer.composerResetSeq, 2);
  assert.equal(f.manager.extensionUiDraftAcks.size, 0);
  assert.equal(f.composer.pendingImages[0]?.inMemoryBase64, 'YWJj');
  await f.manager.handleRespondUi(f.context, 'proposal', undefined, true, false, 'nonce');
  assert.equal(f.composer.draft, 'Suggested replacement');
  assert.equal(f.manager.extensionUiDraftAcks.get(f.resource.toString()).accepted, true);
});
test('Keep preserves unsent text; Use refuses newer typing with a negative correlated ACK', async () => {
  const kept = await fixture();
  await kept.manager.presentDraftProposal(kept.controller, kept.proposal);
  await kept.manager.handleRespondUi(kept.context, 'proposal', undefined, false, false, 'nonce');
  assert.equal(kept.composer.draft, 'My existing draft');
  const raced = await fixture();
  await raced.manager.presentDraftProposal(raced.controller, raced.proposal);
  raced.edit();
  await raced.manager.handleRespondUi(raced.context, 'proposal', undefined, true, false, 'nonce');
  assert.equal(raced.composer.draft, 'Newer typing');
  assert.equal(raced.manager.extensionUiDraftAcks.get(raced.resource.toString()).accepted, false);
  assert.equal(raced.composer.composerResetSeq, 2);
});
test('obsolete proposal origin cannot replace a different chat draft', async () => {
  const f = await fixture();
  await f.manager.presentDraftProposal(f.controller, f.proposal);
  f.invalidate();
  await f.manager.handleRespondUi(f.context, 'proposal', undefined, true, false, 'nonce');
  assert.equal(f.composer.draft, 'My existing draft');
  assert.equal(f.manager.extensionUiDraftAcks.size, 0);
});

test('draft storage failure retains the composer without an unhandled proposal rejection', async () => {
  const f = await fixture();
  f.manager.uiState.getComposerStateForIdentity = async () => {
    throw Error('fixture storage unavailable');
  };
  await f.manager.presentDraftProposal(f.controller, f.proposal);
  assert.equal(f.composer.draft, 'My existing draft');
  assert.equal(f.manager.extensionUiDrafts.size, 0);
  assert.match(
    (f.proposal as { responseError?: string }).responseError ?? '',
    /could not be loaded/
  );
});
