import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

async function createHarness(models: Array<{ provider: string; id: string }>, current = models[0]) {
  const pickers: any[] = [];
  const warnings: string[] = [];
  const vscode = {
    window: {
      createQuickPick: () => {
        let onAccept = () => {};
        let onHide = () => {};
        const picker = {
          items: [] as any[],
          selectedItems: [] as any[],
          value: '',
          title: '',
          onDidChangeValue() {},
          onDidAccept(fn: () => void) {
            onAccept = fn;
          },
          onDidHide(fn: () => void) {
            onHide = fn;
          },
          show() {
            pickers.push(picker);
          },
          accept(item: any) {
            picker.selectedItems = [item];
            onAccept();
          },
          hide() {
            onHide();
          },
          dispose() {},
        };
        return picker;
      },
      showErrorMessage() {},
      showWarningMessage(message: string) {
        warnings.push(message);
      },
    },
  };
  const built = await build({
    stdin: {
      contents: "export { pickChatModel } from './src/commands/modelPicker';",
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    external: ['vscode'],
  });
  const mod = { exports: {} as any };
  new Function('require', 'module', 'exports', built.outputFiles[0]!.text)(
    () => vscode,
    mod,
    mod.exports
  );
  const controller = {
    snapshot: { state: { model: current } },
    getAvailableModels: async () => models,
    refreshAvailableModels: undefined as
      | (() => Promise<Array<{ provider: string; id: string }>>)
      | undefined,
    modelDiscoveryProviders: [] as string[],
    selectModel: async (provider: string, id: string) => {
      controller.snapshot.state.model = { provider, id };
    },
    refreshState: async () => {},
  };
  const waitForPicker = async (count: number) => {
    for (let i = 0; i < 20 && pickers.length < count; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    assert.equal(pickers.length, count);
    return pickers[count - 1];
  };
  return { controller, pickChatModel: mod.exports.pickChatModel, pickers, waitForPicker, warnings };
}

test('provider-first picker rejects a stale origin before model application', async () => {
  const harness = await createHarness([
    { provider: 'alpha', id: 'one' },
    { provider: 'beta', id: 'two' },
  ]);
  let valid = true;
  const applied: string[] = [];
  const pending = harness.pickChatModel(harness.controller, {
    valid: () => valid,
    apply: async (provider: string, id: string) => {
      applied.push(`${provider}/${id}`);
      return true;
    },
  });
  const providers = await harness.waitForPicker(1);
  providers.accept(providers.items.find((item: any) => item.name === 'beta'));
  const models = await harness.waitForPicker(2);
  valid = false;
  models.accept(models.items[0]);

  await assert.rejects(pending, /originating chat changed/);
  assert.deepEqual(applied, []);
});

test('uncached authenticated OpenRouter remains selectable alongside one cached provider', async () => {
  const harness = await createHarness([{ provider: 'other', id: 'cached' }]);
  harness.controller.modelDiscoveryProviders = ['openrouter'];
  let release!: (models: Array<{ provider: string; id: string }>) => void;
  harness.controller.refreshAvailableModels = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const pending = harness.pickChatModel(harness.controller);
  const providers = await harness.waitForPicker(1);
  assert.deepEqual(
    providers.items.map((item: any) => item.name),
    ['openrouter', 'other']
  );
  providers.accept(providers.items[0]);
  const models = await harness.waitForPicker(2);
  assert.deepEqual(models.items, []);
  release([{ provider: 'openrouter', id: 'discovered' }]);
  await new Promise((resolve) => setImmediate(resolve));
  models.accept(models.items[0]);
  assert.deepEqual(await pending, { provider: 'openrouter', id: 'discovered' });
});

test('model discovery shows cached providers immediately and updates the chosen provider without clearing its query', async () => {
  const harness = await createHarness([
    { provider: 'openrouter', id: 'cached' },
    { provider: 'other', id: 'cached-other' },
  ]);
  let release!: (models: Array<{ provider: string; id: string }>) => void;
  harness.controller.refreshAvailableModels = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const pending = harness.pickChatModel(harness.controller, { query: 'key' });
  const providers = await harness.waitForPicker(1);
  assert.equal(providers.busy, true);
  assert.equal(providers.items[0].name, 'openrouter');
  providers.accept(providers.items[0]);
  const models = await harness.waitForPicker(2);
  assert.equal(models.busy, true);
  release([
    { provider: 'openrouter', id: 'key-model' },
    { provider: 'other', id: 'key-other' },
  ]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(models.busy, false);
  assert.equal(models.value, 'key');
  assert.deepEqual(
    models.items.map((item: any) => item.label),
    ['key-model']
  );
  models.accept(models.items[0]);
  assert.deepEqual(await pending, { provider: 'openrouter', id: 'key-model' });
});

test('empty cached catalog discovers providers and picker cancellation stays immediate during refresh', async () => {
  const harness = await createHarness([]);
  let release!: (models: Array<{ provider: string; id: string }>) => void;
  harness.controller.refreshAvailableModels = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const pending = harness.pickChatModel(harness.controller);
  const providers = await harness.waitForPicker(1);
  assert.deepEqual(providers.items, []);
  release([{ provider: 'openrouter', id: 'available' }]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(providers.items[0].name, 'openrouter');
  providers.hide();
  assert.equal(await pending, undefined);

  harness.controller.refreshAvailableModels = () => new Promise(() => {});
  const cancelled = harness.pickChatModel(harness.controller);
  const loading = await harness.waitForPicker(2);
  loading.hide();
  assert.equal(await cancelled, undefined);
});

test('failed model discovery keeps cached selection usable and exposes a clear fallback', async () => {
  const harness = await createHarness([
    { provider: 'openrouter', id: 'cached' },
    { provider: 'other', id: 'cached-other' },
  ]);
  let fail!: (error: Error) => void;
  harness.controller.refreshAvailableModels = () =>
    new Promise((_resolve, reject) => {
      fail = reject;
    });
  const pending = harness.pickChatModel(harness.controller);
  const providers = await harness.waitForPicker(1);
  fail(new Error('secret provider failure'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(providers.busy, false);
  assert.match(providers.placeholder, /cached models shown/);
  assert.doesNotMatch(providers.placeholder, /secret/);
  providers.accept(providers.items[0]);
  const models = await harness.waitForPicker(2);
  models.accept(models.items[0]);
  assert.deepEqual(await pending, { provider: 'openrouter', id: 'cached' });
});

test('provider-first picker keeps slash-bearing provider and model identities distinct', async () => {
  const harness = await createHarness(
    [
      { provider: 'proxy', id: 'vendor/family/model' },
      { provider: 'proxy/vendor', id: 'family/model' },
    ],
    { provider: 'proxy/vendor', id: 'family/model' }
  );
  const applied: Array<[string, string]> = [];
  const pending = harness.pickChatModel(harness.controller, {
    apply: async (provider: string, id: string) => {
      applied.push([provider, id]);
      return true;
    },
  });
  const providers = await harness.waitForPicker(1);
  providers.accept(providers.items.find((item: any) => item.name === 'proxy'));
  const models = await harness.waitForPicker(2);

  assert.equal(models.items.length, 1);
  assert.equal(models.items[0].label, 'vendor/family/model');
  models.accept(models.items[0]);

  assert.deepEqual(await pending, { provider: 'proxy', id: 'vendor/family/model' });
  assert.deepEqual(applied, [['proxy', 'vendor/family/model']]);
  const warning = harness.warnings[0];
  assert.ok(warning);
  assert.match(
    warning,
    /asked for provider "proxy", model "vendor\/family\/model"; session reports provider "proxy\/vendor", model "family\/model"/
  );
});
