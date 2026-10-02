import * as vscode from 'vscode';
import type { SessionController } from '../sessions/sessionController';

export async function compactCommand(
  controller: SessionController,
  args: string,
  valid: () => boolean = () => true
): Promise<boolean> {
  if (!vscode.workspace.isTrusted) throw new Error('Compaction requires a trusted workspace.');
  const intent = controller.captureCompactIntent();
  if (!valid() || !intent.valid())
    throw new Error('The originating chat changed; compaction cancelled.');
  try {
    await intent.run(args.trim() || undefined);
  } catch {
    throw new Error(
      'Compaction failed or was cancelled. Your draft and attachments were retained.'
    );
  }
  return valid() && intent.valid();
}

/** Cancellation is not bare compaction. Capture origin before the optional dialog. */
export async function compactMenu(controller: SessionController): Promise<boolean> {
  if (!vscode.workspace.isTrusted) throw new Error('Compaction requires a trusted workspace.');
  const intent = controller.captureCompactIntent();
  const instructions = await vscode.window.showInputBox({
    title: 'Compaction instructions (optional)',
    prompt:
      'Summarizes older history into native context using the current provider. Original history remains in the session file. No personal defaults are written.',
  });
  if (instructions === undefined) return false;
  if (!intent.valid()) throw new Error('The originating chat changed; compaction cancelled.');
  try {
    await intent.run(instructions.trim() || undefined);
  } catch {
    throw new Error('Compaction failed or was cancelled.');
  }
  return intent.valid();
}
