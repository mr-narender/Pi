import * as vscode from 'vscode';
import type { SessionController } from '../sessions/sessionController';
import { beginModelOperation } from './modelOperations';

/** Current native capabilities, bound before either discovery or user interaction. */
export async function chooseThinking(
  controller: SessionController,
  args = '',
  valid: () => boolean = () => true,
  mutate?: (action: () => Promise<void>) => Promise<boolean>
): Promise<boolean> {
  const origin = JSON.stringify(controller.snapshot.state.model);
  const session = controller.snapshot.state.sessionId;
  const epoch = controller.modelEpoch;
  const generation = controller.snapshot.generation;
  const stillValid = () =>
    valid() &&
    epoch === controller.modelEpoch &&
    generation === controller.snapshot.generation &&
    session === controller.snapshot.state.sessionId &&
    origin === JSON.stringify(controller.snapshot.state.model);
  const capabilities = await controller.getThinkingCapabilities();
  if (!stillValid())
    throw new Error('The originating model changed; thinking selection cancelled.');
  let level = args.trim().toLowerCase();
  if (!level) {
    const picked = await vscode.window.showQuickPick(
      capabilities.levels.map((level) => ({
        label: level,
        level,
        description: level === controller.snapshot.state.thinkingLevel ? 'current' : '',
      })),
      { title: 'Thinking level', placeHolder: 'Current model supported levels (this session only)' }
    );
    if (!picked) return false;
    level = picked.level;
  }
  if (!capabilities.levels.includes(level))
    throw new Error(`Invalid thinking level. Available: ${capabilities.levels.join(', ')}`);
  const apply = async () => {
    if (!stillValid())
      throw new Error('The originating model changed; thinking selection cancelled.');
    await controller.setThinkingLevel(level, capabilities.revision);
  };
  if (mutate) return mutate(apply);
  await apply();
  return stillValid();
}

export async function pickThinkingLevel(controller: SessionController): Promise<boolean> {
  const intent = beginModelOperation(controller);
  try {
    return await chooseThinking(controller, '', intent.valid, intent.mutate);
  } finally {
    intent.finish();
  }
}
