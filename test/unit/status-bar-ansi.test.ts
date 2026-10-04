import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stripAnsiCodes } from '../../src/ui/status/ansi';
import { build } from 'esbuild';

test('Agentic status stays quiet for healthy chats and exposes faults without a view mode', async () => {
  const result = await build({
    stdin: {
      contents: "export {StatusBarController} from './src/ui/status/statusBar';",
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    external: ['vscode'],
  });
  const items: Array<{
    visible: boolean;
    text: string;
    show(): void;
    hide(): void;
    dispose(): void;
  }> = [];
  const vscode = {
    StatusBarAlignment: { Left: 1 },
    window: {
      createStatusBarItem: () => {
        const item = {
          visible: false,
          text: '',
          show() {
            this.visible = true;
          },
          hide() {
            this.visible = false;
          },
          dispose() {},
        };
        items.push(item);
        return item;
      },
    },
    workspace: { getConfiguration: () => ({ get: () => [] }) },
  };
  const module = { exports: {} as Record<string, any> };
  new Function('require', 'module', 'exports', result.outputFiles[0]!.text)(
    () => vscode,
    module,
    module.exports
  );
  const status = new module.exports.StatusBarController();
  let publish: (state: unknown) => void = () => {};
  const controller = {
    folder: { name: 'workspace' },
    snapshot: { connectionState: 'ready', statuses: {} },
    onDidChangeState: (listener: typeof publish) => {
      publish = listener;
      return { dispose() {} };
    },
  };
  status.bind(controller);
  assert.equal(items[0]!.visible, false);
  publish({ connectionState: 'faulted', statuses: {} });
  assert.equal(items[0]!.visible, true);
  assert.match(items[0]!.text, /workspace: faulted/);
  publish({ connectionState: 'ready', statuses: {} });
  assert.equal(items[0]!.visible, false);
  assert.equal('setMode' in status, false);
  status.dispose();
});

test('strips the exact reported case: color codes around an emoji + text', () => {
  const input = '\x1b[38;5;109m🐈 MCP: 2 servers enabled\x1b[39m';
  assert.equal(stripAnsiCodes(input), '🐈 MCP: 2 servers enabled');
});

test('strips multiple color codes in one string', () => {
  const input =
    '\x1b[38;5;241m○\x1b[39m \x1b[38;5;244mponytail: \x1b[39m\x1b[38;5;188m⚡ FULL\x1b[39m';
  assert.equal(stripAnsiCodes(input), '○ ponytail: ⚡ FULL');
});

test('plain text with no ANSI codes is unchanged', () => {
  assert.equal(stripAnsiCodes('just plain text'), 'just plain text');
});

test('empty string is unchanged', () => {
  assert.equal(stripAnsiCodes(''), '');
});
