import * as vscode from 'vscode';
import { consumeCommand } from './consumeCommand';
import { isCoreMenuCommand } from './coreSlash';
import { exportPathArgument } from './exportCommand';
import type { SessionController } from '../sessions/sessionController';
import type { ComposerSessionState } from '../webview/composer';
import type { JsonObject } from '../rpc/protocol';
import type { CoreSlashOperation } from './coreSlash';

export const LIFECYCLE_NAMES = ['fork', 'clone', 'new', 'resume', 'quit', 'import'] as const;
export type LifecycleName = (typeof LIFECYCLE_NAMES)[number];
export interface LifecycleSurface {
  intent?: ReturnType<SessionController['captureLifecycleIntent']>;
  engineIntent?: ReturnType<SessionController['captureEngineIntent']>;
  /** Captured resource/controller/panel only; NOT a globally relaxed identity guard. */
  valid(): boolean;
  replace(identity: JsonObject, state: ComposerSessionState, valid: () => boolean): Promise<void>;
  close(): Promise<void>;
  resume(): Promise<string | undefined>;
}

/** Preserve saved incoming drafts/chips too when resuming a previously visited identity. */
export function mergeLifecycleComposer(
  saved: ComposerSessionState,
  next: ComposerSessionState
): ComposerSessionState {
  const mergeItems = <T extends { itemId: string }>(left: T[], right: T[]) => [
    ...new Map([...left, ...right].map((item) => [item.itemId, item])).values(),
  ];
  return {
    ...next,
    draft:
      saved.draft && saved.draft !== next.draft
        ? [saved.draft, next.draft].filter(Boolean).join('\n')
        : next.draft,
    pendingImages: mergeItems(saved.pendingImages, next.pendingImages),
    pendingContextItems: mergeItems(saved.pendingContextItems, next.pendingContextItems),
  };
}

export async function handleLifecycleCommand(
  controller: SessionController,
  operation: CoreSlashOperation,
  initial: ComposerSessionState,
  read: () => Promise<ComposerSessionState>,
  write: (state: ComposerSessionState, revision: number) => Promise<void>,
  render: () => Promise<void>,
  submissionId: string | undefined,
  originValid: () => boolean,
  surface?: LifecycleSurface
): Promise<void> {
  let revision = initial.commandRevision ?? 0;
  const origin = controller.snapshot?.state;
  const originKey = JSON.stringify([origin?.sessionFile, origin?.sessionId]);
  const frame = initial.composerResetSeq ?? 0;
  const draft = isCoreMenuCommand(initial.draft) ? '' : initial.draft;
  // Captured native client, generation, session, leaf BEFORE the first UI await.
  let intent: ReturnType<SessionController['captureLifecycleIntent']> | undefined;
  const valid = () => originValid() && (!intent || intent.valid()) && (!surface || surface.valid());
  try {
    intent = surface?.intent ?? controller.captureLifecycleIntent();
    if (!surface) throw new Error('Lifecycle commands require a captured Pi chat surface.');
    if (!valid()) return;
    if (operation.name !== 'import' && operation.args)
      throw new Error(`/${operation.name} does not accept arguments; use its picker.`);
    if (
      operation.name === 'quit' &&
      (initial.pendingImages.length || initial.pendingContextItems.length)
    )
      throw new Error(
        'Remove or save unsent attachments before closing this Pi chat. Nothing was discarded.'
      );
    const consumed = await consumeCommand(initial, write, render, valid, submissionId);
    if (!valid()) return;
    if (consumed) {
      const owned = await read();
      if (!valid() || owned.draft !== '' || owned.localCommandConsumed !== submissionId) return;
      const consumedRevision = owned.commandRevision ?? 0;
      if (consumedRevision !== revision && consumedRevision !== revision + 1) return;
      revision = consumedRevision;
    }
    let target: string | undefined;
    if (operation.name === 'import') {
      if (!vscode.workspace.isTrusted || controller.folder.uri.scheme !== 'file')
        throw new Error('Import requires a trusted local originating workspace.');
      const path = exportPathArgument(operation.args);
      if (!path)
        throw new Error(
          'Usage: /import <session.jsonl> (quoted paths accepted; trailing tokens ignored).'
        );
      const preview = await intent.prepareImport(path);
      if (!valid()) return;
      const consent = await vscode.window.showWarningMessage(
        'Import a validated local Pi session into THIS chat?',
        {
          modal: true,
          detail: `Source: ${preview.source}\nPi JSONL v${preview.version}; ${preview.entries} entries; original cwd: ${preview.cwd}\nDestination cwd: ${preview.destinationCwd}. Uses this admitted native profile and trust, not the imported project. Native model/thinking from the session may be restored; no paid requests. Copies exact validated bytes before native migration; source stays untouched. Outgoing history/draft/images remain saved. Busy work/queues are refused, never aborted or discarded.`,
        },
        'Import'
      );
      if (consent !== 'Import' || !valid() || typeof preview.nonce !== 'string') return;
      target = preview.nonce;
    } else if (operation.name === 'fork') {
      const messages = await intent.forkMessages();
      if (!valid()) return;
      const selected = await vscode.window.showQuickPick(
        messages.map((message) => ({
          label: String(message.text),
          entryId: String(message.entryId),
        })),
        { title: 'Fork before user message (no summary)' }
      );
      if (!selected || !valid()) return;
      target = selected.entryId;
    } else if (operation.name === 'resume') {
      target = await surface.resume();
      if (!target || !valid()) return;
    }
    const result = await intent.run(operation.name as LifecycleName, target, valid);
    if (result.cancelled || !result.valid() || !surface.valid()) return;
    const current = await read();
    if (!result.valid() || !surface.valid()) return;
    const unchanged = current.draft === draft && (current.commandRevision ?? 0) === revision;
    // Preserve outgoing history/chips and any edits made while the native call ran.
    if (unchanged) {
      current.draft = '';
      current.localCommandAck = submissionId;
      current.localCommandReplacement = undefined;
      current.composerResetSeq = (current.composerResetSeq ?? 0) + 1;
      current.recovery = undefined;
      await write(current, revision);
    }
    if (!result.valid() || !surface.valid()) return;
    if (operation.name === 'quit') {
      // Edits/attachments added during shutdown remain visible and saved, not closed away.
      if (!unchanged || current.pendingImages.length || current.pendingContextItems.length) return;
      await surface.close();
    } else {
      const replacement = result.replacementIdentity!;
      const next = {
        ...current,
        draft: unchanged ? (result.editorText ?? '') : current.draft,
        localCommandAck: unchanged ? submissionId : undefined,
        localCommandReplacement:
          unchanged && submissionId
            ? {
                originKey,
                replacementKey: JSON.stringify([replacement.sessionFile, replacement.sessionId]),
                frame,
              }
            : undefined,
      };
      await surface.replace(replacement, next, () => result.valid() && surface.valid());
      await render();
    }
  } catch (error) {
    if (!valid()) return;
    const current = await read();
    if (!valid() || current.draft !== draft || (current.commandRevision ?? 0) !== revision) return;
    current.recovery = {
      kind: 'preflightError',
      title: 'Command not applied.',
      detail: error instanceof Error ? error.message : String(error),
    };
    await write(current, revision);
    await render();
  }
}
