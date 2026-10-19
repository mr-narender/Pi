/**
 * RPC mode: Headless operation with JSON stdin/stdout protocol.
 *
 * Used for embedding the agent in other applications.
 * Receives commands as JSON on stdin, outputs events and responses as JSON on stdout.
 *
 * Protocol:
 * - Commands: JSON objects with `type` field, optional `id` for correlation
 * - Responses: JSON objects with `type: "response"`, `command`, `success`, and optional `data`/`error`
 * - Events: AgentSessionEvent objects streamed as they occur
 * - Extension UI: Extension UI requests are emitted, client responds with extension_ui_response
 */
// FORK of vendor/pi/dist/modes/rpc/rpc-mode.js, adapted to host MULTIPLE Pi
// sessions in ONE process on a SHARED ModelRuntime. The per-session command
// logic (handleCommand, dialogs, extension UI) is preserved verbatim; only the
// I/O layer changes: global stdin/stdout -> per-session {k, d} envelopes so N
// sessions multiplex over one stdio pair. Re-sync this file when bumping Pi.
import * as crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createImportCommands } from './import-commands.mjs';
import { createAuthCommands } from './auth-commands.mjs';
import { nativeMcpCommand, readNativeMcpStatus } from './mcp-status.mjs';
import { readModelTools, setModelTools, supportsModelTools } from './model-tools.mjs';
import { discoverOpenRouterModels } from './model-discovery.mjs';
import { createScopeOperations, modelDto, scopeCommandDispatcher } from './scoped-models.mjs';
import { createPreferenceOperations, serializePreferenceDefaults } from './preferences.mjs';
import {
  createStartupAdapter,
  resolveSdkDependencyFile,
  validateSdkMetadata,
  validateSdkApi,
} from './startup-adapter.mjs';
import * as path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

// Pi package root, resolved at RUNTIME (the VSIX no longer vendors Pi):
//   1. workerData.piRoot  — the managed install in globalStorage (production)
//   2. PI_HOST_PI_ROOT    — override for tests
//   3. ../vendor/pi       — dev checkout fallback
let workerPiRoot;
try {
  const { workerData } = await import('node:worker_threads');
  workerPiRoot = workerData && workerData.piRoot;
} catch {
  /* not in a worker */
}
const PI_ROOT =
  workerPiRoot ||
  process.env.PI_HOST_PI_ROOT ||
  fileURLToPath(new URL('../vendor/pi', import.meta.url));
const metadata = JSON.parse(readFileSync(path.join(PI_ROOT, 'package.json'), 'utf8'));
validateSdkMetadata(metadata);
const supportsModelDiscovery = ['1.2.0', '1.3.0'].includes(metadata.version);
const modelToolsPersistence =
  metadata.version === '1.3.0'
    ? 'after-turn'
    : metadata.version === '1.2.0'
      ? 'runtime-only'
      : undefined;
const piImport = (rel) => import(pathToFileURL(path.join(PI_ROOT, rel)).href);
const sdk = await piImport('dist/index.js');
validateSdkApi(sdk);
const { resolveModelScopeFromModels } = await piImport('dist/core/model-resolver.js');
// Use the selected SDK's native dynamic thinking maps, not a GUI approximation.
const thinking = await import(
  pathToFileURL(resolveSdkDependencyFile(PI_ROOT, '@earendil-works/pi-ai/dist/models.js')).href
);
const { builtInExtensions: nativeBuiltins } = await piImport('dist/extensions/index.js');
// The public factories supply the CLI's builtin wrappers; llama.cpp has no public
// factory in 0.99.1, so retain that single audited native builtin entry.
const builtInExtensions = [
  nativeBuiltins[0],
  { name: 'codemode', factory: sdk.createCodemodeExtension(), replaceable: true, builtin: true },
  {
    name: 'tool-search',
    factory: sdk.createToolSearchExtension(),
    replaceable: true,
    builtin: true,
  },
  { name: 'mcp', factory: sdk.createMcpExtension(), replaceable: true, builtin: true },
];
const buildRuntimeHost = createStartupAdapter(sdk, {
  resolveModelScopeFromModels,
  builtInExtensions,
  ProjectTrustStore: sdk.ProjectTrustStore,
  hasTrustRequiringProjectResources: sdk.hasTrustRequiringProjectResources,
});

const { flushRawStdout, takeOverStdout, waitForRawStdoutBackpressure, writeRawStdout } =
  await piImport('dist/core/output-guard.js');
const { killTrackedDetachedChildren } = await piImport('dist/utils/shell.js');
const { theme, initTheme } = await piImport('dist/modes/interactive/theme/theme.js');
const { toJsonEvent } = await piImport('dist/modes/json-event.js');
const { attachJsonlLineReader, serializeJsonLine } = await piImport('dist/modes/rpc/jsonl.js');
/**
 * Run in RPC mode.
 * Listens for JSON commands on stdin, outputs events and responses on stdout.
 */
