import { createHash } from 'node:crypto';

// Never return provider configuration, request headers, auth or arbitrary metadata.
export function modelDto(model) {
  if (!model) return model;
  if (typeof model.provider !== 'string' || typeof model.id !== 'string')
    throw new Error('INVALID_MODEL_IDENTITY');
  const result = { provider: model.provider, id: model.id };
  if (typeof model.name === 'string') result.name = model.name;
  if (typeof model.reasoning === 'boolean') result.reasoning = model.reasoning;
  if (Array.isArray(model.input))
    result.input = model.input.filter((v) => v === 'text' || v === 'image');
  for (const key of ['contextWindow', 'maxTokens'])
    if (Number.isFinite(model[key])) result[key] = model[key];
  if (model.cost) {
    result.cost = {};
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite'])
      if (Number.isFinite(model.cost[key])) result.cost[key] = model.cost[key];
  }
  return result;
}
const levels = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const refDto = ({ model, thinkingLevel }) => ({
  provider: model.provider,
  id: model.id,
  ...(levels.has(thinkingLevel) ? { thinkingLevel } : {}),
});
const failure = (code) => {
  throw new Error(code);
};

// The runner's existing per-session dispatch gate; safe queries never wait on it.
export function scopeCommandDispatcher(handle) {
  let queue = Promise.resolve();
  const ordered = new Set([
    'set_scoped_models',
    'save_scoped_models_default',
    'save_preference',
    'set_steering_mode',
    'set_follow_up_mode',
    'set_auto_compaction',
    'set_auto_retry',
    'set_model',
    'cycle_model',
    'set_thinking_level',
    'cycle_thinking_level',
    'new_session',
    'switch_session',
    'fork',
    'clone',
  ]);
  return (command) => {
    if (!ordered.has(command.type)) return handle(command);
    const result = queue.then(() => handle(command));
    queue = result.catch(() => {});
    return result;
  };
}

/** Only 0.99.1 public session/storage APIs + audited pure native resolver.
 * A fresh SettingsManager reads disk without reloading session defaults/resources.
 * Native locked merge/write is NOT crash-atomic. Session commit follows flush.
 */
export function createScopeOperations(
  getSession,
  freshSettings,
  resolvePatterns,
  startupPatterns = null
) {
  let queue = Promise.resolve();
  const identities = new WeakMap();
  let nextIdentity = 0;
  const identity = (value) => {
    if (!value || (typeof value !== 'object' && typeof value !== 'function')) return null;
    if (!identities.has(value)) identities.set(value, ++nextIdentity);
    return identities.get(value);
  };
  function read() {
    const session = getSession();
    const settings = freshSettings();
    if (settings.drainErrors().length) failure('SCOPES_SETTINGS_READ_FAILED');
    const models = [...session.modelRuntime.getAvailableSnapshot()];
    const globalPatterns = settings.getGlobalSettings().enabledModels ?? null;
    const projectPatterns = settings.getProjectSettings().enabledModels ?? null;
    const effectivePatterns = settings.getEnabledModels() ?? null;
    const scoped = [...session.scopedModels].map(refDto);
    const diagnostics = (patterns) =>
      patterns
        ? resolvePatterns(patterns, models).diagnostics.map(({ code, pattern }) => ({
            code,
            pattern,
          }))
        : [];
    const data = {
      models: models.map(modelDto),
      scoped,
      globalPatterns,
      projectPatterns,
      effectivePatterns,
      startupPatterns: startupPatterns ? [...startupPatterns] : null,
      patternSource:
        startupPatterns !== null ? 'cli' : projectPatterns !== null ? 'project' : 'global',
      projectOverride: projectPatterns !== null,
      diagnostics: diagnostics(startupPatterns ?? effectivePatterns),
      globalDiagnostics: diagnostics(globalPatterns),
    };
    // Private revision inputs are deliberately not wire fields. Session IDs (not
    // leaves) also cover native in-memory new/switch operations on the same object.
    const context = {
      session: identity(session),
      manager: identity(session.sessionManager),
      sessionId: session.sessionId ?? null,
      model: session.model ? [session.model.provider, session.model.id] : null,
      thinking: session.thinkingLevel ?? null,
    };
    const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
    const revision = hash({ data, context });
    const commitGuard = hash({
      context,
      models: data.models,
      scoped,
      projectPatterns,
      startupPatterns: data.startupPatterns,
    });
    return { session, settings, models, commitGuard, data: { ...data, revision } };
  }
  function set(command, save) {
    const run = queue.then(async () => {
      const { session, settings, models, data, commitGuard } = read();
      if (command.expectedRevision !== data.revision) failure('SCOPES_STALE_REVISION');
      if (command.refs !== null && !Array.isArray(command.refs))
        failure('SCOPES_INVALID_SELECTION');
      const refs = command.refs ?? [];
      const seen = new Set();
      const selected = refs.map((ref) => {
        if (
          !ref ||
          typeof ref.provider !== 'string' ||
          typeof ref.id !== 'string' ||
          (ref.thinkingLevel !== undefined && !levels.has(ref.thinkingLevel))
        )
          failure('SCOPES_INVALID_SELECTION');
        const key = JSON.stringify([ref.provider, ref.id]);
        if (seen.has(key)) failure('SCOPES_INVALID_SELECTION');
        seen.add(key);
        const model = models.find((m) => m.provider === ref.provider && m.id === ref.id);
        if (!model) failure('SCOPES_MODEL_UNAVAILABLE');
        return {
          model,
          ...(ref.thinkingLevel !== undefined ? { thinkingLevel: ref.thinkingLevel } : {}),
        };
      });
      // Null/all/empty is the native unrestricted scope; no current/default model mutation.
      const scope = selected.length === models.length ? [] : selected;
      if (save) {
        const patterns = scope.map(
          ({ model, thinkingLevel }) =>
            `${model.provider}/${model.id}${thinkingLevel ? ':' + thinkingLevel : ''}`
        );
        // Native exact colon IDs take precedence over thinking suffixes. Refuse a
        // save whose textual representation would restart as a different scope.
        if (
          patterns.length &&
          JSON.stringify(resolvePatterns(patterns, models).scopedModels.map(refDto)) !==
            JSON.stringify(scope.map(refDto))
        )
          failure('SCOPES_PATTERN_AMBIGUOUS');
        // Keep unavailable global patterns unless user explicitly acknowledges replacement.
        if (data.globalDiagnostics.length && command.replaceUnavailable !== true)
          failure('SCOPES_UNAVAILABLE_PATTERNS_REQUIRE_CONFIRMATION');
        settings.setEnabledModels(patterns);
        await settings.flush();
        if (settings.drainErrors().length) failure('SCOPES_SETTINGS_WRITE_FAILED');
        // Out-of-band SDK callbacks/catalog refreshes are not governed by dispatch.
        // Defaults have already been flushed: never imply rollback or overwrite a
        // concurrent chat's settings. Report that explicit outcome and don't retarget.
        let current;
        try {
          current = read();
        } catch {
          failure('SCOPES_DEFAULT_SAVED_SESSION_NOT_APPLIED');
        }
        const patternsNow = current.data.globalPatterns;
        if (
          current.commitGuard !== commitGuard ||
          JSON.stringify(patternsNow) !== JSON.stringify(patterns)
        )
          failure('SCOPES_DEFAULT_SAVED_SESSION_NOT_APPLIED');
      }
      session.setScopedModels(scope.map((entry) => ({ ...entry })));
      return read().data;
    });
    queue = run.catch(() => {});
    return run;
  }
  return { read: () => read().data, set: (c) => set(c, false), save: (c) => set(c, true) };
}
