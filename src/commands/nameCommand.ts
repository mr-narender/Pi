import * as vscode from 'vscode';
import type { SessionController } from '../sessions/sessionController';
import { beginReadOnlyCommand } from './readOnlyCommand';

/** Refresh the originating chat's existing title/recents flows, never active focus. */
export function trackSessionName(
  controller: SessionController,
  refreshRecent: (folder: vscode.WorkspaceFolder) => Promise<unknown>,
  refreshViews: () => void
): vscode.Disposable {
  let name = controller.snapshot.state.sessionName;
  let sessionId = controller.snapshot.state.sessionId;
  let sessionFile = controller.snapshot.state.sessionFile;
  return controller.onDidChangeState(() => {
    const next = controller.snapshot.state.sessionName;
    const identity = controller.snapshot.state;
    if (next !== name || identity.sessionId !== sessionId || identity.sessionFile !== sessionFile) {
      name = next;
      sessionId = identity.sessionId;
      sessionFile = identity.sessionFile;
      void refreshRecent(controller.folder).then(refreshViews);
    }
    refreshViews();
  });
}

export async function setChatName(
  controller: SessionController,
  name: string,
  valid: () => boolean
): Promise<boolean> {
  if (!valid()) throw new Error('The originating chat changed; rename cancelled.');
  await controller.renameSession(name.trim());
  if (!valid()) throw new Error('The originating chat changed; rename cancelled.');
  const normalized = controller.snapshot.state.sessionName;
  if (typeof normalized !== 'string' || !normalized) {
    throw new Error('Session name persistence could not be confirmed.');
  }
  void vscode.window.showInformationMessage(`Session name set: ${normalized}`);
  return true;
}

/** Menu rename captures origin BEFORE opening the dialog. Cancellation writes nothing. */
export async function promptChatName(controller: SessionController, supplied?: string) {
  const intent = beginReadOnlyCommand(controller);
  await intent.ready();
  const name =
    supplied ??
    (await vscode.window.showInputBox({
      title: 'Rename chat',
      value:
        typeof controller.snapshot.state.sessionName === 'string'
          ? controller.snapshot.state.sessionName
          : '',
      prompt: 'Enter a name for this chat',
    }));
  if (name === undefined || !name.trim()) return false;
  return setChatName(controller, name, intent.valid);
}

export async function nameCommand(
  controller: SessionController,
  args: string,
  valid: () => boolean
) {
  if (args) return setChatName(controller, args, valid);
  if (!valid()) throw new Error('The originating chat changed; command cancelled.');
  const name = controller.snapshot.state.sessionName;
  if (typeof name === 'string' && name) {
    void vscode.window.showInformationMessage(`Session name: ${name}`);
  } else {
    void vscode.window.showWarningMessage('Usage: /name <name>');
  }
  return true;
}
