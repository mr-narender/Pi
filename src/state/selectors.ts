import type { ControllerState } from './types';

export function isBusy(state: ControllerState): boolean {
  return (
    state.connectionState === 'busy' ||
    state.state.isStreaming === true ||
    state.state.isCompacting === true
  );
}

export function summarizeModel(state: ControllerState): string {
  const model = state.state.model;
  if (!model || typeof model.id !== 'string') {
    return 'No model';
  }
  return `${model.provider ?? 'provider'}/${model.id}`;
}

export function summarizeQueue(state: ControllerState): string {
  return `S:${state.queue.steering.length} F:${state.queue.followUp.length}`;
}
