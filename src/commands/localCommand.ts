import { consumeCommand } from './consumeCommand';
import { bugCommand } from './bugCommand';
import { shareCommand } from './shareCommand';
import { authCommand } from './authCommand';
import { isCoreMenuCommand, parseCoreSlash, assertNotCoreSlashPrompt } from './coreSlash';
import { handleEngineCommand, ENGINE_NAMES, type EngineIntent } from './engineCommand';
import { handleLifecycleCommand, LIFECYCLE_NAMES, type LifecycleSurface } from './lifecycleCommand';
import { beginModelOperation } from './modelOperations';
import { pickChatModel } from './modelPicker';
import { pickScopedModels } from './scopedModelsPicker';
import { chooseThinking } from './thinkingPicker';
import { beginReadOnlyCommand, copyAssistant } from './readOnlyCommand';
import { nameCommand } from './nameCommand';
import { hiddenCommand } from './hiddenCommand';
import { sessionCommand } from './sessionCommand';
import { hotkeysCommand } from './hotkeysCommand';
import { changelogCommand } from './changelogCommand';
import { exportCommand } from './exportCommand';
import { compactCommand } from './compactCommand';
import { previewDiagnostics } from './debugCommand';
import { pickSettings } from './settingsPicker';
import type { SessionController } from '../sessions/sessionController';
import type { JsonObject } from '../rpc/protocol';
import type { ComposerSessionState } from '../webview/composer';

/** Native 0.99.1 findExactModelReferenceMatch semantics, adapted to the wire
 * catalog (no SDK dependency in the GUI). Canonical strings are compared BEFORE
 * inspecting any slash, so provider IDs and model IDs may both contain slashes.
 * /model does NOT parse CLI/scope :thinking suffixes: native treats the whole
 * remainder as a selector query when it is not an exact reference. */
export function exactModelReference(
  reference: string,
  models: JsonObject[]
): JsonObject | undefined {
  const normalized = reference.trim().toLowerCase();
  const unique = (matches: JsonObject[]) => (matches.length === 1 ? matches[0] : undefined);
  const canonical = models.filter((m) => `${m.provider}/${m.id}`.toLowerCase() === normalized);
  if (canonical.length) return unique(canonical);
  const slash = reference.indexOf('/');
  if (slash !== -1) {
    const provider = reference.slice(0, slash).trim().toLowerCase();
    const id = reference
      .slice(slash + 1)
      .trim()
      .toLowerCase();
    const qualified = models.filter(
      (m) => String(m.provider).toLowerCase() === provider && String(m.id).toLowerCase() === id
    );
    if (qualified.length) return unique(qualified);
  }
  return unique(models.filter((m) => String(m.id).toLowerCase() === normalized));
}

const operations = {
  login: async (
    controller: SessionController,
    args: string,
    valid: () => boolean,
    _apply: (provider: string, id: string) => Promise<boolean>,
    mutate: (action: () => Promise<void>) => Promise<boolean>
  ) => authCommand(controller, 'login', args, valid, mutate),
  logout: async (
    controller: SessionController,
    args: string,
    valid: () => boolean,
    _apply: (provider: string, id: string) => Promise<boolean>,
    mutate: (action: () => Promise<void>) => Promise<boolean>
  ) => authCommand(controller, 'logout', args, valid, mutate),
  settings: async (
    controller: SessionController,
    args: string,
    valid: () => boolean,
    _apply: (provider: string, id: string) => Promise<boolean>,
    mutate: (action: () => Promise<void>) => Promise<boolean>
  ) => pickSettings(controller, args, valid, mutate),
  thinking: async (
    controller: SessionController,
    args: string,
    valid: () => boolean,
    _apply: (provider: string, id: string) => Promise<boolean>,
    mutate: (action: () => Promise<void>) => Promise<boolean>
  ) => chooseThinking(controller, args, valid, mutate),
  'scoped-models': async (
    controller: SessionController,
    args: string,
    valid: () => boolean,
    _apply: (provider: string, id: string) => Promise<boolean>,
    mutate: (action: () => Promise<void>) => Promise<boolean>
  ): Promise<boolean> => {
    if (args) throw new Error('/scoped-models does not accept arguments.');
    return pickScopedModels(controller, valid, mutate);
  },
  model: async (
    controller: SessionController,
    args: string,
    valid: () => boolean,
    apply: (provider: string, id: string) => Promise<boolean>
  ): Promise<boolean> => {
    const models = await controller.getAvailableModels();
    if (!valid()) throw new Error('The originating chat changed; model selection cancelled.');
    if (!models.length) throw new Error('No available models. Check provider authentication.');
    const exact = args ? exactModelReference(args, models) : undefined;
    if (exact) {
      return apply(String(exact.provider), String(exact.id));
    }
    // Stock RPC exposes available models, not TUI scoped-model or catalog-refresh
    // helpers. Queries use the existing GUI fuzzy picker, with explicit selection.
    return !!(await pickChatModel(controller, {
      models,
      query: args,
      modelOnly: true,
      valid,
      apply,
    }));
  },
};

export { mergeLocalCommands } from './coreCatalog';

