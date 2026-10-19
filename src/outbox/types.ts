export type OutboxStatus =
  | 'queued'
  | 'held'
  | 'editing'
  | 'paused'
  | 'sending'
  | 'unknown'
  | 'accepted';
export interface OutboxRow {
  id: string;
  revision: number;
  status: OutboxStatus;
  text: string;
  files: Array<{ name: string; kind: 'file' | 'image' }>;
}
export interface OutboxSnapshot {
  key: string;
  items: OutboxRow[];
  notice?: string;
  readOnly?: boolean;
}
export interface OutboxComposerAck {
  submissionId: string;
  originKey: string;
  frame: number;
  accepted: boolean;
}
export type OutboxAction = 'edit' | 'save' | 'cancel' | 'remove' | 'resume' | 'steer' | 'discard';
