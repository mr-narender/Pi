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
