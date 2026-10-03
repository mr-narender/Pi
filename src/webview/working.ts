import type { WebviewSnapshot } from '../state/types';

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
