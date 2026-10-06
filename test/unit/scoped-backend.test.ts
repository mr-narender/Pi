import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

test('scopes SDK capability gate rejects mismatched package/version and missing actual API shape', async () => {
  const { validateSdkMetadata, validateSdkApi } = await import(
    pathToFileURL(resolve('host/startup-adapter.mjs')).href
  );
  validateSdkMetadata({ name: '@earendil-works/pi-coding-agent', version: '0.99.1' });
  validateSdkMetadata({ name: '@earendil-works/pi-coding-agent', version: '0.99.2' });
  validateSdkMetadata({ name: '@earendil-works/pi-coding-agent', version: '1.0.4' });
  for (const metadata of [
    { name: 'unknown', version: '0.99.1' },
    { name: '@earendil-works/pi-coding-agent', version: '0.99.3' },
    {},
  ])
    assert.throws(() => validateSdkMetadata(metadata), /SDK_HOST_VERSION_UNSUPPORTED/);
  assert.throws(() => validateSdkApi({}), /SDK_HOST_API_UNSUPPORTED/);
});

test('scopes backend: copy both directions, stable revision, catalog drift, malformed refs and failed flush retain session', async () => {
  const { createScopeOperations, modelDto } = await import(
    pathToFileURL(resolve('host/scoped-models.mjs')).href
  );
  const models = [
    {
      provider: 'a',
      id: 'one',
      name: 'One',
      apiKey: 'SECRET',
      headers: { Authorization: 'SECRET' },
      baseUrl: 'SECRET',
      cost: { input: 1, unknown: 'SECRET' },
    },
    { provider: 'b', id: 'two' },
    { provider: 'c', id: 'three' },
  ];
  let scoped = [{ model: models[1], thinkingLevel: 'high' }];
  let enabled: string[] | undefined;
  let failRead = false;
  let failWrite = false;
  let flushed = false;
  const settings = () => ({
    drainErrors: () =>
      failRead || (flushed && failWrite) ? [{ error: new Error('credential-object-secret') }] : [],
    getGlobalSettings: () => ({ enabledModels: enabled }),
    getProjectSettings: () => ({}),
    getEnabledModels: () => enabled,
    setEnabledModels: (p: string[]) => {
      enabled = p;
    },
    flush: async () => {
      flushed = true;
    },
  });
  const session = {
    modelRuntime: { getAvailableSnapshot: () => models },
    get scopedModels() {
      return scoped;
    },
    setScopedModels: (value: any) => {
      scoped = value;
    },
  };
  const operations = createScopeOperations(
    () => session,
    settings,
    () => ({ diagnostics: [] })
  );
  const first = operations.read();
  first.scoped[0].thinkingLevel = 'off';
  first.models[0].name = 'Changed';
  assert.equal(scoped[0]!.thinkingLevel, 'high');
  assert.equal(models[0]!.name, 'One');
  assert.equal(operations.read().revision, first.revision);
  assert.ok(!JSON.stringify(modelDto(models[0])).includes('SECRET'));
  const refs = [
    { provider: 'b', id: 'two', thinkingLevel: 'high' },
    { provider: 'a', id: 'one' },
  ];
  const next = await operations.set({ refs, expectedRevision: first.revision });
  refs[0]!.thinkingLevel = 'off';
  assert.equal(scoped[0]!.thinkingLevel, 'high');
  assert.deepEqual(
    next.scoped.map((r: any) => r.provider),
    ['b', 'a']
  );
  await assert.rejects(
    operations.set({ refs: [{ provider: 'missing', id: 'bad' }], expectedRevision: next.revision }),
    /MODEL_UNAVAILABLE/
  );
  await assert.rejects(
    operations.set({
      refs: [{ provider: 'a', id: 'one', thinkingLevel: 'invalid' }],
      expectedRevision: next.revision,
    }),
    /INVALID_SELECTION/
  );
  await assert.rejects(
    operations.set({ refs: [refs[1], refs[1]], expectedRevision: next.revision }),
    /INVALID_SELECTION/
  );
  models[0]!.name = 'catalog drift';
  await assert.rejects(
    operations.set({ refs: [], expectedRevision: next.revision }),
    /STALE_REVISION/
  );
  failRead = true;
  assert.throws(() => operations.read(), /SETTINGS_READ_FAILED/);
  failRead = false;
  failWrite = true;
  await assert.rejects(
    operations.save({ refs: [], expectedRevision: operations.read().revision }),
    /^Error: SCOPES_SETTINGS_WRITE_FAILED$/
  );
  assert.equal(scoped.length, 2, 'flush error prevents staged session commit');
  failWrite = false;
  const unrestricted = await operations.set({
    refs: null,
    expectedRevision: operations.read().revision,
  });
  assert.deepEqual(unrestricted.scoped, []);
});