function createSessionRunner(sessionKey, runtimeHost, hostEmit) {
  let session = runtimeHost.session;
  const dedicated = process.env.PI_HOST_DEDICATED === '1';
  let recoveryRequired = false;
  let enginePending = false;
  const promptPending = new Set();
  const outboxAdmissionRefusal = Symbol('outbox admission refusal');
  const refuseOutbox = (code) => {
    const failure = new Error(code);
    failure[outboxAdmissionRefusal] = true;
    throw failure;
  };
  let activityRevision = 0;
  const widgets = new Set();
  const assertEngineIdle = () => {
    if (recoveryRequired) throw new Error('ENGINE_RECOVERY_REQUIRED');
    if (
      !session.isIdle ||
      session.isStreaming ||
      session.isCompacting ||
      session.isRetrying ||
      session.isBashRunning ||
      session.hasPendingBashMessages ||
      session.pendingMessageCount ||
      compactPending ||
      defaultsPending ||
      enginePending ||
      promptPending.size ||
      lifecyclePending ||
      pendingExtensionRequests.size ||
      widgets.size ||
      (session.cacheWarmingStatus && session.cacheWarmingStatus.state !== 'inactive')
    )
      throw new Error('ENGINE_BUSY_NOTHING_DISCARDED');
  };
  const reloadNative = async () => {
    if (!dedicated) throw new Error('RELOAD_REQUIRES_DEDICATED_OS_PROCESS');
    assertEngineIdle();
    enginePending = true;
    const manager = session.sessionManager;
    const identity = [session.sessionId, session.sessionFile, manager.getLeafId()];
    const history = JSON.stringify(manager.getEntries());
    const transcript = JSON.stringify(session.messages);
    const errors = extensionErrors;
    try {
      await session.reload();
      const resources = runtimeHost.services.resourceLoader;
      if (
        !session.isIdle ||
        session.pendingMessageCount ||
        pendingExtensionRequests.size ||
        widgets.size ||
        (session.cacheWarmingStatus && session.cacheWarmingStatus.state !== 'inactive') ||
        extensionErrors !== errors ||
        resources.getExtensions().errors.length ||
        [resources.getSkills(), resources.getPrompts(), resources.getThemes()].some((result) =>
          result.diagnostics.some((diagnostic) => diagnostic.type === 'error')
        ) ||
        session.settingsManager.drainErrors().length ||
        session.sessionManager !== manager ||
        JSON.stringify(identity) !==
          JSON.stringify([session.sessionId, session.sessionFile, manager.getLeafId()]) ||
        JSON.stringify(manager.getEntries()) !== history ||
        JSON.stringify(session.messages) !== transcript
      )
        throw new Error('RELOAD_NOT_LOSSLESS');
    } catch {
      recoveryRequired = true;
      throw new Error('ENGINE_RECOVERY_REQUIRED_AFTER_RELOAD');
    } finally {
      enginePending = false;
    }
  };
  const scopes = createScopeOperations(
    () => session,
    () =>
      sdk.SettingsManager.create(runtimeHost.cwd, runtimeHost.services.agentDir, {
        projectTrusted: runtimeHost.services.settingsManager.isProjectTrusted(),
      }),
    resolveModelScopeFromModels,
    runtimeHost.scopeStartupPatterns
  );
  const preferences = createPreferenceOperations(
    () => session,
    () =>
      sdk.SettingsManager.create(runtimeHost.cwd, runtimeHost.services.agentDir, {
        projectTrusted: session.settingsManager.isProjectTrusted(),
      }),
    runtimeHost.preferenceProvenance,
    thinking
  );
  const saveNativeDefault = (action) =>
    serializePreferenceDefaults(async () => {
      const original = session;
      const result = await action();
      await original.settingsManager.flush();
      original.settingsManager.applyOverrides(runtimeHost.preferenceProvenance?.overrides ?? {});
      if (original.settingsManager.drainErrors().length)
        throw new Error('PREFERENCES_WRITE_FAILED');
      return result;
    });
  let unsubscribe;
  let unsubscribeBackpressure;
  let shutdownErrors = 0;
  let extensionErrors = 0;
  // Tag every response/event with this session's key so the multiplexing host
  // routes it back to the right chat tab. (Was: raw stdout for one session.)
  const output = (obj) => {
    hostEmit(sessionKey, obj);
  };
  // One synchronous native capture while lifecyclePending owns the runner.
  // Clone immediately: public getter arrays must not remain live across response I/O.
  const captureReplacementProjection = (origin) => {
    const captured = session;
    const manager = captured.sessionManager;
    const identity = {
      sessionId: captured.sessionId,
      sessionFile: captured.sessionFile,
      leafId: manager.getLeafId(),
    };
    const projection = JSON.parse(
      JSON.stringify({
        contract: 1,
        origin,
        identity,
        state: readState(),
        entries: manager.getEntries(),
        messages: captured.messages,
      })
    );
    if (
      session !== captured ||
      session.sessionManager !== manager ||
      session.sessionId !== identity.sessionId ||
      session.sessionFile !== identity.sessionFile ||
      manager.getLeafId() !== identity.leafId ||
      projection.state.sessionId !== identity.sessionId ||
      projection.state.sessionFile !== identity.sessionFile
    )
      throw new Error('LIFECYCLE_PROJECTION_CHANGED');
    return { replacementIdentity: projection.identity, replacementProjection: projection };
  };
  const success = (id, command, data, origin) => {
    if (data === undefined) {
      return { id, type: 'response', command, success: true };
    }
    if (
      ['new_session', 'switch_session', 'import_session', 'fork', 'clone'].includes(command) &&
      data.cancelled !== true
    ) {
      data = {
        ...data,
        ...captureReplacementProjection(origin),
      };
    }
    return { id, type: 'response', command, success: true, data };
  };
  const error = (id, command, message) => {
    return { id, type: 'response', command, success: false, error: message };
  };
  // Pending extension UI requests waiting for response
  const pendingExtensionRequests = new Map();
  // Shutdown request flag
  let shutdownRequested = false;
  let shuttingDown = false;
  let initializing = true;
  const signalCleanupHandlers = [];
  const cancelPendingDialogs = (reason) => {
    for (const pending of [...pendingExtensionRequests.values()]) pending.cancel(reason);
  };
  const unsupportedUi = (uiCapability) => {
    output({
      type: 'extension_ui_request',
      id: crypto.randomUUID(),
      method: 'unsupported_ui',
      uiCapability,
      message: 'This interface is not available in the chat. Use the extension in Pi’s terminal.',
    });
  };
  /** Helper for dialog methods with signal/timeout support */
  function createDialogPromise(opts, defaultValue, request, parseResponse) {
    if (opts?.signal?.aborted) return Promise.resolve(defaultValue);
    const id = crypto.randomUUID();
    return new Promise((resolve) => {
      let timeoutId;
      let settled = false;
      const cleanup = () => {
        if (timeoutId) clearTimeout(timeoutId);
        opts?.signal?.removeEventListener('abort', onAbort);
        pendingExtensionRequests.delete(id);
      };
      const finish = (response, reason) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (reason) {
          output({
            type: 'extension_ui_request',
            id: crypto.randomUUID(),
            method: 'cancel',
            requestId: id,
            reason,
          });
        }
        resolve(reason ? defaultValue : parseResponse(response));
      };
      const onAbort = () => finish(undefined, 'aborted');
      opts?.signal?.addEventListener('abort', onAbort, { once: true });
      if (opts?.timeout) {
        timeoutId = setTimeout(() => {
          finish(undefined, 'timeout');
        }, opts.timeout);
      }
      pendingExtensionRequests.set(id, {
        resolve: (response) => {
          finish(response);
        },
        cancel: (reason) => finish(undefined, reason),
      });
      output({ type: 'extension_ui_request', id, ...request });
    });
  }
  /**
   * Create an extension UI context that uses the RPC protocol.
   */
  const createExtensionUIContext = () => ({
    select: (title, options, opts) =>
      createDialogPromise(
        opts,
        undefined,
        { method: 'select', title, options, timeout: opts?.timeout },
        (r) => ('cancelled' in r && r.cancelled ? undefined : 'value' in r ? r.value : undefined)
      ),
    confirm: (title, message, opts) =>
      createDialogPromise(
        opts,
        false,
        { method: 'confirm', title, message, timeout: opts?.timeout },
        (r) => ('cancelled' in r && r.cancelled ? false : 'confirmed' in r ? r.confirmed : false)
      ),
    input: (title, placeholder, opts) =>
      createDialogPromise(
        opts,
        undefined,
        { method: 'input', title, placeholder, timeout: opts?.timeout },
        (r) => ('cancelled' in r && r.cancelled ? undefined : 'value' in r ? r.value : undefined)
      ),
    notify(message, type) {
      // Fire and forget - no response needed
      output({
        type: 'extension_ui_request',
        id: crypto.randomUUID(),
        method: 'notify',
        message,
        notifyType: type,
      });
    },
    onTerminalInput() {
      // Raw terminal input not supported in RPC mode
      return () => {};
    },
    setStatus(key, text) {
      // Fire and forget - no response needed
      output({
        type: 'extension_ui_request',
        id: crypto.randomUUID(),
        method: 'setStatus',
        statusKey: key,
        statusText: text,
      });
    },
    setWorkingMessage(_message) {
      // Working message not supported in RPC mode - requires TUI loader access
    },
    setWorkingVisible(_visible) {
      // Working visibility not supported in RPC mode - requires TUI loader access
    },
    setWorkingIndicator(_options) {
      // Working indicator customization not supported in RPC mode - requires TUI loader access
    },
    setHiddenThinkingLabel(_label) {
      // Hidden thinking label not supported in RPC mode - requires TUI message rendering access
    },
    setWidget(key, content, options) {
      // Only support string arrays in RPC mode - factory functions are ignored
      if (content === undefined || Array.isArray(content)) {
        if (content === undefined) widgets.delete(key);
        else widgets.add(key);
        output({
          type: 'extension_ui_request',
          id: crypto.randomUUID(),
          method: 'setWidget',
          widgetKey: key,
          widgetLines: content,
          widgetPlacement: options?.placement,
        });
      } else unsupportedUi('widget');
      // Component factories are not supported in RPC mode - would need TUI access
    },
    setFooter(_factory) {
      unsupportedUi('footer');
    },
    setHeader(_factory) {
      unsupportedUi('header');
    },
    setTitle(title) {
      // Fire and forget - host can implement terminal title control
      output({
        type: 'extension_ui_request',
        id: crypto.randomUUID(),
        method: 'setTitle',
        title,
      });
    },
    async custom() {
      unsupportedUi('custom');
      return undefined;
    },
    pasteToEditor(text) {
      // Paste handling not supported in RPC mode - falls back to setEditorText
      this.setEditorText(text);
    },
    setEditorText(text) {
      // Fire and forget - host can implement editor control
      output({
        type: 'extension_ui_request',
        id: crypto.randomUUID(),
        method: 'set_editor_text',
        text,
      });
    },
    getEditorText() {
      // The native synchronous TUI getter cannot read a remote GUI composer.
      return '';
    },
    async editor(title, prefill) {
      return createDialogPromise(
        undefined,
        undefined,
        { method: 'editor', title, prefill },
        (response) => (response.cancelled ? undefined : response.value)
      );
    },
    addAutocompleteProvider() {
      // Autocomplete provider composition is not supported in RPC mode
    },
    setEditorComponent() {
      unsupportedUi('editor');
    },
    getEditorComponent() {
      // Custom editor components not supported in RPC mode
      return undefined;
    },
    get theme() {
      return theme;
    },
    getAllThemes() {
      return [];
    },
    getTheme(_name) {
      return undefined;
    },
    setTheme(_theme) {
      // Theme switching not supported in RPC mode
      return { success: false, error: 'Theme switching not supported in RPC mode' };
    },
    getToolsExpanded() {
      // Tool expansion not supported in RPC mode - no TUI
      return false;
    },
    setToolsExpanded(_expanded) {
      // Tool expansion not supported in RPC mode - no TUI
    },
  });
  runtimeHost.setRebindSession(async () => {
    await rebindSession();
  });
  const rebindSession = async () => {
    activityRevision++;
    session = runtimeHost.session;
    await session.bindExtensions({
      uiContext: createExtensionUIContext(),
      mode: 'rpc',
      commandContextActions: {
        waitForIdle: () => session.waitForIdle(),
        newSession: async (options) => runtimeHost.newSession(options),
        fork: async (entryId, forkOptions) => {
          const result = await runtimeHost.fork(entryId, forkOptions);
          return { cancelled: result.cancelled };
        },
        navigateTree: async (targetId, options) => {
          const result = await session.navigateTree(targetId, {
            summarize: options?.summarize,
            customInstructions: options?.customInstructions,
            replaceInstructions: options?.replaceInstructions,
            label: options?.label,
          });
          return { cancelled: result.cancelled };
        },
        switchSession: async (sessionPath, options) => {
          return runtimeHost.switchSession(sessionPath, options);
        },
        reload: reloadNative,
      },
      shutdownHandler: () => {
        shutdownRequested = true;
      },
      onError: (err) => {
        extensionErrors++;
        if (err.event === 'session_shutdown') shutdownErrors++;
        output({
          type: 'extension_error',
          extensionPath: err.extensionPath,
          event: err.event,
          error: err.error,
        });
      },
    });
    unsubscribe?.();
    unsubscribeBackpressure?.();
    unsubscribe = session.subscribe((event) => {
      if (event.type === 'agent_start') activityRevision++;
      output(toJsonEvent(event));
      if (event.type === 'agent_settled') {
        void checkShutdownRequested();
      }
    });
    unsubscribeBackpressure = session.agent.subscribe(async () => {
      await waitForRawStdoutBackpressure();
    });
  };
  const registerSignalHandlers = () => {
    const signals = ['SIGTERM'];
    if (process.platform !== 'win32') {
      signals.push('SIGHUP');
    }
    for (const signal of signals) {
      const handler = () => {
        killTrackedDetachedChildren();
        void shutdown(signal === 'SIGHUP' ? 129 : 143, signal);
      };
      process.on(signal, handler);
      signalCleanupHandlers.push(() => process.off(signal, handler));
    }
  };
  const authCommands = createAuthCommands(() => session);
  const importCommands = createImportCommands(() => runtimeHost);
  let thinkingEpoch = 0;
  let thinkingContext;
  const thinkingSnapshot = () => {
    const context = [
      session,
      session.sessionManager,
      session.sessionId,
      session.model,
      session.thinkingLevel,
    ];
    if (!thinkingContext || context.some((v, i) => v !== thinkingContext[i])) {
      thinkingEpoch++;
      thinkingContext = context;
    }
    return { levels: session.getAvailableThinkingLevels(), revision: String(thinkingEpoch) };
  };
  // Handle a single command
  let compactPending = false;
  let defaultsPending = false;
  let lifecyclePending = false;
  const lifecycleCommands = [
    'new_session',
    'switch_session',
    'import_session',
    'fork',
    'clone',
    'close_chat',
    'navigate_tree',
    'set_project_trust',
  ];
  const handleCommand = async (command) => {
    if (shuttingDown) throw new Error('LIFECYCLE_CLOSED');
    if (command.type === 'prompt' && command.outbox !== undefined) {
      const admission = command.outbox;
      if (
        !admission ||
        typeof admission !== 'object' ||
        Array.isArray(admission) ||
        typeof admission.sessionId !== 'string' ||
        typeof admission.requireIdle !== 'boolean' ||
        (admission.sessionFile !== undefined && typeof admission.sessionFile !== 'string')
      )
        refuseOutbox('OUTBOX_INVALID_ADMISSION');
      if (
        admission.sessionId !== session.sessionId ||
        admission.sessionFile !== session.sessionFile
      )
        refuseOutbox('OUTBOX_STALE_ORIGIN');
      if (
        recoveryRequired ||
        enginePending ||
        promptPending.size ||
        lifecyclePending ||
        compactPending ||
        defaultsPending ||
        authCommands.busy ||
        session.isCompacting ||
        session.isRetrying ||
        session.isBashRunning ||
        session.hasPendingBashMessages ||
        session.pendingMessageCount ||
        pendingExtensionRequests.size ||
        (admission.requireIdle && session.isIdle !== true)
      )
        refuseOutbox('OUTBOX_BUSY');
    }
    if (
      promptPending.size &&
      [
        ...lifecycleCommands,
        'set_model',
        'cycle_model',
        'set_thinking_level',
        'cycle_thinking_level',
        'set_scoped_models',
        'save_scoped_models_default',
        'save_preference',
        'set_steering_mode',
        'set_follow_up_mode',
        'set_auto_compaction',
        'set_auto_retry',
        'compact',
        'reload_session',
        'auth_login',
        'auth_logout',
        'import_prepare',
        'set_model_tools',
      ].includes(command.type)
    )
      throw new Error(
        command.type === 'set_model_tools' ? 'MODEL_TOOLS_BUSY' : 'PROMPT_PREFLIGHT_BUSY'
      );
    if (
      (recoveryRequired || enginePending) &&
      !['get_state', 'get_capabilities'].includes(command.type) &&
      !(command.type === 'auth_response' && command.value === null) &&
      command.type !== 'auth_poll'
    )
      throw new Error(
        recoveryRequired ? 'ENGINE_RECOVERY_REQUIRED' : 'ENGINE_BUSY_NOTHING_DISCARDED'
      );
    if (
      [
        'navigate_tree',
        'get_project_trust',
        'set_project_trust',
        'reload_session',
        'auth_providers',
        'auth_logout',
        'auth_login',
        'auth_poll',
        'auth_response',
        'delivery_payload',
        'import_prepare',
        'import_session',
        'mcp_status',
        'read_model_tools',
        'set_model_tools',
      ].includes(command.type) &&
      command.guiLifecycle !== true
    )
      throw new Error('ENGINE_ORIGIN_REQUIRED');
    if (
      [
        'navigate_tree',
        'set_project_trust',
        'reload_session',
        'auth_logout',
        'auth_login',
        'import_prepare',
        'import_session',
        'mcp_status',
      ].includes(command.type)
    )
      assertEngineIdle();
    if (
      authCommands.busy &&
      ![
        'auth_poll',
        'auth_response',
        'get_state',
        'get_capabilities',
        'get_entries',
        'get_available_models',
        'get_messages',
        'auth_providers',
      ].includes(command.type)
    )
      throw new Error('AUTH_BUSY');
    const replacing =
      lifecycleCommands.includes(command.type) &&
      (command.guiLifecycle === true || command.type === 'close_chat');
    if (
      command.guiLifecycle === true &&
      // A flow nonce authorizes cancellation/status only, never stale secrets.
      // Cancellation must survive originating leaf/session invalidation.
      !(command.type === 'auth_response' && command.value === null) &&
      command.type !== 'auth_poll' &&
      (!command.origin ||
        command.origin.sessionId !== session.sessionId ||
        command.origin.sessionFile !== session.sessionFile ||
        (command.origin.leafId !== undefined &&
          command.origin.leafId !== session.sessionManager.getLeafId()))
    )
      throw new Error('LIFECYCLE_STALE_ORIGIN');
    if (lifecyclePending && !['get_state', 'get_capabilities'].includes(command.type))
      throw new Error('LIFECYCLE_BUSY');
    if (replacing) {
      if (
        !session.isIdle ||
        session.isStreaming ||
        session.isCompacting ||
        session.isRetrying ||
        session.isBashRunning ||
        session.hasPendingBashMessages ||
        session.pendingMessageCount ||
        compactPending ||
        defaultsPending
      )
        throw new Error('LIFECYCLE_BUSY');
      lifecyclePending = true;
    }
    try {
      return await dispatchCommand(command);
    } finally {
      if (replacing) lifecyclePending = false;
    }
  };
  const readState = () => ({
    sdkVersion: metadata.version,
    model: modelDto(session.model),
    thinkingLevel: session.thinkingLevel,
    availableThinkingLevels: session.getAvailableThinkingLevels(),
    isStreaming: session.isStreaming,
    isCompacting: session.isCompacting || compactPending,
    isIdle:
      session.isIdle &&
      !defaultsPending &&
      !compactPending &&
      !enginePending &&
      !promptPending.size &&
      !recoveryRequired,
    recoveryRequired,
    isBashRunning: session.isBashRunning,
    hasPendingBashMessages: session.hasPendingBashMessages,
    isRetrying: session.isRetrying,
    steeringMode: session.steeringMode,
    followUpMode: session.followUpMode,
    sessionFile: session.sessionFile,
    sessionId: session.sessionId,
    leafId: session.sessionManager.getLeafId(),
    sessionName: session.sessionName,
    autoCompactionEnabled: session.autoCompactionEnabled,
    messageCount: session.messages.length,
    pendingMessageCount: session.pendingMessageCount,
  });
  const dispatchCommand = async (command) => {
    const id = command.id;
    if (
      [
        'set_model',
        'cycle_model',
        'new_session',
        'switch_session',
        'fork',
        'clone',
        'cycle_thinking_level',
      ].includes(command.type)
    )
      thinkingEpoch++;
    switch (command.type) {
      // =================================================================
      // Prompting
      // =================================================================
      case 'prompt': {
        // Start prompt handling immediately, but emit the authoritative response only after
        // prompt preflight succeeds. Queued and immediately handled prompts also count as success.
        let preflightSucceeded = false;
        const reservation = {};
        promptPending.add(reservation);
        const release = () => promptPending.delete(reservation);
        void session
          .prompt(command.message, {
            images: command.images,
            streamingBehavior: command.streamingBehavior,
            source: 'rpc',
            preflightResult: (disposition) => {
              if (disposition === true || ['handled', 'queued', 'started'].includes(disposition)) {
                preflightSucceeded = true;
                release();
                output(
                  success(
                    id,
                    'prompt',
                    typeof disposition === 'string' ? { disposition } : undefined
                  )
                );
              }
            },
          })
          .catch((e) => {
            release();
            if (!preflightSucceeded) {
              output(error(id, 'prompt', e.message));
            }
          })
          .finally(release);
        return undefined;
      }
      case 'steer': {
        const disposition = await session.steer(command.message, command.images, { source: 'rpc' });
        return success(id, 'steer', typeof disposition === 'string' ? { disposition } : undefined);
      }
      case 'follow_up': {
        const disposition = await session.followUp(command.message, command.images, {
          source: 'rpc',
        });
        return success(
          id,
          'follow_up',
          typeof disposition === 'string' ? { disposition } : undefined
        );
      }
      case 'abort': {
        cancelPendingDialogs('aborted');
        await session.abort();
        return success(id, 'abort');
      }
      case 'close_chat': {
        await session.settingsManager.flush();
        if (session.settingsManager.drainErrors().length) throw new Error('LIFECYCLE_SAVE_FAILED');
        const errorsBefore = shutdownErrors;
        await runtimeHost.dispose();
        if (shutdownErrors !== errorsBefore) throw new Error('LIFECYCLE_DISPOSAL_FAILED');
        shuttingDown = true;
        unsubscribe?.();
        unsubscribeBackpressure?.();
        return success(id, 'close_chat', { cancelled: false, closed: true });
      }
      case 'new_session': {
        const options = command.parentSession
          ? { parentSession: command.parentSession }
          : undefined;
        const result = await runtimeHost.newSession(options);
        if (!result.cancelled) {
          await rebindSession();
        }
        return success(id, 'new_session', result, command.origin);
      }
      // =================================================================
      // State
      // =================================================================
      case 'get_state': {
        const state = readState();
        return success(id, 'get_state', state);
      }
      // =================================================================
      // Model
      // =================================================================
      case 'get_capabilities':
        return success(id, command.type, {
          lifecycleProjection: 1,
          protocol: 1,
          sdkVersion: metadata.version,
          modelDiscovery: supportsModelDiscovery,
          closeChat: true,
          engineCommands: {
            contract: 1,
            navigate_tree: typeof session.navigateTree === 'function',
            get_project_trust: typeof sdk.ProjectTrustStore === 'function',
            set_project_trust: typeof sdk.ProjectTrustStore === 'function',
            reload_session: dedicated && typeof session.reload === 'function',
            auth_providers: typeof session.modelRuntime.getProviders === 'function',
            auth_logout: typeof session.modelRuntime.logout === 'function',
            auth_login: typeof session.modelRuntime.login === 'function',
            auth_poll: true,
            auth_response: true,
            delivery_payload: true,
            import_prepare: typeof runtimeHost.importFromJsonl === 'function',
            mcp_status: !!nativeMcpCommand(session),
            outbox_prompt: true,
            read_model_tools: !!modelToolsPersistence && supportsModelTools(session),
            set_model_tools: !!modelToolsPersistence && supportsModelTools(session),
          },
          scopedModels: { read: true, set: true, saveGlobal: true },
          thinking: { contract: 1, read: true, strictSet: true },
          preferences: { contract: 1, read: true, saveGlobal: true },
          exports: { html: true, jsonl: typeof session.exportToJsonl === 'function' },
        });
      case 'get_preferences':
        return success(id, command.type, preferences.read());
      case 'save_preference': {
        if (compactPending || defaultsPending) throw new Error('PREFERENCES_BUSY');
        defaultsPending = true;
        try {
          return success(id, command.type, await preferences.save(command));
        } finally {
          defaultsPending = false;
        }
      }
      case 'get_scoped_models':
        return success(id, command.type, scopes.read());
      case 'set_scoped_models':
        return success(id, command.type, await scopes.set(command));
      case 'save_scoped_models_default': {
        if (compactPending) throw new Error('COMPACTION_BUSY');
        defaultsPending = true;
        try {
          return success(
            id,
            command.type,
            await serializePreferenceDefaults(() => scopes.save(command))
          );
        } finally {
          defaultsPending = false;
        }
      }
      case 'set_model': {
        const models = session.modelRuntime.getAvailableSnapshot();
        const model = models.find(
          (m) => m.provider === command.provider && m.id === command.modelId
        );
        if (!model) {
          return error(id, 'set_model', 'SDK_MODEL_UNAVAILABLE');
        }
        await saveNativeDefault(() => session.setModel(model));
        return success(id, 'set_model', modelDto(model));
      }
      case 'cycle_model': {
        const result = await saveNativeDefault(() => session.cycleModel());
        if (!result) {
          return success(id, 'cycle_model', null);
        }
        return success(id, 'cycle_model', {
          model: modelDto(result.model),
          thinkingLevel: result.thinkingLevel,
          isScoped: result.isScoped,
        });
      }
      case 'delivery_payload': {
        assertEngineIdle();
        const timestamp = new Date().toISOString();
        const manager = session.sessionManager;
        const entries = [
          {
            type: 'session',
            version: 3,
            id: manager.getSessionId(),
            timestamp,
            cwd: manager.getCwd(),
          },
        ];
        let parentId = null;
        for (const entry of manager.getBranch()) {
          entries.push({ ...entry, parentId });
          parentId = entry.id;
        }
        if (command.share === true)
          entries.push({
            type: 'custom',
            customType: 'pi.share',
            id: crypto.randomUUID().slice(0, 8),
            parentId,
            timestamp,
            data: {
              systemPrompt: session.state.systemPrompt,
              tools: session.state.tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
              })),
            },
          });
        const jsonl = entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n';
        if (Buffer.byteLength(jsonl) > 8 * 1024 * 1024) throw new Error('DELIVERY_TOO_LARGE');
        return success(id, command.type, { jsonl });
      }
      case 'read_model_tools':
        if (!modelToolsPersistence) throw new Error('MODEL_TOOLS_UNSUPPORTED');
        return success(id, command.type, {
          ...readModelTools(session),
          persistence: modelToolsPersistence,
        });
      case 'set_model_tools': {
        if (!modelToolsPersistence) throw new Error('MODEL_TOOLS_UNSUPPORTED');
        if (
          recoveryRequired ||
          enginePending ||
          lifecyclePending ||
          compactPending ||
          defaultsPending ||
          promptPending.size ||
          authCommands.busy ||
          pendingExtensionRequests.size ||
          !session.isIdle ||
          session.isStreaming ||
          session.isCompacting ||
          session.isRetrying ||
          session.isBashRunning ||
          session.hasPendingBashMessages ||
          session.pendingMessageCount
        )
          throw new Error('MODEL_TOOLS_BUSY');
        const captured = session,
          revision = activityRevision,
          manager = session.sessionManager;
        const leaf = manager.getLeafId();
        enginePending = true;
        try {
          const result = setModelTools(captured, command.revision, command.names);
          if (
            session !== captured ||
            activityRevision !== revision ||
            shuttingDown ||
            captured.sessionId !== command.origin.sessionId ||
            captured.sessionFile !== command.origin.sessionFile ||
            manager.getLeafId() !== leaf
          )
            throw new Error('MODEL_TOOLS_STALE_ORIGIN');
          return success(id, command.type, { ...result, persistence: modelToolsPersistence });
        } finally {
          enginePending = false;
        }
      }
      case 'mcp_status': {
        const captured = session;
        const revision = activityRevision;
        const manager = session.sessionManager;
        const leaf = manager.getLeafId();
        const valid = () =>
          session === captured &&
          activityRevision === revision &&
          !shuttingDown &&
          captured.isIdle &&
          !captured.isStreaming &&
          !captured.isCompacting &&
          captured.sessionId === command.origin.sessionId &&
          captured.sessionFile === command.origin.sessionFile &&
          manager.getLeafId() === leaf;
        const result = await readNativeMcpStatus(captured, valid);
        if (!valid()) throw new Error('MCP_STATUS_STALE_ORIGIN');
        return success(id, command.type, result);
      }
      case 'auth_providers':
        return success(id, command.type, { providers: authCommands.providers() });
      case 'auth_login':
        return success(id, command.type, authCommands.start(command.providerId, command.authType));
      case 'auth_poll':
        return success(id, command.type, authCommands.poll(command.nonce));
      case 'auth_response':
        return success(
          id,
          command.type,
          authCommands.respond(command.nonce, command.promptNonce, command.value)
        );
      case 'auth_logout':
        return success(id, command.type, await authCommands.logout(command.providerId));
      case 'get_available_models': {
        const runtime = session.modelRuntime;
        const discoveryError =
          command.refreshOpenRouter === true && supportsModelDiscovery
            ? await discoverOpenRouterModels(runtime, runtimeHost.modelDiscoveryOffline)
            : undefined;
        if (runtime !== session.modelRuntime) throw new Error('MODEL_DISCOVERY_STALE');
        const models = session.modelRuntime.getAvailableSnapshot();
        return success(id, 'get_available_models', {
          models: models.map(modelDto),
          // An authenticated provider may have no cached models on its first use.
          discoveryProviders:
            supportsModelDiscovery && runtime.hasConfiguredAuth('openrouter') ? ['openrouter'] : [],
          discoveryError,
        });
      }
      // =================================================================
      // Thinking
      // =================================================================
      case 'set_thinking_level': {
        const current = thinkingSnapshot();
        if (command.expectedRevision !== undefined && command.expectedRevision !== current.revision)
          throw new Error('THINKING_STALE_REVISION');
        if (!current.levels.includes(command.level)) throw new Error('THINKING_UNSUPPORTED_LEVEL');
        const previous = session.thinkingLevel;
        session.setThinkingLevel(command.level, { persist: false });
        if (previous !== session.thinkingLevel) thinkingEpoch++;
        return success(id, 'set_thinking_level', { level: session.thinkingLevel });
      }
      case 'cycle_thinking_level': {
        const level = session.cycleThinkingLevel();
        if (!level) {
          return success(id, 'cycle_thinking_level', null);
        }
        return success(id, 'cycle_thinking_level', { level });
      }
      case 'get_available_thinking_levels': {
        return success(id, 'get_available_thinking_levels', thinkingSnapshot());
      }
      // =================================================================
      // Queue Modes
      // =================================================================
      case 'set_steering_mode': {
        await saveNativeDefault(() => session.setSteeringMode(command.mode));
        return success(id, 'set_steering_mode');
      }
      case 'set_follow_up_mode': {
        await saveNativeDefault(() => session.setFollowUpMode(command.mode));
        return success(id, 'set_follow_up_mode');
      }
      // =================================================================
      // Compaction
      // =================================================================
      case 'compact': {
        if (
          compactPending ||
          defaultsPending ||
          !session.isIdle ||
          session.isRetrying ||
          session.pendingMessageCount ||
          session.isBashRunning ||
          session.hasPendingBashMessages
        )
          throw new Error('COMPACTION_BUSY');
        compactPending = true;
        try {
          const result = await session.compact(command.customInstructions);
          if (!result || typeof result.summary !== 'string') throw new Error('COMPACTION_FAILED');
          return success(id, 'compact', result);
        } catch {
          throw new Error('COMPACTION_FAILED_OR_CANCELLED');
        } finally {
          compactPending = false;
        }
      }
      case 'set_auto_compaction': {
        await saveNativeDefault(() => session.setAutoCompactionEnabled(command.enabled));
        return success(id, 'set_auto_compaction');
      }
      // =================================================================
      // Retry
      // =================================================================
      case 'set_auto_retry': {
        await saveNativeDefault(() => session.setAutoRetryEnabled(command.enabled));
        return success(id, 'set_auto_retry');
      }
      case 'abort_retry': {
        session.abortRetry();
        return success(id, 'abort_retry');
      }
      // =================================================================
      // Bash
      // =================================================================
      case 'bash': {
        const eventResult = await session.extensionRunner.emitUserBash({
          type: 'user_bash',
          command: command.command,
          excludeFromContext: command.excludeFromContext ?? false,
          cwd: session.sessionManager.getCwd(),
        });
        if (eventResult?.result) {
          session.recordBashResult(command.command, eventResult.result, {
            excludeFromContext: command.excludeFromContext,
          });
          return success(id, 'bash', eventResult.result);
        }
        const result = await session.executeBash(command.command, undefined, {
          excludeFromContext: command.excludeFromContext,
          id,
          operations: eventResult?.operations,
        });
        return success(id, 'bash', result);
      }
      case 'abort_bash': {
        session.abortBash();
        return success(id, 'abort_bash');
      }
      // =================================================================
      // Session
      // =================================================================
      case 'get_session_stats': {
        const stats = session.getSessionStats();
        return success(id, 'get_session_stats', stats);
      }
      case 'export_html':
      case 'export_jsonl': {
        if (
          session.isStreaming ||
          session.isCompacting ||
          session.isRetrying ||
          session.pendingMessageCount
        )
          throw new Error('Export requires an idle stable session.');
        const origin = command.origin;
        if (
          origin &&
          (origin.sessionId !== session.sessionId ||
            origin.sessionFile !== session.sessionFile ||
            origin.leafId !== session.sessionManager.getLeafId())
        )
          throw new Error('The originating chat or branch changed; export cancelled.');
        if (command.type === 'export_jsonl' && typeof session.exportToJsonl !== 'function')
          throw new Error('Native JSONL export is unavailable.');
        const path =
          command.type === 'export_jsonl'
            ? session.exportToJsonl(command.outputPath)
            : await session.exportToHtml(command.outputPath);
        return success(id, command.type, { path });
      }
      case 'import_prepare':
        return success(id, command.type, await importCommands.prepare(command.sessionPath));
      case 'import_session': {
        const result = await importCommands.run(command.nonce);
        if (!result.cancelled) await rebindSession();
        return success(id, command.type, result, command.origin);
      }
      case 'switch_session': {
        const result = await runtimeHost.switchSession(command.sessionPath);
        if (!result.cancelled) {
          await rebindSession();
        }
        return success(id, 'switch_session', result, command.origin);
      }
      case 'fork': {
        const result = await runtimeHost.fork(command.entryId);
        if (!result.cancelled) {
          await rebindSession();
        }
        return success(
          id,
          'fork',
          { text: result.selectedText, cancelled: result.cancelled },
          command.origin
        );
      }
      case 'clone': {
        const leafId = session.sessionManager.getLeafId();
        if (!leafId) {
          return error(id, 'clone', 'Cannot clone session: no current entry selected');
        }
        const result = await runtimeHost.fork(leafId, { position: 'at' });
        if (!result.cancelled) {
          await rebindSession();
        }
        return success(id, 'clone', { cancelled: result.cancelled }, command.origin);
      }
      case 'get_fork_messages': {
        const messages = session.getUserMessagesForForking();
        return success(id, 'get_fork_messages', { messages });
      }
      case 'get_entries': {
        const sessionManager = session.sessionManager;
        let entries = sessionManager.getEntries();
        if (command.since !== undefined) {
          const sinceIndex = entries.findIndex((e) => e.id === command.since);
          if (sinceIndex === -1) {
            return error(id, 'get_entries', `Entry not found: ${command.since}`);
          }
          entries = entries.slice(sinceIndex + 1);
        }
        return success(id, 'get_entries', { entries, leafId: sessionManager.getLeafId() });
      }
      case 'get_project_trust': {
        const store = new sdk.ProjectTrustStore(runtimeHost.services.agentDir);
        return success(id, command.type, {
          cwd: runtimeHost.cwd,
          decision: store.get(runtimeHost.cwd),
          entry: store.getEntry(runtimeHost.cwd),
          loaded: session.settingsManager.isProjectTrusted(),
        });
      }
      case 'set_project_trust': {
        if (![true, false, null].includes(command.decision))
          throw new Error('TRUST_INVALID_DECISION');
        new sdk.ProjectTrustStore(runtimeHost.services.agentDir).set(
          runtimeHost.cwd,
          command.decision
        );
        return success(id, command.type, { saved: true, futureProcessesOnly: true });
      }
      case 'reload_session': {
        await reloadNative();
        return success(id, command.type, {
          reloaded: true,
          leafId: session.sessionManager.getLeafId(),
        });
      }
      case 'navigate_tree': {
        if (command.summarize !== undefined && command.summarize !== false)
          throw new Error('TREE_SUMMARY_NOT_AUTHORIZED');
        if (
          typeof command.targetId !== 'string' ||
          !session.sessionManager.getEntry(command.targetId)
        )
          throw new Error('TREE_TARGET_NOT_FOUND');
        const result = await session.navigateTree(command.targetId, { summarize: false });
        return success(id, command.type, { ...result, leafId: session.sessionManager.getLeafId() });
      }
      case 'get_tree': {
        const sessionManager = session.sessionManager;
        return success(id, 'get_tree', {
          tree: sessionManager.getTree(),
          leafId: sessionManager.getLeafId(),
        });
      }
      case 'get_last_assistant_text': {
        const text = session.getLastAssistantText();
        return success(id, 'get_last_assistant_text', { text });
      }
      case 'set_session_name': {
        const name = command.name.trim();
        if (!name) {
          return error(id, 'set_session_name', 'Session name cannot be empty');
        }
        session.setSessionName(name);
        return success(id, 'set_session_name');
      }
      // =================================================================
      // Messages
      // =================================================================
      case 'get_messages': {
        return success(id, 'get_messages', { messages: session.messages });
      }
      // =================================================================
      // Commands (available for invocation via prompt)
      // =================================================================
      case 'get_commands': {
        const commands = [];
        for (const command of session.extensionRunner.getRegisteredCommands()) {
          commands.push({
            name: command.invocationName,
            description: command.description,
            source: 'extension',
            sourceInfo: command.sourceInfo,
          });
        }
        for (const template of session.promptTemplates) {
          commands.push({
            name: template.name,
            description: template.description,
            source: 'prompt',
            sourceInfo: template.sourceInfo,
          });
        }
        for (const skill of session.resourceLoader.getSkills().skills) {
          commands.push({
            name: `skill:${skill.name}`,
            description: skill.description,
            source: 'skill',
            sourceInfo: skill.sourceInfo,
          });
        }
        return success(id, 'get_commands', { commands });
      }
      default: {
        const unknownCommand = command;
        return error(id, unknownCommand.type, `Unknown command: ${unknownCommand.type}`);
      }
    }
  };
  /**
   * Check if shutdown was requested and perform shutdown if so.
   * Called after handling each command when waiting for the next command.
   */
  // Per-session teardown (was process-wide shutdown). NO process.exit here:
  // one session closing must not kill the shared host / other sessions.
  async function dispose() {
    if (shuttingDown) return;
    shuttingDown = true;
    cancelPendingDialogs('closed');
    authCommands.dispose();
    await importCommands.discard();
    for (const cleanup of signalCleanupHandlers) {
      cleanup();
    }
    unsubscribe?.();
    unsubscribeBackpressure?.();
    try {
      await runtimeHost.dispose();
    } catch {
      /* ignore */
    }
  }
  async function checkShutdownRequested() {
    if (!shutdownRequested) return;
    await dispose();
    output({ type: 'session_closed' });
  }
  // Route ONE already-parsed command/message for THIS session (the host demuxer
  // has already unwrapped the {k, d} envelope and dispatched d here).
  const handleParsed = async (parsed) => {
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'type' in parsed &&
      parsed.type === 'extension_ui_response'
    ) {
      const response = parsed;
      const pending = pendingExtensionRequests.get(response.id);
      if (pending) {
        pendingExtensionRequests.delete(response.id);
        pending.resolve(response);
      }
      return;
    }
    const command = parsed;
    if (initializing && command.type !== 'abort') {
      output(error(command.id, command.type, 'SDK_STARTUP_IN_PROGRESS'));
      return;
    }
    try {
      const response = await handleCommand(command);
      if (response) {
        output(response);
        await waitForRawStdoutBackpressure();
      }
      await checkShutdownRequested();
    } catch (commandError) {
      if (commandError?.[outboxAdmissionRefusal] === true) {
        output({
          ...error(command.id, command.type, commandError.message),
          outboxNotDispatched: true,
        });
        await waitForRawStdoutBackpressure();
        return;
      }
      output(
        error(
          command.id,
          command.type,
          /^(?:IMPORT_(?:REQUIRES_PERSISTED_SESSION|ENOENT|EACCES|EPERM|ERR_ACCESS_DENIED|TYPE_ERROR|OPERATION_FAILED)|AUTH_(?:BUSY|NOT_STORED|CHANGED_SYNC_FAILED|OPERATION_FAILED|INVALID_PROVIDER|STALE)|LIFECYCLE_STALE_ORIGIN|MCP_STATUS_STALE_ORIGIN|MODEL_TOOLS_(?:UNSUPPORTED|INVALID_CATALOG|STALE_CATALOG|INVALID_SELECTION|BUSY|STALE_ORIGIN)|ENGINE_(?:RECOVERY_REQUIRED|RECOVERY_REQUIRED_AFTER_RELOAD|BUSY_NOTHING_DISCARDED|ORIGIN_REQUIRED)|RELOAD_REQUIRES_DEDICATED_OS_PROCESS|TREE_(?:SUMMARY_NOT_AUTHORIZED|TARGET_NOT_FOUND)|TRUST_INVALID_DECISION|SCOPES_[A-Z_]+|THINKING_STALE_REVISION|THINKING_UNSUPPORTED_LEVEL|PREFERENCES_(?:READ_FAILED|WRITE_FAILED|INVALID|INVALID_PAID_CONSENT|STALE_REVISION|BUSY|SAVED_SESSION_NOT_APPLIED))$/.test(
            commandError?.message ?? ''
          )
            ? commandError.message
            : 'SDK_OPERATION_FAILED'
        )
      );
      await waitForRawStdoutBackpressure();
    }
  };
  return {
    initialize: async () => {
      await rebindSession();
      initializing = false;
    },
    handleParsed: scopeCommandDispatcher(handleParsed),
    dispose,
  };
}

