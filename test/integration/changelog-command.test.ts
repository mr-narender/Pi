import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { createEmptyComposerState } from '../../src/webview/composer';

for (const route of ['editor', 'sidebar']) {
  test(`changelog: ${route} selected SDK preview, busy/no-model, bounded failures and origin safety`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-changelog-test-'));
    try {
      await mkdir(join(root, 'dist'));
      await writeFile(join(root, 'dist/cli.js'), '// owned fixture');
      const pkg = {
        name: '@earendil-works/pi-coding-agent',
        version: '0.99.1',
        bin: { pi: 'dist/cli.js' },
      };
      await writeFile(join(root, 'package.json'), JSON.stringify(pkg));
      const content = '# Changelog\n\n## 0.99.1\n\nSELECTED ENGINE ONLY\n';
      await writeFile(join(root, 'CHANGELOG.md'), content);
      let choice: string | undefined = 'Open Preview';
      let mutate: (() => void) | undefined;
      let mutateStage = 'dialog';
      let fail = false;
      const docs: any[] = [];
      const previews: any[] = [];
      const notices: any[] = [];
      const result = await build({
        stdin: {
          contents:
            "export {ChatTabManager} from './src/editorTabs/tabManager'; export {ChatPanelProvider} from './src/webview/provider';",
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
        workspace: {
          isTrusted: true,
          openTextDocument: async (options: any) => {
            docs.push(options);
            if (mutateStage === 'document') mutate?.();
            return { uri: 'owned-document' };
          },
        },
        window: {
          showInformationMessage: async (...args: any[]) => {
            notices.push(args);
            if (mutateStage === 'dialog') mutate?.();
            return choice;
          },
        },
        commands: {
          executeCommand: async (...args: any[]) => {
            previews.push(args);
            if (mutateStage === 'preview') mutate?.();
            if (fail) throw new Error('preview unavailable');
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
        sdkRoot: root,
        generation: 1,
        snapshot: {
          state: { sessionId: 'origin', sessionFile: '/owned/origin', isStreaming: true },
        },
        setDraft: () => {},
        prompt: () => {
          throw new Error('provider prompt forbidden');
        },
      };
      const instance = Object.create(
        module.exports[route === 'editor' ? 'ChatTabManager' : 'ChatPanelProvider'].prototype
      );
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
        armOnce: () => {
          throw new Error('follow forbidden');
        },
      };
      const send = () =>
        route === 'editor'
          ? instance.handleRequestSend({}, 'prompt', true, 'ack')
          : instance.handleRequestSend(controller, 'prompt', 'ack');
      const reset = () => {
        mutate = undefined;
        controller.sdkRoot = root;
        choice = 'Open Preview';
        fail = false;
        delete state.localCommandAck;
        delete state.recovery;
        state.commandRevision = 0;
        state.composerResetSeq = 0;
        state.draft = ' /changelog  ';
        state.pendingImages = structuredClone(chips);
      };
      reset();
      await send();
      assert.equal(previews.length, 1, 'must open native selected-engine Markdown preview');
      assert.deepEqual(previews[0], ['markdown.showPreview', 'owned-document']);
      assert.equal(docs[0].language, 'markdown');
      assert.match(docs[0].content, /Pi engine 0\.99\.1/);
      assert.ok(docs[0].content.includes(content));
      assert.equal(state.draft, '');
      assert.equal(state.localCommandAck, 'ack');
      assert.deepEqual(state.pendingImages, chips);
      reset();
      choice = undefined;
      await send();
      assert.equal(state.draft, '');
      assert.equal(state.localCommandConsumed, 'ack');
      assert.equal(previews.length, 1);
      reset();
      state.draft = '/changelog args';
      await send();
      assert.match(state.recovery!.detail, /does not accept arguments/);
      reset();
      fail = true;
      await send();
      assert.equal(state.draft, '');
      assert.match(state.recovery!.detail, /preview unavailable/);
      for (const stage of ['dialog', 'document', 'preview']) {
        mutateStage = stage;
        for (const change of ['draft', 'revision', 'generation', 'session', 'file', 'images']) {
          reset();
          mutate = () => {
            if (change === 'draft') state.draft = 'newer';
            if (change === 'revision') state.commandRevision = (state.commandRevision ?? 0) + 1;
            if (change === 'generation') controller.generation++;
            if (change === 'session') controller.snapshot.state.sessionId += '-new';
            if (change === 'file') controller.snapshot.state.sessionFile += '-new';
            if (change === 'images') state.pendingImages.push({ ...chips[0]!, itemId: 'new' });
          };
          await send();
          assert.equal(state.draft, change === 'draft' ? 'newer' : '');
          assert.ok(state.pendingImages.length >= 1);
        }
      }
      for (const error of [
        'unknown',
        'unresolvable',
        'missing',
        'wrong',
        'version',
        'huge',
        'symlink',
        'directory',
      ]) {
        reset();
        if (error === 'unknown') controller.sdkRoot = undefined as any;
        if (error === 'unresolvable') controller.sdkRoot = join(root, 'not-an-sdk');
        if (error === 'version')
          await writeFile(join(root, 'package.json'), JSON.stringify({ ...pkg, version: '9.9.9' }));
        if (error === 'directory') {
          await rm(join(root, 'CHANGELOG.md'));
          await mkdir(join(root, 'CHANGELOG.md'));
        }
        if (error === 'missing') await rm(join(root, 'CHANGELOG.md'));
        if (error === 'wrong')
          await writeFile(
            join(root, 'package.json'),
            JSON.stringify({ ...pkg, name: 'gui-extension' })
          );
        if (error === 'huge')
          await writeFile(join(root, 'CHANGELOG.md'), Buffer.alloc(2 * 1024 * 1024 + 1));
        if (error === 'symlink') {
          await rm(join(root, 'CHANGELOG.md'));
          await symlink(join(root, 'package.json'), join(root, 'CHANGELOG.md'));
        }
        const count: number = previews.length;
        await send();
        assert.equal(previews.length, count);
        assert.equal(state.draft, '', 'bare menu text is consumed even on preview failure');
        assert.ok(state.recovery?.detail);
        await writeFile(join(root, 'package.json'), JSON.stringify(pkg));
        await rm(join(root, 'CHANGELOG.md'), { force: true, recursive: true });
        await writeFile(join(root, 'CHANGELOG.md'), content);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
