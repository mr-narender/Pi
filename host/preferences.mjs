import { createHash } from 'node:crypto';
import { modelDto } from './scoped-models.mjs';

const levels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
// Deliberately finite inventory: no configuration objects, headers, resources or auth.
const fields = [
  [
    'compaction',
    'Automatic compaction',
    'getCompactionEnabled',
    'setCompactionEnabled',
    ['compaction', 'enabled'],
    [false, true],
    'live',
    'setAutoCompactionEnabled',
  ],
  [
    'retry',
    'Automatic retry',
    'getRetryEnabled',
    'setRetryEnabled',
    ['retry', 'enabled'],
    [false, true],
    'live',
    'setAutoRetryEnabled',
  ],
  [
    'steeringMode',
    'Steering queue mode',
    'getSteeringMode',
    'setSteeringMode',
    ['steeringMode'],
    ['all', 'one-at-a-time'],
    'live',
    'setSteeringMode',
  ],
  [
    'followUpMode',
    'Follow-up queue mode',
    'getFollowUpMode',
    'setFollowUpMode',
    ['followUpMode'],
    ['all', 'one-at-a-time'],
    'live',
    'setFollowUpMode',
  ],
  [
    'transport',
    'Provider transport',
    'getTransport',
    'setTransport',
    ['transport'],
    ['auto', 'sse', 'websocket', 'websocket-cached'],
    'live',
  ],
  [
    'httpIdleTimeoutMs',
    'HTTP idle timeout (ms)',
    'getHttpIdleTimeoutMs',
    'setHttpIdleTimeoutMs',
    ['httpIdleTimeoutMs'],
    null,
    'next-start',
  ],
  [
    'cacheWarming',
    'Cache warming (GLOBAL ONLY; may cost money)',
    'getCacheWarmingMode',
    'setCacheWarmingMode',
    ['cacheWarming'],
    ['off', 'streaming', 'idle'],
    'live',
    'setCacheWarmingMode',
  ],
  [
    'imageAutoResize',
    'Resize model input images',
    'getImageAutoResize',
    'setImageAutoResize',
    ['images', 'autoResize'],
    [false, true],
    'live',
  ],
  [
    'blockImages',
    'Block model input images',
    'getBlockImages',
    'setBlockImages',
    ['images', 'blockImages'],
    [false, true],
    'live',
  ],
  [
    'enableSkillCommands',
    'Skill commands (resource UI may need next start)',
    'getEnableSkillCommands',
    'setEnableSkillCommands',
    ['enableSkillCommands'],
    [false, true],
    'next-start',
  ],
  [
    'defaultProjectTrust',
    'Default project trust (GLOBAL ONLY; not current trust)',
    'getDefaultProjectTrust',
    'setDefaultProjectTrust',
    ['defaultProjectTrust'],
    ['ask', 'always', 'never'],
    'next-start',
  ],
  [
    'enableInstallTelemetry',
    'Install/update telemetry (not analytics)',
    'getEnableInstallTelemetry',
    'setEnableInstallTelemetry',
    ['enableInstallTelemetry'],
    [false, true],
    'next-start',
  ],
  [
    'anthropicExtraUsage',
    'Anthropic paid extra-usage warning',
    'getWarnings',
    'setWarnings',
    ['warnings', 'anthropicExtraUsage'],
    [false, true],
    'next-start',
  ],
];
const terminal = [
  'show-images',
  'image-width-cells',
  'show-hardware-cursor',
  'editor-padding',
  'output-padding',
  'autocomplete-max-visible',
  'clear-on-shrink',
  'terminal-progress',
  'hide-thinking',
  'mermaid-rendering',
  'cache-miss-notices',
  'collapse-changelog',
  'quiet-startup',
  'double-escape-action',
  'tree-filter-mode',
  'tui-mode',
  'fullscreen-exit-output',
  'fullscreen-scrollbar',
  'fullscreen-copy-on-select',
  'fullscreen-wheel-scroll-lines',
  'theme',
];
const fail = (code) => {
  throw new Error(`PREFERENCES_${code}`);
};
const at = (obj, path) => path.reduce((v, k) => v?.[k], obj);
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
// Every runner shares this default-write queue. Other default writes use the same
// host dispatch gate; disk drift remains part of the private full revision.
let writes = Promise.resolve();
export function serializePreferenceDefaults(action) {
  const result = writes.then(action);
  writes = result.catch(() => {});
  return result;
}
export function createPreferenceOperations(getSession, freshSettings, provenance = {}, thinking) {
  const safeThinking = (value) => (levels.includes(value) ? value : null);
  const supported = (model) =>
    model.reasoning ? thinking.getSupportedThinkingLevels(model) : ['off'];
  const identities = new WeakMap();
  let next = 0;
  const identity = (obj) => {
    if (!identities.has(obj)) identities.set(obj, ++next);
    return identities.get(obj);
  };
  function read() {
    const session = getSession();
    const settings = freshSettings();
    if (settings.drainErrors().length || provenance.initialSettingsError) fail('READ_FAILED');
    const global = settings.getGlobalSettings(),
      project = settings.getProjectSettings();
    const active = session.settingsManager;
    const startup = provenance.overrides ?? {};
    const rows = fields.map(([key, label, getter, , path, choices, effect]) => {
      const globalOnly = key === 'cacheWarming' || key === 'defaultProjectTrust';
      const value = (m) =>
        key === 'anthropicExtraUsage' ? (m.getWarnings().anthropicExtraUsage ?? true) : m[getter]();
      let live = value(active);
      if (key === 'steeringMode') live = session.steeringMode;
      if (key === 'followUpMode') live = session.followUpMode;
      if (key === 'transport') live = session.agent.transport;
      const valid = (v) => (choices ? choices.includes(v) : Number.isSafeInteger(v) && v >= 0);
      const safe = (v) => (valid(v) ? v : null);
      const cli = at(startup, path);
      return {
        key,
        label,
        choices,
        effect,
        global: safe(at(global, path)),
        project: safe(at(project, path)),
        effective: safe(globalOnly ? value(settings) : (cli ?? value(settings))),
        active: safe(live),
        source: globalOnly
          ? 'global-only'
          : cli !== undefined
            ? 'startup'
            : at(project, path) !== undefined
              ? 'project'
              : 'global',
      };
    });
    const models = session.modelRuntime.getAvailableSnapshot();
    for (const model of models) {
      const ref = `${model.provider}/${model.id}`;
      rows.push({
        key: `modelThinking:${ref}`,
        label: `Per-model thinking: ${ref}`,
        choices: [null, ...supported(model)],
        effect: 'model-default',
        global: levels.includes(global.modelThinkingLevels?.[ref])
          ? global.modelThinkingLevels[ref]
          : null,
        project: levels.includes(project.modelThinkingLevels?.[ref])
          ? project.modelThinkingLevels[ref]
          : null,
        effective: (() => {
          const perModel = settings.getModelThinkingLevel(model.provider, model.id);
          const fallback = settings.getDefaultThinkingLevel();
          const raw =
            perModel !== undefined ? perModel : fallback !== undefined ? fallback : 'medium';
          const valid = safeThinking(raw);
          return valid === null ? null : thinking.clampThinkingLevel(model, valid);
        })(),
        active:
          session.model?.provider === model.provider && session.model?.id === model.id
            ? safeThinking(session.thinkingLevel)
            : null,
        // CLI session thinking is an active choice, not the effective saved
        // model default. Follow the same merged-key selection as the getters,
        // including defaultThinkingLevel only when no model override exists.
        source:
          settings.getModelThinkingLevel(model.provider, model.id) !== undefined
            ? startup.modelThinkingLevels?.[ref] !== undefined
              ? 'startup'
              : project.modelThinkingLevels?.[ref] !== undefined
                ? 'project'
                : 'global'
            : startup.defaultThinkingLevel !== undefined
              ? 'startup'
              : project.defaultThinkingLevel !== undefined
                ? 'project'
                : global.defaultThinkingLevel !== undefined
                  ? 'global'
                  : 'native-default',
      });
    }
    const context = {
      session: identity(session),
      manager: identity(session.sessionManager),
      id: session.sessionId,
      model: session.model ? [session.model.provider, session.model.id] : null,
      thinking: session.thinkingLevel,
      active: rows.map((r) => r.active),
    };
    const revision = digest({ global, project, startup, context });
    return {
      session,
      settings,
      global,
      project,
      context,
      data: { revision, rows, terminalOnly: terminal, models: models.map(modelDto) },
    };
  }
  async function save(command) {
    // Reject unknown wire fields before any native mutation.
    if (
      !command ||
      Object.keys(command).some(
        (k) =>
          ![
            'id',
            'type',
            'key',
            'value',
            'expectedRevision',
            'confirmGlobal',
            'confirmPaid',
          ].includes(k)
      ) ||
      command.confirmGlobal !== true ||
      typeof command.key !== 'string' ||
      typeof command.expectedRevision !== 'string'
    )
      fail('INVALID');
    return serializePreferenceDefaults(async () => {
      const before = read();
      const { session, settings, global, data } = before;
      if (command.expectedRevision !== data.revision) fail('STALE_REVISION');
      if (
        !session.isIdle ||
        session.isStreaming ||
        session.isCompacting ||
        session.isRetrying ||
        session.isBashRunning ||
        session.pendingMessageCount ||
        session.hasPendingBashMessages
      )
        fail('BUSY');
      const field = fields.find((f) => f[0] === command.key);
      const row = data.rows.find((r) => r.key === command.key);
      if (
        !row ||
        (row.choices
          ? !row.choices.includes(command.value)
          : !Number.isSafeInteger(command.value) || command.value < 0)
      )
        fail('INVALID');
      if (command.key === 'cacheWarming' && command.value !== 'off' && command.confirmPaid !== true)
        fail('INVALID_PAID_CONSENT');
      // Initial native manager errors were retained at construction, not inferred
      // from drainErrors after save (parse suppression may never report again).
      const live = session.settingsManager;
      if (live.drainErrors().length) fail('READ_FAILED');
      const value = command.value;
      let writer = live;
      if (field) {
        const [key, , , setter, , , , sessionSetter] = field;
        if (key === 'anthropicExtraUsage')
          live.setWarnings({ ...global.warnings, anthropicExtraUsage: value });
        else if (sessionSetter) session[sessionSetter](value);
        else live[setter](value);
      } else {
        const model = data.models.find(
          (m) => command.key === `modelThinking:${m.provider}/${m.id}`
        );
        if (!model) fail('INVALID');
        writer = settings;
        if (value === null) settings.removeModelThinkingLevel(model.provider, model.id);
        else settings.setModelThinkingLevel(model.provider, model.id, value);
      }
      await writer.flush();
      // save() recomputes the merge and discards applyOverrides. Provenance is
      // captured independently at startup; never guess overrides from differences.
      live.applyOverrides(provenance.overrides ?? {});
      if (writer.drainErrors().length) fail('WRITE_FAILED');
      let after;
      try {
        after = read();
      } catch {
        fail('WRITE_FAILED');
      }
      const persisted = after.data.rows.find((r) => r.key === command.key);
      if (!persisted || persisted.global !== value) fail('WRITE_FAILED');
      if (
        after.session !== session ||
        after.context.id !== before.context.id ||
        JSON.stringify(after.context.model) !== JSON.stringify(before.context.model) ||
        after.context.thinking !== before.context.thinking
      )
        fail('SAVED_SESSION_NOT_APPLIED');
      if (field?.[0] === 'transport') session.agent.transport = value;
      if (!field) {
        // applyOverrides deep-merges dictionaries, so an empty fresh map alone
        // cannot remove a deleted key. Reset only this private dictionary before
        // applying its fresh merged replacement; no reload or unrelated override.
        live.applyOverrides({ modelThinkingLevels: null });
        live.applyOverrides({
          modelThinkingLevels: after.settings.getSettings().modelThinkingLevels ?? {},
        });
        live.applyOverrides(provenance.overrides ?? {});
        const model = session.model;
        if (model && command.key === `modelThinking:${model.provider}/${model.id}`) {
          const perModel = live.getModelThinkingLevel(model.provider, model.id);
          const fallback = live.getDefaultThinkingLevel();
          const requested =
            perModel !== undefined ? perModel : fallback !== undefined ? fallback : 'medium';
          // Invalid stored defaults are not valid preferences. Leave runtime alone;
          // the snapshot projects null, rather than passing arbitrary data to SDK.
          const valid = safeThinking(requested);
          if (valid !== null) session.setThinkingLevel(valid, { persist: false });
        }
      }
      return read().data;
    });
  }
  const sanitizedFailure = (error, fallback) => {
    // Never serialize native getter/storage exceptions or arbitrary metadata.
    if (/^PREFERENCES_[A-Z_]+$/.test(error?.message ?? '')) throw error;
    fail(fallback);
  };
  return {
    read: () => {
      try {
        return read().data;
      } catch (error) {
        sanitizedFailure(error, 'READ_FAILED');
      }
    },
    save: async (command) => {
      try {
        return await save(command);
      } catch (error) {
        sanitizedFailure(error, 'WRITE_FAILED');
      }
    },
  };
}
