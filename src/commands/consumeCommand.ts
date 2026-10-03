import type { ComposerSessionState } from '../webview/composer';
import { isCoreMenuCommand } from './coreSlash';

/** Text consumption is not an acknowledgement of a completed native action. */
export async function consumeCommand(
  initial: ComposerSessionState,
  write: (state: ComposerSessionState, revision: number) => Promise<void>,
  render: () => Promise<void>,
  valid: () => boolean,
  submissionId?: string
): Promise<boolean> {
  if (!isCoreMenuCommand(initial.draft) || !valid()) return false;
  await write(
    { ...initial, draft: '', localCommandConsumed: submissionId },
    initial.commandRevision ?? 0
  );
  if (valid()) await render();
  return true;
}
