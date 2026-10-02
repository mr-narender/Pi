import * as vscode from 'vscode';
import type { SessionController } from '../sessions/sessionController';
import { waitForModelOperations } from './modelOperations';

const intents = new WeakMap<SessionController, object>();

/** Read-only local operations do not supersede model mutations or require a model.
 * They await mutations on their captured origin and reject replaced sessions/hosts. */
export function beginReadOnlyCommand(controller: SessionController) {
  const intent = {};
  intents.set(controller, intent);
  const generation = controller.generation;
  const state = { ...controller.snapshot.state };
  const valid = () =>
    intents.get(controller) === intent &&
    controller.generation === generation &&
    controller.snapshot.state.sessionId === state.sessionId &&
    controller.snapshot.state.sessionFile === state.sessionFile;
  return {
    valid,
    finish: () => {},
    async ready() {
      await waitForModelOperations(controller);
      if (!valid()) throw new Error('The originating chat changed; command cancelled.');
    },
  };
}

export async function copyAssistant(
  controller: SessionController,
  args: string,
  valid: () => boolean
): Promise<boolean> {
  if (args) throw new Error('/copy does not accept arguments.');
  const text = (await controller.copyLastAssistantText())?.trim();
  if (!valid()) throw new Error('The originating chat changed; copy cancelled.');
  if (!text) throw new Error('No agent messages to copy yet.');
  await vscode.env.clipboard.writeText(text);
  return valid();
}
