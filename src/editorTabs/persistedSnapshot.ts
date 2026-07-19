import type { WebviewPendingImageItem, WebviewSnapshot } from '../state/types';

export interface PersistedChatSnapshot
  extends Omit<WebviewSnapshot, 'pendingImages' | 'preview' | 'acceptedSendSnapshot' | 'draft'> {
  pendingImages: WebviewPendingImageItem[];
}

function sanitizePendingImages(
  images: WebviewSnapshot['pendingImages']
): WebviewPendingImageItem[] {
  return images.map((item) => ({
    itemId: item.itemId,
    name: item.name,
    mimeType: item.mimeType,
    sizeBytes: item.sizeBytes,
    width: item.width,
    height: item.height,
    requiresReselect: true,
  }));
}

export function toPersistedChatSnapshot(snapshot: WebviewSnapshot): PersistedChatSnapshot {
  const rest = { ...snapshot } as Record<string, unknown>;
  delete rest.draft;
  delete rest.preview;
  delete rest.acceptedSendSnapshot;
  return {
    ...(rest as Omit<
      WebviewSnapshot,
      'pendingImages' | 'preview' | 'acceptedSendSnapshot' | 'draft'
    >),
    pendingImages: sanitizePendingImages(snapshot.pendingImages),
  };
}
