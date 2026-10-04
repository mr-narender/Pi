import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { build } from 'esbuild';

test('explicit list snapshot request recovers a snapshot sent before webview readiness', async () => {
  const compiled = await build({
    entryPoints: ['src/ui/sidebar/agenticChatListHost.ts'],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    external: ['vscode'],
    define: { __PI_BUILD__: '"test"' },
  });
  const require = createRequire(`${process.cwd()}/package.json`);
  const module = { exports: {} as Record<string, any> };
  new Function('require', 'module', 'exports', compiled.outputFiles[0]!.text)(
    (id: string) => (id === 'vscode' ? {} : require(id)),
    module,
    module.exports
  );
  const disposable = { dispose() {} };
  const host = new module.exports.AgenticChatListHost(
    {},
    { onDidChangeOpenChats: () => disposable, listOpenChats: () => [] },
    { onDidChange: () => disposable },
    {},
    { get: () => [] }
  );
  const delivered: unknown[] = [];
  let ready = false;
  host.view = {
    webview: {
      postMessage: async (message: unknown) => {
        if (ready) delivered.push(message);
        return ready;
      },
    },
  };
  host.buildModel = () => ({ rows: [], loading: false });
  await host.pushSnapshot();
  assert.equal(delivered.length, 0);
  ready = true;
  await host.onMessage({ type: 'requestListSnapshot' });
  assert.equal(delivered.length, 1, 'the ready renderer receives the unchanged current model');
  await host.pushSnapshot();
  assert.equal(delivered.length, 1, 'passive unchanged updates remain deduplicated');
  await host.onMessage({ type: 'requestListSnapshot' });
  assert.equal(delivered.length, 2, 'a reloaded renderer can request the same model again');
  await host.pushSnapshot();
  assert.equal(delivered.length, 2, 'reload recovery preserves passive deduplication');
  host.buildModel = () => ({ rows: [], loading: true });
  await host.onMessage({ type: 'requestListSnapshot' });
  assert.equal(delivered.length, 2, 'resync during refresh does not flash loading');
  host.buildModel = () => ({ rows: [], loading: false });
  await host.pushSnapshot();
  assert.equal(delivered.length, 3, 'refresh completion answers the deferred resync');
  host.snapshotState = { hasShownRealData: false };
  host.buildModel = () => ({ rows: [], loading: true });
  await host.pushSnapshot();
  host.buildModel = () => ({ rows: [], loading: false });
  await host.pushSnapshot();
  assert.equal(delivered.length, 5, 'first empty ready state replaces initial loading');
});
