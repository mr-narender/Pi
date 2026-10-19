import type { WebviewSnapshot } from '../state/types';
import { isBlockingExtensionUi } from '../rpc/protocol';

export const WORKING_PHRASES = ['Conjuring…', 'Untangling…', 'Brewing ideas…', 'Wrangling bits…'];

export function workingLabel(snapshot: WebviewSnapshot, phrase = 0): string {
  if (snapshot.approvals?.some(isBlockingExtensionUi)) return 'Waiting for your approval';
  if (snapshot.isCompacting) return 'Compacting conversation…';
  return WORKING_PHRASES[phrase % WORKING_PHRASES.length]!;
}

// Missing bindingState is the standalone/shared renderer's live representation.
// Cached and draft tabs do not own the runtime, even if their snapshot is busy.
export function isLiveWorking(
  snapshot: Pick<WebviewSnapshot, 'bindingState' | 'connectionState' | 'isStreaming'> | undefined
): boolean {
  return (
    !!snapshot &&
    (snapshot.bindingState === undefined || snapshot.bindingState === 'current') &&
    (snapshot.connectionState === 'busy' ||
      (snapshot.connectionState === 'ready' && snapshot.isStreaming === true))
  );
}
