import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const backend = () => import(pathToFileURL(resolve('host/scoped-models.mjs')).href);

function setup(create: any) {
  const models = [
    { provider: 'a', id: 'one' },
    { provider: 'a', id: 'two' },
  ];
  let scoped: any[] = [];
  let enabled: string[] | undefined;
  let release!: () => void;
  let entered!: () => void;
  const flushing = new Promise<void>((r) => {
    entered = r;
  });
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const session = {
    sessionId: 'in-memory-one',
    model: models[0],
    thinkingLevel: 'off',
    modelRuntime: { getAvailableSnapshot: () => models },
    get scopedModels() {
      return scoped;
    },
    setScopedModels(value: any[]) {
      scoped = value;
    },
  };
  const ops = create(
    () => session,
    () => ({
      drainErrors: () => [],
      getGlobalSettings: () => ({ enabledModels: enabled }),
      getProjectSettings: () => ({}),
      getEnabledModels: () => enabled,
      setEnabledModels: (value: string[]) => {
        enabled = value;
      },
      flush: async () => {
        entered();
        await gate;
      },
    }),
    () => ({ diagnostics: [], scopedModels: [{ model: models[1] }] })
  );
  return {
    ops,
    session,
    models,
    flushing,
    release,
    get enabled() {
      return enabled;
    },
  };
}

for (const mutation of ['cycle_model', 'set_model', 'new_session'])
  test(`scope runner orders ${mutation} after awaited default flush; queries bypass`, async () => {
    const { createScopeOperations, scopeCommandDispatcher } = await backend();
    const f = setup(createScopeOperations);
    const events: string[] = [];
    const dispatch = scopeCommandDispatcher(async (command: any) => {
      if (command.type === 'save_scoped_models_default') {
        const result = await f.ops.save(command);
        events.push('committed');
        return result;
      }
      if (command.type === 'get_scoped_models') return f.ops.read();
      events.push(mutation);
      if (mutation === 'new_session') f.session.sessionId = 'in-memory-two';
      else f.session.model = f.models[1];
    });
    const before = f.ops.read();
    const save = dispatch({
      type: 'save_scoped_models_default',
      expectedRevision: before.revision,
      refs: [{ provider: 'a', id: 'two' }],
    });
    await f.flushing;
    const change = dispatch({ type: mutation });
    await dispatch({ type: 'get_scoped_models' });
    assert.deepEqual(events, []);
    assert.deepEqual(f.session.scopedModels, []);
    f.release();
    await save;
    await change;
    assert.deepEqual(events, ['committed', mutation]);
    assert.deepEqual(f.enabled, ['a/two']);
    await assert.rejects(
      f.ops.set({ expectedRevision: before.revision, refs: [] }),
      /STALE_REVISION/
    );
  });

for (const source of ['model', 'thinking', 'session', 'catalog'])
  test(`scope save revalidates out-of-band ${source}, with explicit persisted-default outcome`, async () => {
    const { createScopeOperations } = await backend();
    const f = setup(createScopeOperations);
    const before = f.ops.read();
    assert.equal(f.ops.read().revision, before.revision);
    const save = f.ops.save({
      expectedRevision: before.revision,
      refs: [{ provider: 'a', id: 'two' }],
    });
    await f.flushing;
    if (source === 'model') f.session.model = f.models[1];
    if (source === 'thinking') f.session.thinkingLevel = 'high';
    if (source === 'session') f.session.sessionId = 'in-memory-two';
    if (source === 'catalog') f.models.push({ provider: 'b', id: 'new' });
    assert.notEqual(f.ops.read().revision, before.revision);
    f.release();
    await assert.rejects(save, /^Error: SCOPES_DEFAULT_SAVED_SESSION_NOT_APPLIED$/);
    assert.deepEqual(f.session.scopedModels, []);
    assert.deepEqual(f.enabled, ['a/two'], 'no invented rollback of persisted defaults');
  });
