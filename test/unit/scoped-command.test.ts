import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { createEmptyComposerState } from '../../src/webview/composer';
import { createNativeFixture, nativeSdkHostPlan } from '../helpers/nativeFixture';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { selectedSdkRoot } from '../../src/process/piLauncher';
import { parseScopedModelsSnapshot } from '../../src/rpc/protocol';

test('scopes: canonical command rejects malformed arguments locally', async () => {
  const bundle = await build({
    entryPoints: ['src/commands/localCommand.ts'],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    external: ['vscode'],
  });
  const mod = { exports: {} as any };
  new Function('require', 'module', 'exports', bundle.outputFiles[0]!.text)(
    () => ({}),
    mod,
    mod.exports
  );
  const state = createEmptyComposerState();
  state.draft = '/scoped-models extra';
  const controller = { snapshot: { state: { sessionId: 'origin' } } };
  await mod.exports.handleLocalCommand(
    controller,
    state,
    async () => state,
    async () => {},
    async () => {}
  );
  assert.match(state.recovery!.detail, /does not accept arguments/);
  assert.equal(state.draft, '/scoped-models extra');
});

test('scopes DTO rejects secret-bearing model/diagnostic/top-level fields', () => {
  const valid = {
    models: [{ provider: 'a', id: 'one' }],
    scoped: [],
    revision: 'r',
    globalPatterns: null,
    projectPatterns: null,
    effectivePatterns: null,
    projectOverride: false,
    diagnostics: [],
    globalDiagnostics: [],
  };
  assert.deepEqual(parseScopedModelsSnapshot(valid), valid);
  for (const unsafe of [
    { ...valid, apiKey: 'secret' },
    { ...valid, models: [{ ...valid.models[0], headers: { Authorization: 'secret' } }] },
    {
      ...valid,
      diagnostics: [{ code: 'no-match', pattern: 'a', credential: { token: 'secret' } }],
    },
  ])
    assert.throws(() => parseScopedModelsSnapshot(unsafe), /Unsafe/);
});

test('scopes host fixture rejects foreign identity and modified repo-owned assets, freezes spawn capabilities', async () => {
  const fixture = await createNativeFixture('scopes');
  try {
    await assert.rejects(nativeSdkHostPlan({ ...fixture } as any, 'shared'), /Unowned/);
    const plan = await nativeSdkHostPlan(fixture, 'dedicated');
    assert.equal(Object.isFrozen(plan), true);
    assert.equal(Object.isFrozen(plan.env), true);
    assert.equal(Object.isFrozen(plan.args), true);
    assert.ok(!plan.args.some((a) => /allow-worker|allow-child/.test(a)));
    const wrapper = join(fixture.cwd, 'unknown-wrapper');
    await writeFile(wrapper, 'Not an npm JavaScript CLI');
    assert.equal(
      selectedSdkRoot({ piSource: 'external', executable: wrapper } as any),
      undefined,
      'unknown selected executable never substitutes PATH SDK'
    );
    await writeFile(join(fixture.root, 'scoped-models.mjs'), 'forged');
    await assert.rejects(nativeSdkHostPlan(fixture, 'shared'), /host asset mutation/);
  } finally {
    await fixture.dispose();
  }
});
