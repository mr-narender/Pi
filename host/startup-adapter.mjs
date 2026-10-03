import * as path from 'node:path';

export function validateSdkMetadata(metadata) {
  if (
    metadata.name !== '@earendil-works/pi-coding-agent' ||
    !['0.99.1', '0.99.2', '1.0.0'].includes(metadata.version)
  )
    throw new Error('SDK_HOST_VERSION_UNSUPPORTED');
}

export function validateSdkApi(sdk) {
  for (const name of [
    'parseArgs',
    'createAgentSessionServices',
    'createAgentSessionFromServices',
    'createAgentSessionRuntime',
    'resolveCliModel',
    'createCodemodeExtension',
    'createToolSearchExtension',
    'createMcpExtension',
  ])
    if (typeof sdk[name] !== 'function') throw new Error('SDK_HOST_API_UNSUPPORTED');
  if (
    typeof sdk.ModelRuntime?.prototype?.getAvailableSnapshot !== 'function' ||
    typeof sdk.AgentSession?.prototype?.setScopedModels !== 'function' ||
    typeof sdk.AgentSession?.prototype?.getAvailableThinkingLevels !== 'function' ||
    typeof sdk.AgentSession?.prototype?.setThinkingLevel !== 'function' ||
    typeof Object.getOwnPropertyDescriptor(sdk.AgentSession?.prototype ?? {}, 'scopedModels')
      ?.get !== 'function'
  )
    throw new Error('SDK_HOST_API_UNSUPPORTED');
  for (const name of ['newSession', 'switchSession', 'fork', 'dispose'])
    if (typeof sdk.AgentSessionRuntime?.prototype?.[name] !== 'function')
      throw new Error('SDK_HOST_API_UNSUPPORTED');
  for (const name of [
    'setEnabledModels',
    'getEnabledModels',
    'getGlobalSettings',
    'getProjectSettings',
    'flush',
    'drainErrors',
  ])
    if (typeof sdk.SettingsManager?.prototype?.[name] !== 'function')
      throw new Error('SDK_HOST_API_UNSUPPORTED');
}

/** Startup contract re-assessed against SDK 1.0.0; original audit:
 * SDK 0.99.1 main.js:353–434,565–694. Exact versions only.
 * Metadata/admin/interactive startup modes are rejected, never ignored.
 * Trust asks have no CLI UI here: unresolved project trust stays denied.
 */