/** Capture synchronously at the route boundary, BEFORE reading composer state. */
export function captureLocalCommandOrigin(controller: SessionController): () => boolean {
  if (controller.captureLocalCommandOrigin) return controller.captureLocalCommandOrigin();
  // Structural/offline callers without a supervisor still retain session identity.
  const generation = controller.generation;
  const { sessionId, sessionFile } = controller.snapshot?.state ?? {};
  return () =>
    controller.generation === generation &&
    controller.snapshot?.state.sessionId === sessionId &&
    controller.snapshot?.state.sessionFile === sessionFile;
}

/** Acknowledged local command, before context/images/accepted-send processing.
 * Never writes a stale async copy of the composer, including on RPC failure. */
export async function handleLocalCommand(
  controller: SessionController,
  initial: ComposerSessionState,
  read: () => Promise<ComposerSessionState>,
  write: (state: ComposerSessionState, revision: number) => Promise<void>,
  render: () => Promise<void>,
  submissionId?: string,
  originValid: () => boolean = captureLocalCommandOrigin(controller),
  lifecycleSurface?: LifecycleSurface,
  engineIntent?: EngineIntent
): Promise<boolean> {
  // Some structural callers share their mutable store with `initial`.
  // Capture the invoking payload before consumption or any awaited UI.
  initial = structuredClone(initial);
  const operation = parseCoreSlash(initial.draft);
  if (!operation) return false;
  if (!originValid()) return true;
  if ((ENGINE_NAMES as readonly string[]).includes(operation.name)) {
    await handleEngineCommand(
      controller,
      operation,
      initial,
      read,
      write,
      render,
      submissionId,
      () => originValid() && (!lifecycleSurface || lifecycleSurface.valid()),
      engineIntent ?? lifecycleSurface?.engineIntent
    );
    return true;
  }
  if ((LIFECYCLE_NAMES as readonly string[]).includes(operation.name)) {
    await handleLifecycleCommand(
      controller,
      operation,
      initial,
      read,
      write,
      render,
      submissionId,
      originValid,
      lifecycleSurface
    );
    return true;
  }
  const readOnly =
    operation.name === 'bug' ||
    operation.name === 'share' ||
    operation.name === 'arminsayshi' ||
    operation.name === 'dementedelves' ||
    operation.name === 'copy' ||
    operation.name === 'name' ||
    operation.name === 'session' ||
    operation.name === 'hotkeys' ||
    operation.name === 'changelog' ||
    operation.name === 'export' ||
    operation.name === 'compact' ||
    operation.name === 'debug'
      ? beginReadOnlyCommand(controller)
      : undefined;
  const intent =
    readOnly ?? beginModelOperation(controller, originValid, operation.name === 'settings');
  const valid = () =>
    originValid() &&
    intent.valid() &&
    (!['login', 'logout', 'share', 'bug'].includes(operation.name) ||
      !lifecycleSurface?.engineIntent ||
      lifecycleSurface.engineIntent.valid()) &&
    (!lifecycleSurface || lifecycleSurface.valid());
  const revision = initial.commandRevision ?? 0;
  let accepted = false;
  let detail: string | undefined;
  try {
    await consumeCommand(initial, write, render, valid, submissionId);
    if (!valid()) return true;
    if (readOnly) {
      // Export captures client and branch synchronously, before its first wait.
      if (operation.name !== 'export' && operation.name !== 'compact') await readOnly.ready();
      if (!valid()) return true;
      accepted =
        operation.name === 'bug'
          ? await bugCommand(controller, operation.args, valid)
          : operation.name === 'share'
            ? await shareCommand(controller, operation.args, valid)
            : operation.name === 'arminsayshi' || operation.name === 'dementedelves'
              ? await hiddenCommand(operation.name, operation.args, valid)
              : operation.name === 'name'
                ? await nameCommand(controller, operation.args, valid)
                : operation.name === 'session'
                  ? await sessionCommand(controller, operation.args, valid)
                  : operation.name === 'hotkeys'
                    ? await hotkeysCommand(operation.args, valid)
                    : operation.name === 'changelog'
                      ? await changelogCommand(controller, operation.args, valid)
                      : operation.name === 'export'
                        ? await exportCommand(controller, operation.args, valid)
                        : operation.name === 'compact'
                          ? await compactCommand(controller, operation.args, valid)
                          : operation.name === 'debug'
                            ? await previewDiagnostics(controller, operation.args, valid)
                            : await copyAssistant(controller, operation.args, valid);
    } else {
      const handler = operations[operation.name as keyof typeof operations];
      if (!handler) assertNotCoreSlashPrompt(initial.draft);
      else {
        const modelIntent = intent as ReturnType<typeof beginModelOperation>;
        accepted = await handler(
          controller,
          operation.args,
          valid,
          modelIntent.apply,
          modelIntent.mutate
        );
      }
    }
  } catch (error) {
    detail = error instanceof Error ? error.message : String(error);
  } finally {
    intent.finish();
  }
  if (!valid()) return true;
  const current = await read();
  const consumed = isCoreMenuCommand(initial.draft);
  if (
    valid() &&
    current.draft === (consumed ? '' : initial.draft) &&
    (current.commandRevision ?? 0) === revision
  ) {
    if (accepted) {
      current.localCommandAck = submissionId;
      current.draft = '';
      current.composerResetSeq = (current.composerResetSeq ?? 0) + 1;
      current.recovery = undefined;
    } else if (detail) {
      current.recovery = { kind: 'preflightError', title: 'Command not applied.', detail };
    }
    await write(current, revision);
  }
  if (valid()) await render();
  return true;
}