// ===========================================================================
// Multiplexing host: ONE process, ONE shared ModelRuntime, MANY sessions.
// Envelope protocol on stdio: {"k": sessionKey, "d": <rpc message | meta>}
//   inbound  meta: {type:"open", cwd, sessionFile?} | {type:"close"}
//   inbound  rpc : the usual RPC command objects (routed to session k)
//   outbound     : {k, d:<rpc response|event>} demuxed by the extension
// ===========================================================================
// Initialize the theme once (RPC mode, no watcher). Some MCP/extension paths
// read the global theme; without this they warn "Theme not initialized".
try {
  initTheme(undefined, false);
} catch {
  /* invalid theme falls back to dark internally */
}
takeOverStdout();
const hostEmit = (k, obj) => {
  writeRawStdout(serializeJsonLine({ k, d: obj }));
};

const sessions = new Map();
const openingSessions = new Map();
let dedicatedSessionKey;
let dedicatedOpening = false;

async function openSession(k, info) {
  if (openingSessions.has(k)) return;
  if (sessions.has(k)) {
    hostEmit(k, { type: 'response', command: 'open', success: true });
    return;
  }
  let dedicatedReservation = false;
  const opening = {};
  openingSessions.set(k, opening);
  let runner;
  try {
    if (process.env.PI_HOST_DEDICATED === '1') {
      if (dedicatedOpening || (dedicatedSessionKey && dedicatedSessionKey !== k))
        throw new Error('SDK_DEDICATED_SINGLE_SESSION_ONLY');
      dedicatedSessionKey = k;
      dedicatedOpening = true;
      dedicatedReservation = true;
    }
    const runtimeHost = await buildRuntimeHost(info);
    if (openingSessions.get(k) !== opening) {
      await runtimeHost.dispose();
      return;
    }
    runner = createSessionRunner(k, runtimeHost, hostEmit);
    sessions.set(k, runner);
    await runner.initialize();
    if (sessions.get(k) !== runner) return;
    dedicatedOpening = false;
    hostEmit(k, { type: 'response', command: 'open', success: true });
  } catch (e) {
    if (runner && sessions.get(k) === runner) {
      sessions.delete(k);
      await runner.dispose();
    }
    if (dedicatedReservation) dedicatedOpening = false;
    hostEmit(k, {
      type: 'response',
      command: 'open',
      success: false,
      error: /^SDK_[A-Z_]+$/.test(e?.message ?? '')
        ? e.message
        : ['ERR_ACCESS_DENIED', 'ENOENT', 'EACCES'].includes(e?.code)
          ? `SDK_STARTUP_FAILED_${e.code}`
          : 'SDK_STARTUP_FAILED',
    });
  } finally {
    if (openingSessions.get(k) === opening) openingSessions.delete(k);
    if (dedicatedReservation) dedicatedOpening = false;
  }
}