export function createStartupAdapter(sdk, internals) {
  const {
    resolveModelScopeFromModels,
    ProjectTrustStore,
    hasTrustRequiringProjectResources,
    builtInExtensions,
  } = internals;
  const runtimes = new Map();
  return async function build({ cwd, sessionFile, args = ['--mode', 'rpc', '--no-approve'] }) {
    const parsed = sdk.parseArgs(args);
    if (
      parsed.diagnostics.some((d) => d.type === 'error') ||
      parsed.messages.length ||
      parsed.fileArgs.length ||
      parsed.apiKey ||
      parsed.help ||
      parsed.version ||
      parsed.print ||
      parsed.export ||
      parsed.listModels ||
      parsed.resume ||
      parsed.fork ||
      parsed.sessionId ||
      (parsed.mode && parsed.mode !== 'rpc')
    )
      throw new Error('SDK_STARTUP_ARGUMENTS_UNSUPPORTED');
    const agentDir = sdk.getAgentDir();
    const offline = parsed.offline || /^(1|true|yes)$/i.test(process.env.PI_OFFLINE ?? '');
    const bootstrap = sdk.SettingsManager.create(cwd, agentDir, { projectTrusted: false });
    let initialSettingsError = bootstrap.drainErrors().length > 0;
    const sessionDir = parsed.sessionDir
      ? path.resolve(cwd, parsed.sessionDir)
      : process.env.PI_CODING_AGENT_SESSION_DIR || bootstrap.getSessionDir();
    const target = sessionFile ?? parsed.session;
    const sessionManager = target
      ? sdk.SessionManager.open(path.resolve(cwd, target), sessionDir, cwd)
      : parsed.noSession
        ? sdk.SessionManager.inMemory(cwd)
        : parsed.continue
          ? sdk.SessionManager.continueRecent(cwd, sessionDir)
          : sdk.SessionManager.create(cwd, sessionDir);
    if (parsed.name) sessionManager.appendSessionInfo(parsed.name);
    const createRuntime = async (opts) => {
      const trusted =
        parsed.projectTrustOverride ??
        (!hasTrustRequiringProjectResources(opts.cwd) ||
          new ProjectTrustStore(agentDir).get(opts.cwd) === true ||
          bootstrap.getDefaultProjectTrust() === 'always');
      const settingsManager = sdk.SettingsManager.create(opts.cwd, agentDir, {
        projectTrusted: trusted,
      });
      initialSettingsError ||= settingsManager.drainErrors().length > 0;
      // Offline and agentDir partition; no refresh over the network at create time.
      const runtimeKey = JSON.stringify([agentDir, !!offline, opts.cwd, args]);
      if (!runtimes.has(runtimeKey))
        runtimes.set(
          runtimeKey,
          sdk.ModelRuntime.create({
            authPath: path.join(agentDir, 'auth.json'),
            modelsPath: path.join(agentDir, 'models.json'),
            allowModelNetwork: false,
          })
        );
      const modelRuntime = await runtimes.get(runtimeKey);
      const paths = (values) =>
        values?.map((v) =>
          /^(npm:|git:|https?:)/.test(v) || v.startsWith('builtin:') ? v : path.resolve(cwd, v)
        );
      const services = await sdk.createAgentSessionServices({
        cwd: opts.cwd,
        agentDir,
        settingsManager,
        modelRuntime,
        extensionFlagValues: parsed.unknownFlags,
        resourceLoaderOptions: {
          additionalExtensionPaths: paths(parsed.extensions),
          additionalSkillPaths: paths(parsed.skills),
          additionalPromptTemplatePaths: paths(parsed.promptTemplates),
          additionalThemePaths: paths(parsed.themes),
          noExtensions: parsed.noExtensions,
          noSkills: parsed.noSkills,
          noPromptTemplates: parsed.noPromptTemplates,
          noThemes: parsed.noThemes,
          noContextFiles: parsed.noContextFiles,
          systemPrompt: parsed.systemPrompt,
          appendSystemPrompt: parsed.appendSystemPrompt,
          extensionFactories: builtInExtensions,
        },
      });
      const patterns = parsed.models ?? settingsManager.getEnabledModels();
      const scopedModels = patterns?.length
        ? resolveModelScopeFromModels(patterns, modelRuntime.getAvailableSnapshot()).scopedModels
        : [];
      const options = {
        scopedModels,
        tools: parsed.tools,
        excludeTools: parsed.excludeTools,
        noTools: parsed.noTools ? 'all' : parsed.noBuiltinTools ? 'builtin' : undefined,
      };
      if (parsed.model) {
        const resolved = sdk.resolveCliModel({
          cliProvider: parsed.provider,
          cliModel: parsed.model,
          cliThinking: parsed.thinking,
          modelRuntime,
        });
        if (resolved.error) throw new Error('SDK_STARTUP_MODEL_UNAVAILABLE');
        options.model = resolved.model;
        options.thinkingLevel = resolved.thinkingLevel;
      }
      if (
        !options.model &&
        scopedModels.length &&
        !opts.sessionManager.buildSessionContext().messages.length
      ) {
        const saved =
          scopedModels.find(
            ({ model }) =>
              model.provider === settingsManager.getDefaultProvider() &&
              model.id === settingsManager.getDefaultModel()
          ) ?? scopedModels[0];
        options.model = saved.model;
        options.thinkingLevel = saved.thinkingLevel;
      }
      if (parsed.thinking) options.thinkingLevel = parsed.thinking;
      const created = await sdk.createAgentSessionFromServices({
        services,
        sessionManager: opts.sessionManager,
        sessionStartEvent: opts.sessionStartEvent,
        ...options,
      });
      if (parsed.thinking && created.session.model)
        created.session.setThinkingLevel(created.session.thinkingLevel);
      return { ...created, services, diagnostics: services.diagnostics };
    };
    const host = await sdk.createAgentSessionRuntime(createRuntime, {
      cwd,
      agentDir,
      sessionManager,
    });
    host.scopeStartupPatterns = parsed.models ? [...parsed.models] : null;
    // This adapter applies no SettingsManager CLI overrides. Keep typed startup
    // session choices separately: they are not inferred from merged preferences.
    host.preferenceProvenance = {
      get initialSettingsError() {
        return initialSettingsError;
      },
      overrides: {},
      thinking: parsed.thinking ?? null,
      model: parsed.model ? { provider: parsed.provider ?? null, id: parsed.model } : null,
    };
    return host;
  };
}
