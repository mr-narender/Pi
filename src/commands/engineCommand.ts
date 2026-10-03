import * as vscode from 'vscode';
import { consumeCommand } from './consumeCommand';
import { isCoreMenuCommand } from './coreSlash';
import type { SessionController } from '../sessions/sessionController';
import type { ComposerSessionState } from '../webview/composer';
import type { JsonObject } from '../rpc/protocol';
import type { CoreSlashOperation } from './coreSlash';

export const ENGINE_NAMES = ['tree', 'trust', 'reload'] as const;
export type EngineIntent = ReturnType<SessionController['captureEngineIntent']>;

/** Native hierarchy in a keyboard/screen-reader accessible picker: roots first,
 * children indented, every entry ID and current leaf identified. */
export function treeItems(tree: unknown, leafId: unknown) {
  const items: Array<{ label: string; description: string; detail: string; entryId: string }> = [];
  const stack = Array.isArray(tree)
    ? [...tree].reverse().map((node) => ({ node: node as JsonObject, depth: 0 }))
    : [];
  while (stack.length) {
    const { node, depth } = stack.pop()!;
    const entry = node.entry as JsonObject | undefined;
    if (!entry || typeof entry.id !== 'string') continue;
    const message = entry.message as JsonObject | undefined;
    const content = message?.content;
    const text =
      typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content
              .map((part) =>
                typeof part === 'object' && part && 'text' in part ? String(part.text) : ''
              )
              .join(' ')
          : '';
    items.push({
      label: `${'  '.repeat(Math.min(depth, 16))}${entry.id === leafId ? '● ' : ''}${message?.role ?? entry.type}: ${text.slice(0, 160)}`,
      description: entry.id,
      detail: `Depth ${depth}; ${depth === 0 ? 'root' : `parent ${entry.parentId}`}; ${entry.id === leafId ? 'current leaf; ' : ''}${message?.role === 'user' || entry.type === 'custom_message' ? 'continue BEFORE this message' : 'continue AFTER this entry'}`,
      entryId: entry.id,
    });
    if (Array.isArray(node.children))
      for (const child of [...node.children].reverse())
        stack.push({ node: child as JsonObject, depth: depth + 1 });
  }
  return items;
}

export async function handleEngineCommand(
  controller: SessionController,
  operation: CoreSlashOperation,
  initial: ComposerSessionState,
  read: () => Promise<ComposerSessionState>,
  write: (state: ComposerSessionState, revision: number) => Promise<void>,
  render: () => Promise<void>,
  submissionId: string | undefined,
  originValid: () => boolean,
  captured?: EngineIntent
): Promise<void> {
  const intent = captured ?? controller.captureEngineIntent?.();
  let resultValid = intent?.valid ?? (() => true);
  const valid = () => originValid() && resultValid();
  const revision = initial.commandRevision ?? 0;
  const draft = isCoreMenuCommand(initial.draft) ? '' : initial.draft;
  try {
    if (!valid()) return;
    if (!intent)
      throw new Error(
        `/${operation.name} is a local GUI command; the originating backend has no native command capability.`
      );
    await consumeCommand(initial, write, render, valid, submissionId);
    if (!valid()) return;
    let payload: JsonObject = {};
    if (operation.name === 'tree') {
      const data = await intent.tree();
      if (!valid()) return;
      const target = await vscode.window.showQuickPick(treeItems(data?.tree, data?.leafId), {
        title: 'Conversation tree — navigate in this file, no paid summary',
        matchOnDescription: true,
        matchOnDetail: true,
      });
      if (!target || !valid()) return;
      payload = { targetId: target.entryId, summarize: false };
    } else if (operation.name === 'trust') {
      const data = await intent.trust();
      if (!valid()) return;
      const selected = await vscode.window.showQuickPick(
        [
          { label: 'Trust this project for future Pi processes', decision: true },
          { label: 'Do not trust this project for future Pi processes', decision: false },
          { label: 'Remove this project override (inherit parent/default policy)', decision: null },
        ],
        {
          title: `Pi project trust: ${data?.cwd}`,
          placeHolder: `Saved: ${data?.decision ?? 'inherit'}; currently loaded: ${data?.loaded}. This does not grant live resources or VS Code trust.`,
        }
      );
      if (!selected || !valid()) return;
      const confirmed = await vscode.window.showWarningMessage(
        `Save Pi project trust for ${data?.cwd}? Applies to future processes only; no reload, package install or live extension grant.`,
        { modal: true },
        'Save policy'
      );
      if (confirmed !== 'Save policy' || !valid()) return;
      payload = { decision: selected.decision };
    } else {
      const confirmed = await vscode.window.showWarningMessage(
        'Reload native resources, extensions and settings in this dedicated Pi OS process? Queue modes reset; newly added default tools activate, removed defaults remain active and CLI tools win. Extension closures and optional UI are not universally lossless. Shared hosts are refused; failures require manual recovery, never automatic restart/replay.',
        { modal: true },
        'Reload'
      );
      if (confirmed !== 'Reload' || !valid()) return;
    }
    const result = await intent.run(
      operation.name as (typeof ENGINE_NAMES)[number],
      payload,
      originValid
    );
    if (result.cancelled) return;
    resultValid = result.valid;
    if (!valid()) return;
    let editorText: string | undefined;
    if (result.editorText) {
      const accepted = await vscode.window.showWarningMessage(
        'This user entry was selected BEFORE its message. Put its original text in the composer? Existing attachments remain untouched.',
        { modal: true },
        'Use returned text'
      );
      if (!valid()) return;
      if (accepted === 'Use returned text') editorText = result.editorText;
    }
    const current = await read();
    if (!valid() || current.draft !== draft || (current.commandRevision ?? 0) !== revision) return;
    current.draft = editorText ?? '';
    current.localCommandAck = submissionId;
    current.composerResetSeq = (current.composerResetSeq ?? 0) + 1;
    current.recovery = undefined;
    await write(current, revision);
    if (valid()) await render();
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
    if (valid()) await render();
  }
}
