// vscode.workspace.fs read/merge/write for one settings.json — same
// read-merge-write shape as review/approvalGate.ts (using vscode's own fs
// API, not raw Node fs, so this works correctly under remote workspaces
// too), generalized to any resource kind/op via resourceSettings.ts.
import * as vscode from 'vscode';
import { agentDir, settingsFilePath } from './resourceLocations';
import { mergeResourceEntry, type ResourceEntryOp } from './resourceSettings';
import type { ResourceKind, ResourceScope } from './resourceTypes';

async function readTextIfExists(uri: vscode.Uri): Promise<string | undefined> {
  try {
    return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
  } catch {
    return undefined;
  }
}

function settingsUri(scope: ResourceScope, projectRoot: string): vscode.Uri {
  return vscode.Uri.file(settingsFilePath(scope, projectRoot));
}

/** Apply one change to one settings.json (user or project), creating the
 * <agent-dir> directory first if writing a user-scope file that doesn't
 * exist yet (project .pi/ is assumed to already exist — every project this
 * manager runs against already went through project trust, which implies
 * .pi/ exists). */
export async function applyResourceChange(
  scope: ResourceScope,
  projectRoot: string,
  kind: ResourceKind,
  op: ResourceEntryOp,
  entryPath: string
): Promise<void> {
  const uri = settingsUri(scope, projectRoot);
  const existing = await readTextIfExists(uri);
  const next = mergeResourceEntry(existing, kind, op, entryPath);
  if (next === undefined) {
    try {
      await vscode.workspace.fs.delete(uri);
    } catch {
      /* never existed */
    }
    return;
  }
  if (scope === 'user') {
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(agentDir()));
  }
  await vscode.workspace.fs.writeFile(uri, Buffer.from(next, 'utf8'));
}

/** Read-only: the raw settings.json text for one scope, or undefined if it
 * doesn't exist — used by the manager to compute enabled state and to
 * build an export snapshot without writing anything. */
export async function readResourceSettingsText(
  scope: ResourceScope,
  projectRoot: string
): Promise<string | undefined> {
  return readTextIfExists(settingsUri(scope, projectRoot));
}
