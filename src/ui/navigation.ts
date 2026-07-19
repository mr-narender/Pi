import * as vscode from 'vscode';

export async function openPathInNewWindow(path: string): Promise<void> {
  const uri = vscode.Uri.file(path);
  const stat = await vscode.workspace.fs.stat(uri);
  if (stat.type !== vscode.FileType.Directory) {
    throw new Error('Worktree path must be a directory');
  }
  await vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: true });
}

export async function revealFile(path: string): Promise<void> {
  const uri = vscode.Uri.file(path);
  const document = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(document, { preview: false });
}
