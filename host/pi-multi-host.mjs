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
import {
  flushRawStdout,
  takeOverStdout,
  waitForRawStdoutBackpressure,
  writeRawStdout,
} from '../vendor/pi/dist/core/output-guard.js';
import { killTrackedDetachedChildren } from '../vendor/pi/dist/utils/shell.js';
import { theme, initTheme } from '../vendor/pi/dist/modes/interactive/theme/theme.js';
import { toJsonEvent } from '../vendor/pi/dist/modes/json-event.js';
import { attachJsonlLineReader, serializeJsonLine } from '../vendor/pi/dist/modes/rpc/jsonl.js';
import { ModelRuntime } from '../vendor/pi/dist/core/model-runtime.js';
import {
  createAgentSessionServices,
  createAgentSessionFromServices,
} from '../vendor/pi/dist/core/agent-session-services.js';
import { createAgentSessionRuntime } from '../vendor/pi/dist/core/agent-session-runtime.js';
import { SessionManager } from '../vendor/pi/dist/core/session-manager.js';
/**
 * Run in RPC mode.
 * Listens for JSON commands on stdin, outputs events and responses on stdout.
 */
async function createSessionRunner(sessionKey, runtimeHost, hostEmit) {
  let session = runtimeHost.session;
  let unsubscribe;
  let unsubscribeBackpressure;
  // Tag every response/event with this session's key so the multiplexing host
  // routes it back to the right chat tab. (Was: raw stdout for one session.)
  const output = (obj) => {
    hostEmit(sessionKey, obj);
  };
  const success = (id, command, data) => {
    if (data === undefined) {
      return { id, type: 'response', command, success: true };
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
  const signalCleanupHandlers = [];
  /** Helper for dialog methods with signal/timeout support */
  function createDialogPromise(opts, defaultValue, request, parseResponse) {
    if (opts?.signal?.aborted) return Promise.resolve(defaultValue);
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      let timeoutId;
      const cleanup = () => {
        if (timeoutId) clearTimeout(timeoutId);
        opts?.signal?.removeEventListener('abort', onAbort);
        pendingExtensionRequests.delete(id);
      };
      const onAbort = () => {
        cleanup();
        resolve(defaultValue);
      };
      opts?.signal?.addEventListener('abort', onAbort, { once: true });
      if (opts?.timeout) {
        timeoutId = setTimeout(() => {
          cleanup();
          resolve(defaultValue);
        }, opts.timeout);
      }
      pendingExtensionRequests.set(id, {
        resolve: (response) => {
          cleanup();
          resolve(parseResponse(response));
        },
        reject,
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
        output({
          type: 'extension_ui_request',
          id: crypto.randomUUID(),
          method: 'setWidget',
          widgetKey: key,
          widgetLines: content,
          widgetPlacement: options?.placement,
        });
      }
      // Component factories are not supported in RPC mode - would need TUI access
    },
    setFooter(_factory) {
      // Custom footer not supported in RPC mode - requires TUI access
    },
    setHeader(_factory) {
      // Custom header not supported in RPC mode - requires TUI access
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
      // Custom UI not supported in RPC mode
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
      // Synchronous method can't wait for RPC response
      // Host should track editor state locally if needed
      return '';
    },
    async editor(title, prefill) {
      const id = crypto.randomUUID();
      return new Promise((resolve, reject) => {
        pendingExtensionRequests.set(id, {
          resolve: (response) => {
            if ('cancelled' in response && response.cancelled) {
              resolve(undefined);
            } else if ('value' in response) {
              resolve(response.value);
            } else {
              resolve(undefined);
            }
          },
          reject,
        });
        output({ type: 'extension_ui_request', id, method: 'editor', title, prefill });
      });
    },
    addAutocompleteProvider() {
      // Autocomplete provider composition is not supported in RPC mode
    },
    setEditorComponent() {
      // Custom editor components not supported in RPC mode
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
        reload: async () => {
          await session.reload();
        },
      },
      shutdownHandler: () => {
        shutdownRequested = true;
      },
      onError: (err) => {
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
  await rebindSession();
  // Handle a single command
  const handleCommand = async (command) => {
    const id = command.id;
    switch (command.type) {
      // =================================================================
      // Prompting
      // =================================================================
      case 'prompt': {
        // Start prompt handling immediately, but emit the authoritative response only after
        // prompt preflight succeeds. Queued and immediately handled prompts also count as success.
        let preflightSucceeded = false;
        void session
          .prompt(command.message, {
            images: command.images,
            streamingBehavior: command.streamingBehavior,
            source: 'rpc',
            preflightResult: (didSucceed) => {
              if (didSucceed) {
                preflightSucceeded = true;
                output(success(id, 'prompt'));
              }
            },
          })
          .catch((e) => {
            if (!preflightSucceeded) {
              output(error(id, 'prompt', e.message));
            }
          });
        return undefined;
      }
      case 'steer': {
        await session.steer(command.message, command.images);
        return success(id, 'steer');
      }
      case 'follow_up': {
        await session.followUp(command.message, command.images);
        return success(id, 'follow_up');
      }
      case 'abort': {
        await session.abort();
        return success(id, 'abort');
      }
      case 'new_session': {
        const options = command.parentSession
          ? { parentSession: command.parentSession }
          : undefined;
        const result = await runtimeHost.newSession(options);
        if (!result.cancelled) {
          await rebindSession();
        }
        return success(id, 'new_session', result);
      }
      // =================================================================
      // State
      // =================================================================
      case 'get_state': {
        const state = {
          model: session.model,
          thinkingLevel: session.thinkingLevel,
          isStreaming: session.isStreaming,
          isCompacting: session.isCompacting,
          steeringMode: session.steeringMode,
          followUpMode: session.followUpMode,
          sessionFile: session.sessionFile,
          sessionId: session.sessionId,
          sessionName: session.sessionName,
          autoCompactionEnabled: session.autoCompactionEnabled,
          messageCount: session.messages.length,
          pendingMessageCount: session.pendingMessageCount,
        };
        return success(id, 'get_state', state);
      }
      // =================================================================
      // Model
      // =================================================================
      case 'set_model': {
        const models = session.modelRuntime.getAvailableSnapshot();
        const model = models.find(
          (m) => m.provider === command.provider && m.id === command.modelId
        );
        if (!model) {
          return error(id, 'set_model', `Model not found: ${command.provider}/${command.modelId}`);
        }
        await session.setModel(model);
        return success(id, 'set_model', model);
      }
      case 'cycle_model': {
        const result = await session.cycleModel();
        if (!result) {
          return success(id, 'cycle_model', null);
        }
        return success(id, 'cycle_model', result);
      }
      case 'get_available_models': {
        const models = session.modelRuntime.getAvailableSnapshot();
        return success(id, 'get_available_models', { models });
      }
      // =================================================================
      // Thinking
      // =================================================================
      case 'set_thinking_level': {
        session.setThinkingLevel(command.level);
        return success(id, 'set_thinking_level');
      }
      case 'cycle_thinking_level': {
        const level = session.cycleThinkingLevel();
        if (!level) {
          return success(id, 'cycle_thinking_level', null);
        }
        return success(id, 'cycle_thinking_level', { level });
      }
      case 'get_available_thinking_levels': {
        const levels = session.getAvailableThinkingLevels();
        return success(id, 'get_available_thinking_levels', { levels });
      }
      // =================================================================
      // Queue Modes
      // =================================================================
      case 'set_steering_mode': {
        session.setSteeringMode(command.mode);
        return success(id, 'set_steering_mode');
      }
      case 'set_follow_up_mode': {
        session.setFollowUpMode(command.mode);
        return success(id, 'set_follow_up_mode');
      }
      // =================================================================
      // Compaction
      // =================================================================
      case 'compact': {
        const result = await session.compact(command.customInstructions);
        return success(id, 'compact', result);
      }
      case 'set_auto_compaction': {
        session.setAutoCompactionEnabled(command.enabled);
        return success(id, 'set_auto_compaction');
      }
      // =================================================================
      // Retry
      // =================================================================
      case 'set_auto_retry': {
        session.setAutoRetryEnabled(command.enabled);
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
      case 'export_html': {
        const path = await session.exportToHtml(command.outputPath);
        return success(id, 'export_html', { path });
      }
      case 'switch_session': {
        const result = await runtimeHost.switchSession(command.sessionPath);
        if (!result.cancelled) {
          await rebindSession();
        }
        return success(id, 'switch_session', result);
      }
      case 'fork': {
        const result = await runtimeHost.fork(command.entryId);
        if (!result.cancelled) {
          await rebindSession();
        }
        return success(id, 'fork', { text: result.selectedText, cancelled: result.cancelled });
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
        return success(id, 'clone', { cancelled: result.cancelled });
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
    try {
      const response = await handleCommand(command);
      if (response) {
        output(response);
        await waitForRawStdoutBackpressure();
      }
      await checkShutdownRequested();
    } catch (commandError) {
      output(
        error(
          command.id,
          command.type,
          commandError instanceof Error ? commandError.message : String(commandError)
        )
      );
      await waitForRawStdoutBackpressure();
    }
  };
  return { handleParsed, dispose };
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

let sharedModelRuntime;
async function getSharedRuntime() {
  if (!sharedModelRuntime) {
    sharedModelRuntime = await ModelRuntime.create();
  }
  return sharedModelRuntime;
}

async function buildRuntimeHost({ cwd, sessionFile }) {
  const modelRuntime = await getSharedRuntime();
  const sessionManager = sessionFile
    ? SessionManager.open(sessionFile, undefined, cwd)
    : SessionManager.create(cwd);
  // Factory reused by the runtimeHost for /new, /fork, /switch, /resume.
  const createRuntime = async (opts) => {
    const services = await createAgentSessionServices({
      cwd: opts.cwd,
      agentDir: opts.agentDir,
      modelRuntime, // SHARED across every session -> the whole point of this host
      sessionManager: opts.sessionManager,
    });
    const created = await createAgentSessionFromServices({
      services,
      sessionManager: opts.sessionManager,
    });
    return { ...created, services };
  };
  return createAgentSessionRuntime(createRuntime, { cwd, sessionManager });
}

const sessions = new Map();

async function openSession(k, info) {
  if (sessions.has(k)) {
    hostEmit(k, { type: 'response', command: 'open', success: true });
    return;
  }
  try {
    const runtimeHost = await buildRuntimeHost(info);
    const runner = await createSessionRunner(k, runtimeHost, hostEmit);
    sessions.set(k, runner);
    hostEmit(k, { type: 'response', command: 'open', success: true });
  } catch (e) {
    hostEmit(k, {
      type: 'response',
      command: 'open',
      success: false,
      error: e && e.message ? e.message : String(e),
    });
  }
}

async function closeSession(k) {
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
  if (d.type === 'open') {
    void openSession(k, { cwd: d.cwd, sessionFile: d.sessionFile });
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
  for (const k of [...sessions.keys()]) {
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
