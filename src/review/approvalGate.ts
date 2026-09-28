// True pre-apply approval: installs/removes a PROJECT-scoped Pi extension
// (.pi/extensions/pi-approval-gate.ts, registered in .pi/settings.json) that
// gates every file-mutating tool call BEFORE it runs. The gate rides Pi's own
// documented tool_call hook + the extension_ui_request/response subprotocol —
// the exact channel our approval cards already render, so no new UI code is
// needed. Applies everywhere π runs for this project, not just in VS Code.
import * as vscode from 'vscode';
import { GATE_DIR, GATE_FILENAME, mergeApprovalGateSetting } from './approvalGateSettings';

/** Sync one workspace folder's project config to match `enabled`. */
export async function syncApprovalGate(
  folder: vscode.WorkspaceFolder,
  enabled: boolean,
  gateSource: string
): Promise<void> {
  const piDir = vscode.Uri.joinPath(folder.uri, '.pi');
  const gateFile = vscode.Uri.joinPath(piDir, GATE_DIR, GATE_FILENAME);
  const settingsFile = vscode.Uri.joinPath(piDir, 'settings.json');

  if (enabled) {
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(piDir, GATE_DIR));
    await vscode.workspace.fs.writeFile(gateFile, Buffer.from(gateSource, 'utf8'));
  } else {
    // The template's own header says "safe to delete: disabling the setting
    // removes it" — that was only ever half true. Nothing here actually
    // deleted the file when disabling; turning the setting off left the old
    // gate file sitting in .pi/extensions untouched, no longer registered
    // in settings.json but still a real file Pi may still load. That also
    // meant a fixed template could never actually reach an existing
    // workspace: sync only ever WROTE the file when enabled, so if the
    // VS Code setting was already false, the sync ran every activation and
    // never touched the stale file at all.
    try {
      await vscode.workspace.fs.delete(gateFile);
    } catch {
      /* never existed */
    }
  }

  let existing: string | undefined;
  try {
    existing = Buffer.from(await vscode.workspace.fs.readFile(settingsFile)).toString('utf8');
  } catch {
    existing = undefined;
  }
  const next = mergeApprovalGateSetting(existing, enabled);
  if (next === undefined) {
    try {
      await vscode.workspace.fs.delete(settingsFile);
    } catch {
      /* never existed */
    }
    return;
  }
  await vscode.workspace.fs.writeFile(settingsFile, Buffer.from(next, 'utf8'));
}

/** Apply the current setting to every trusted workspace folder. */
export async function syncApprovalGateForWorkspace(
  extensionUri: vscode.Uri,
  enabled: boolean
): Promise<void> {
  if (!vscode.workspace.isTrusted) {
    return;
  }
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    return;
  }
  let gateSource = '';
  if (enabled) {
    const resource = vscode.Uri.joinPath(extensionUri, 'resources', GATE_FILENAME);
    gateSource = Buffer.from(await vscode.workspace.fs.readFile(resource)).toString('utf8');
  }
  await Promise.all(folders.map((folder) => syncApprovalGate(folder, enabled, gateSource)));
}
