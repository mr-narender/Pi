import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { transform } from 'esbuild';

async function deleteCommandFixture() {
  const source = readFileSync('src/extension.ts', 'utf8');
  const start = source.indexOf("  registrations.set('piRpcInternal.deleteSession'");
  const end = source.indexOf("  registrations.set('piRpcInternal.refreshRecentSessions'", start);
  assert.ok(start >= 0 && end > start);
  const compiled = await transform(source.slice(start, end), { loader: 'ts' });
  const events: string[] = [];
  let close: () => Promise<void> = async () => {
    events.push('close');
  };
  let removeFile: () => Promise<void> = async () => {
    events.push('delete');
  };
  const registrations = new Map<string, (arg: unknown) => Promise<void>>();
  new Function(
    'registrations',
    'vscode',
    'chatTabs',
    'recentSessions',
    'refreshViews',
    'asRecord',
    'asString',
    compiled.code
  )(
    registrations,
    { Uri: { file: (path: string) => path }, workspace: { fs: { delete: () => removeFile() } } },
    {
      closeForSessionFile: () => close(),
      stopControllersForSessionFile: () => events.push('stop'),
    },
    {
      removePath: () => events.push('remove-cache'),
      refresh: async () => events.push('scan'),
    },
    () => events.push('refresh-views'),
    (value: unknown) => value,
    (value: unknown) => (typeof value === 'string' ? value : undefined)
  );
  return {
    run: () => registrations.get('piRpcInternal.deleteSession')!({ sessionPath: '/s/a.jsonl' }),
    events,
    setClose: (callback: typeof close) => (close = callback),
    setDelete: (callback: typeof removeFile) => (removeFile = callback),
  };
}

test('delete command cannot claim success after refused tab close or file failure', async () => {
  const fixture = await deleteCommandFixture();
  fixture.setClose(async () => {
    throw new Error('close refused');
  });
  await assert.rejects(fixture.run(), /close refused/);
  assert.deepEqual(fixture.events, []);

  fixture.setClose(async () => {
    fixture.events.push('close');
  });
  fixture.setDelete(async () => {
    fixture.events.push('delete');
    throw new Error('disk denied');
  });
  await assert.rejects(fixture.run(), /disk denied/);
  assert.deepEqual(fixture.events, ['close', 'stop', 'delete']);
});

test('delete command removes cache only after file delete succeeds', async () => {
  const fixture = await deleteCommandFixture();
  await fixture.run();
  assert.deepEqual(fixture.events.slice(0, 4), ['close', 'stop', 'delete', 'remove-cache']);
});
