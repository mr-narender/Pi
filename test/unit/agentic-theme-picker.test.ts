import assert from 'node:assert/strict';
import test from 'node:test';

test('Agentic QuickPick previews on navigation, restores on cancel, saves only on accept', async () => {
  const loader = require('node:module') as {
    _load: (request: string, ...args: unknown[]) => unknown;
  };
  const original = loader._load;
  let saved = 'system';
  const posted: unknown[] = [];
  const writes: string[] = [];
  const pickers: Array<{
    items: Array<{ label: string; value: string }>;
    activeItems: Array<{ label: string; value: string }>;
    selectedItems: Array<{ label: string; value: string }>;
    active: (items: Array<{ label: string; value: string }>) => void;
    accept: () => void;
    hide: () => void;
  }> = [];
  const vscode = {
    workspace: {
      getConfiguration: () => ({
        get: () => saved,
        update: async (_key: string, value: string) => {
          writes.push(value);
          saved = value;
        },
      }),
      onDidChangeConfiguration: () => ({ dispose() {} }),
    },
    window: {
      createQuickPick: () => {
        const listeners: Record<string, (...args: never[]) => void> = {};
        const picker = {
          items: [] as Array<{ label: string; value: string }>,
          activeItems: [] as Array<{ label: string; value: string }>,
          selectedItems: [] as Array<{ label: string; value: string }>,
          active(items: Array<{ label: string; value: string }>) {
            picker.activeItems = items;
            listeners.active?.(items as never);
          },
          accept() {
            listeners.accept?.();
          },
          hide() {
            listeners.hide?.();
          },
          onDidChangeActive(fn: (...args: never[]) => void) {
            listeners.active = fn;
          },
          onDidAccept(fn: (...args: never[]) => void) {
            listeners.accept = fn;
          },
          onDidHide(fn: (...args: never[]) => void) {
            listeners.hide = fn;
          },
          show() {},
          dispose() {},
        };
        pickers.push(picker);
        return picker;
      },
      showErrorMessage: () => undefined,
    },
    ConfigurationTarget: { Global: 1 },
  };
  loader._load = (request, ...args) =>
    request === 'vscode' ? vscode : original.call(loader, request, ...args);
  let Host: new (...args: unknown[]) => object;
  try {
    Host = require('../../src/ui/sidebar/agenticChatListHost.ts').AgenticChatListHost;
  } finally {
    loader._load = original;
  }
  const disposable = { dispose() {} };
  const host = new Host(
    {},
    { onDidChangeOpenChats: () => disposable },
    { onDidChange: () => disposable },
    {},
    {}
  );
  Object.assign(host, {
    view: { webview: { postMessage: (message: unknown) => posted.push(message) } },
  });
  const onMessage = (host as { onMessage: (message: unknown) => Promise<void> }).onMessage.bind(
    host
  );

  await onMessage({ type: 'chooseAgenticTheme' });
  const first = pickers[0]!;
  assert.equal(first.activeItems[0]?.value, 'system');
  first.active([first.items.find((item) => item.value === 'orange')!]);
  assert.deepEqual(posted.at(-1), { type: 'agenticTheme', theme: 'orange' });
  assert.deepEqual(writes, []);
  first.hide();
  assert.deepEqual(posted.at(-1), { type: 'agenticTheme', theme: 'system' });
  assert.deepEqual(writes, []);

  await onMessage({ type: 'chooseAgenticTheme' });
  const second = pickers[1]!;
  second.active([second.items.find((item) => item.value === 'light')!]);
  second.selectedItems = [second.items.find((item) => item.value === 'system')!];
  second.accept();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(writes, ['light']);
  assert.deepEqual(posted.at(-1), { type: 'agenticTheme', theme: 'light' });
});
