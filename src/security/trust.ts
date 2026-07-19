import * as vscode from 'vscode';

export function ensureWorkspaceAvailable(): readonly vscode.WorkspaceFolder[] {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    throw new Error('Open a folder workspace before starting Pi.');
  }
  return folders;
}

export function ensureTrustedForMutation(): void {
  if (!vscode.workspace.isTrusted) {
    throw new Error(
      'Workspace is in Restricted Mode. Start Pi in read-only mode or trust the folder to enable mutating actions.'
    );
  }
}
