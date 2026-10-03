import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import type { WebviewSnapshot } from '../../src/state/types';
import { renderChatActionsMenu } from '../../src/webview/chatActionsMenu';

const command = 'piRpcInternal.setWorkingAnimation';
test('Working Animation is registered in Configure in native and shared full-chat menus', () => {
  const manifest = JSON.parse(readFileSync('package.json', 'utf8')).contributes;
  assert.equal(
    manifest.commands.find((item: any) => item.command === command)?.title,
    'Working Animation'
  );
  assert.deepEqual(
    manifest.menus['piRpc.agenticActions'].find((item: any) => item.command === command),
    { command, group: '2_configure@5' }
  );
  assert.ok(manifest.menus['piRpc.chatActions'].some((item: any) => item.command === command));
  const html = renderChatActionsMenu();
  assert.match(
    html.slice(html.indexOf('>Configure<'), html.indexOf('>System<')),
    /data-command="piRpcInternal.setWorkingAnimation">Working Animation<\/button>/
  );
  assert.deepEqual(manifest.configuration.properties['piRpc.workingAnimation'].enum, [
    'braille',
    'dots',
    'bars',
    'earth',
    'moon',
    'dolphin',
  ]);
  assert.equal(manifest.configuration.properties['piRpc.workingAnimation'].default, 'braille');
});

test('Working Animation routes allowlisted action to existing six-choice picker without composer changes', async () => {
  const source = readFileSync('src/extension.ts', 'utf8');
  const start = source.indexOf('  const pickSetting = async');
  const end = source.indexOf("  registrations.set('piRpcInternal.setTypewriterSpeed',", start);
  const result = await build({
    stdin: {
      contents: `import * as vscode from 'vscode'; export {ChatTabManager} from './src/editorTabs/tabManager'; export function register(registrations: any) { ${source.slice(start, end)} }`,
      resolveDir: process.cwd(),
      loader: 'ts',
    },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    external: ['vscode'],
  });
  const invocations: any[] = [];
  const registrations = new Map();
  const updates: any[] = [];
  const picks: any[] = [];
  let selection: string | undefined;
  const vscode = {
    ConfigurationTarget: { Global: 1 },
    window: {
      showQuickPick: async (items: any[], options: any) => {
        picks.push({ items, options });
        return items.find((item) => item.label === selection);
      },
    },
    commands: {
      executeCommand: async (...args: any[]) => {
        invocations.push(args);
        await registrations.get(args[0])?.(...args.slice(1));
      },
    },
    workspace: {
      getConfiguration: (section: string) => {
        assert.equal(section, 'piRpc');
        return {
          get: (key: string) => {
            assert.equal(key, 'workingAnimation');
            return 'moon';
          },
          update: async (...args: any[]) => {
            updates.push(args);
          },
        };
      },
    },
  };
  const module = { exports: {} as any };
  new Function('require', 'module', 'exports', result.outputFiles[0]!.text)(
    (id: string) => (id === 'vscode' ? vscode : createRequire(`${process.cwd()}/package.json`)(id)),
    module,
    module.exports
  );
  module.exports.register(registrations);
  const instance = Object.create(module.exports.ChatTabManager.prototype);
  const warnings: string[] = [];
  instance.logger = { warn: (message: string) => warnings.push(message) };
  const controller = { draft: 'unchanged', pendingImages: [{ itemId: 'image' }] };
  const before = structuredClone(controller);
  const browser = await build({
    entryPoints: ['src/webview/media/chat.ts'],
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
  });
  for (const surface of ['sidebar'] as const) {
    const dom = new JSDOM('<div id="app"></div>', {
      pretendToBeVisual: true,
      runScripts: 'outside-only',
    });
    const w = dom.window;
    const posted: any[] = [];
    Object.assign(w, {
      acquireVsCodeApi: () => ({
        postMessage: (message: any) => posted.push(message),
        getState() {},
        setState() {},
      }),
      ResizeObserver: class {
        observe() {}
        disconnect() {}
      },
      IntersectionObserver: class {
        observe() {}
        disconnect() {}
      },
      matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    });
    w.HTMLElement.prototype.scrollTo = () => {};
    w.HTMLElement.prototype.scrollIntoView = () => {};
    try {
      w.eval(browser.outputFiles[0]!.text);
      const snapshot: WebviewSnapshot = {
        sequence: 1,
        title: 'Chat',
        bindingState: 'current',
        uiMode: 'simple',
        connectionState: 'ready',
        workspaceFolderName: 'workspace',
        isStreaming: false,
        isCompacting: false,
        messages: [],
        queue: { steering: [], followUp: [] },
        draft: 'unchanged',
        statuses: {},
        widgets: [],
        thinkingLevel: 'off',
        pendingContextItems: [],
        pendingImages: [],
        focus: 'none',
        isTrusted: true,
        folders: [],
        typewriterSpeed: 'off',
        surface,
      };
      w.dispatchEvent(new w.MessageEvent('message', { data: { type: 'snapshot', snapshot } }));
      const button = w.document.querySelector<HTMLButtonElement>(
        `button[data-command="${command}"]`
      )!;
      assert.ok(button, `${surface} menu item exists`);
      const field = w.document.querySelector('textarea')!;
      const input = field.value;
      button.closest('details')!.setAttribute('open', '');
      button.click();
      assert.equal(button.closest('details')!.hasAttribute('open'), false);
      assert.equal(field.value, input);
      assert.deepEqual(
        JSON.parse(JSON.stringify(posted.find((message) => message.type === 'executeCommand'))),
        { type: 'executeCommand', command }
      );
    } finally {
      dom.window.close();
    }
  }
  await instance.handleExecuteCommand(command, { command: 'evil', filter: '@id:evil' }, controller);
  assert.deepEqual(invocations, [[command]]);
  assert.deepEqual(picks, [
    {
      items: ['braille', 'dots', 'bars', 'earth', 'moon', 'dolphin'].map((label) => ({
        label,
        description: label === 'moon' ? 'current' : '',
      })),
      options: { title: 'Working animation' },
    },
  ]);
  assert.deepEqual(updates, [], 'cancellation leaves settings unchanged');
  selection = 'dolphin';
  await instance.handleExecuteCommand(command, { label: 'evil', target: 'workspace' }, controller);
  assert.deepEqual(updates, [['workingAnimation', 'dolphin', vscode.ConfigurationTarget.Global]]);
  assert.deepEqual(controller, before);
  await instance.handleExecuteCommand('workbench.action.openSettings', '@id:evil', controller);
  await instance.handleExecuteCommand('evil.unknown', undefined, controller);
  assert.equal(invocations.length, 2);
  assert.equal(warnings.length, 2);
});
