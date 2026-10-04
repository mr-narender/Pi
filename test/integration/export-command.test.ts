import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { createEmptyComposerState } from '../../src/webview/composer';

{
  test(`export editor: native grammar, local consent, cancellation and unchanged-origin ACK`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-export-route-'));
    try {
      let choice: string | undefined = 'Export locally';
      let selected: string | undefined;
      let mutate: (() => void) | undefined;
      let fail = false;
      let saves = 0;
      const notices: any[] = [];
      const writes: any[] = [];
      const result = await build({
        stdin: {
          contents: "export {ChatTabManager} from './src/editorTabs/tabManager'; ",
          resolveDir: process.cwd(),
        },
        bundle: true,
        write: false,
        platform: 'node',
        format: 'cjs',
        external: ['vscode'],
      });
      const module = { exports: {} as any };
      const vscode = {
        Uri: { file: (fsPath: string) => ({ fsPath, scheme: 'file' }) },
        workspace: { isTrusted: true },
        window: {
          showSaveDialog: async () => {
            saves++;
            mutate?.();
            return selected ? { fsPath: selected, scheme: 'file' } : undefined;
          },
          showWarningMessage: async (...args: any[]) => {
            notices.push(args);
            mutate?.();
            return choice;
          },
          showInformationMessage: async (...args: any[]) => {
            notices.push(args);
          },
        },
      };
      new Function('require', 'module', 'exports', result.outputFiles[0]!.text)(
        (id: string) =>
          id === 'vscode' ? vscode : createRequire(`${process.cwd()}/package.json`)(id),
        module,
        module.exports
      );
      const state = createEmptyComposerState();
      const chips = [{ itemId: 'chip', name: 'chip', mimeType: 'image/png', sizeBytes: 1 }];
      const controller = {
        generation: 1,
        folder: { uri: { fsPath: root, scheme: 'file' } },
        snapshot: {
          state: {
            sessionId: 'origin',
            sessionFile: join(root, 'native.jsonl'),
            isStreaming: false,
          },
          leafId: 'leaf',
        },
        setDraft() {},
        captureExportIntent() {
          const generation = this.generation;
          const sessionId = this.snapshot.state.sessionId;
          const file = this.snapshot.state.sessionFile;
          const leaf = this.snapshot.leafId;
          return {
            valid: () =>
              generation === this.generation &&
              sessionId === this.snapshot.state.sessionId &&
              file === this.snapshot.state.sessionFile &&
              leaf === this.snapshot.leafId,
            write: async (path: string, jsonl: boolean) => {
              if (fail) throw new Error('owned write failure');
              writes.push({ path, jsonl });
              await writeFile(path, 'owned export');
              return { path };
            },
          };
        },
        prompt() {
          throw new Error('provider forbidden');
        },
      };
      const instance = Object.create(module.exports['ChatTabManager'].prototype);
      instance.uiState = {
        captureIdentity: () => ({}),
        getComposerState: async () => structuredClone(state),
        getComposerStateForIdentity: async () => structuredClone(state),
        setComposerState: async (_c: any, s: any) => Object.assign(state, s),
        setComposerStateForIdentity: async (_c: any, _i: any, s: any) => Object.assign(state, s),
      };
      instance.contextForResource = () => ({ controller, target: {}, resource: {} });
      instance.renderResource = instance.postSnapshot = async () => {};
      instance.preparePromptContext = () => {
        throw new Error('expansion forbidden');
      };
      instance.follow = {
        armOnce() {
          throw new Error('follow forbidden');
        },
      };
      const send = () => instance.handleRequestSend({}, 'prompt', true, 'ack');
      const reset = (draft: string) => {
        mutate = undefined;
        fail = false;
        choice = 'Export locally';
        selected = undefined;
        delete state.localCommandAck;
        delete state.recovery;
        state.draft = draft;
        state.pendingImages = structuredClone(chips);
        state.commandRevision = 0;
        state.composerResetSeq = 0;
      };
      for (const [args, filename, jsonl] of [
        ['one.jsonl trailing', 'one.jsonl', true],
        ['"two words.html" ignored', 'two words.html', false],
        ["'colon:name.jsonl' ignored", 'colon:name.jsonl', true],
        ['upper.JSONL', 'upper.JSONL', false],
        ['plain.json', 'plain.json', false],
        ['"literal\\name.html" trailing', 'literal\\name.html', false],
      ] as const) {
        reset(`/export ${args}`);
        await send();
        assert.deepEqual(
          writes.at(-1),
          { path: join(root, filename), jsonl },
          'must perform actual local export'
        );
        assert.equal(state.draft, '');
        assert.equal(state.localCommandAck, 'ack');
        assert.deepEqual(state.pendingImages, chips);
      }
      assert.match(JSON.stringify(notices), /local|privacy/i);
      for (const args of ['', ' "unmatched', " ''"]) {
        reset(`/export${args}`);
        const count = writes.length;
        const seq = saves;
        await send();
        assert.equal(saves, seq + 1);
        assert.equal(writes.length, count);
        assert.equal(state.draft, args ? `/export${args}` : '', 'only bare menu consumes');
        assert.equal(state.localCommandAck, undefined);
        assert.equal(state.composerResetSeq, 0);
      }
      reset('/export');
      selected = join(root, 'selected.jsonl');
      await send();
      assert.equal(writes.at(-1).jsonl, true);
      reset('/export one.jsonl');
      choice = undefined;
      const count = writes.length;
      await send();
      assert.equal(writes.length, count);
      assert.equal(await readFile(join(root, 'one.jsonl'), 'utf8'), 'owned export');
      assert.equal(state.draft, '/export one.jsonl');
      reset('/export failure.html');
      fail = true;
      await send();
      assert.match(state.recovery!.detail, /owned write failure/);
      assert.deepEqual(state.pendingImages, chips);
      for (const change of [
        'generation',
        'session',
        'file',
        'leaf',
        'newer',
        'revision',
        'images',
      ]) {
        reset('/export fresh.html');
        const before = writes.length;
        mutate = () => {
          if (change === 'generation') controller.generation++;
          if (change === 'session') controller.snapshot.state.sessionId += 'new';
          if (change === 'file') controller.snapshot.state.sessionFile += 'new';
          if (change === 'leaf') controller.snapshot.leafId += 'new';
          if (change === 'newer') state.draft = 'newer';
          if (change === 'revision') state.commandRevision!++;
          if (change === 'images') state.pendingImages.push({ ...chips[0]!, itemId: 'new' });
        };
        await send();
        assert.equal(
          writes.length,
          before + (['newer', 'revision', 'images'].includes(change) ? 1 : 0)
        );
        assert.equal(
          state.draft,
          change === 'newer' ? 'newer' : change === 'images' ? '' : '/export fresh.html'
        );
        assert.ok(state.pendingImages.length >= 1);
      }
      reset('/export busy.html');
      controller.snapshot.state.isStreaming = true;
      await send();
      assert.match(state.recovery!.detail, /idle|stream/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