async function closeSession(k) {
  openingSessions.delete(k);
  const runner = sessions.get(k);
  if (!runner) return;
  sessions.delete(k);
  try {
    await runner.dispose();
  } catch {
    /* ignore */
  }
}

attachJsonlLineReader(process.stdin, (line) => {
  let env;
  try {
    env = JSON.parse(line);
  } catch {
    return;
  }
  const k = env && env.k;
  const d = env && env.d;
  if (!k || !d) return;
  if (d.type === 'ping') {
    // Warmth probe: answering proves the module graph is imported and the
    // stdin reader is live (this line only runs after all top-level awaits).
    hostEmit(k, { type: 'response', command: 'ping', success: true });
    return;
  }
  if (d.type === 'open') {
    void openSession(k, { cwd: d.cwd, sessionFile: d.sessionFile, args: d.args });
    return;
  }
  if (d.type === 'close') {
    void closeSession(k);
    return;
  }
  const runner = sessions.get(k);
  if (runner) {
    void runner.handleParsed(d);
  } else {
    hostEmit(k, {
      type: 'response',
      id: d.id,
      command: d.type,
      success: false,
      error: 'session not open',
    });
  }
});

async function shutdownHost(code) {
  for (const k of new Set([...sessions.keys(), ...openingSessions.keys()])) {
    await closeSession(k);
  }
  try {
    await flushRawStdout();
  } catch {
    /* ignore */
  }
  process.exit(code);
}
process.stdin.on('end', () => void shutdownHost(0));
for (const sig of process.platform === 'win32' ? ['SIGTERM'] : ['SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    killTrackedDetachedChildren();
    void shutdownHost(sig === 'SIGHUP' ? 129 : 143);
  });
}
