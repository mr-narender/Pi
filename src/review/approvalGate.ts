// Keep the managed project tool-call hook loaded in both modes. Only its
// atomic mode marker changes, so warm and active sessions see each toggle.
import * as vscode from 'vscode';
import {
  GATE_DIR,
  GATE_FILENAME,
  MANUAL_MODE_FILENAME,
  mergeApprovalGateSetting,
} from './approvalGateSettings';

let syncQueue = Promise.resolve();
let toggleQueue = Promise.resolve();
let syncError: string | undefined;
let requestedMode = false;
let managedExtensionUri: vscode.Uri | undefined;
const preparedFolders = new Map<string, vscode.WorkspaceFolder>();

export function isManualModeRequested(): boolean {
  return requestedMode;
}

export function assertManualModeExtensionsEnabled(
  additionalArgs: readonly string[],
  enabled = requestedMode
): void {
  if (enabled && additionalArgs.some((arg) => arg === '--no-extensions' || arg === '-ne')) {
    throw new Error(
      'Manual Mode requires Pi extensions. Remove --no-extensions / -ne or turn Manual Mode off.'
    );
  }
}

export function approvalGateSyncError(): string | undefined {
  return syncError;
}

/** Prompt admission waits for the latest requested project policy to settle. */
export async function waitForApprovalGateSync(): Promise<void> {
  let pending: Promise<void>;
  let toggles: Promise<void>;
  do {
    toggles = toggleQueue;
    await toggles.catch(() => undefined);
    pending = syncQueue;
    await pending.catch((error: unknown) => {
      if (requestedMode) throw error;
    });
  } while (pending !== syncQueue || toggles !== toggleQueue);
}

/** Exact session roots can differ from the folders listed in a saved workspace. */
export async function prepareApprovalGateForFolder(folder: vscode.WorkspaceFolder): Promise<void> {
  if (!managedExtensionUri || !vscode.workspace.isTrusted) return;
  const key = folder.uri.fsPath;
  if (!preparedFolders.has(key)) {
    preparedFolders.set(key, folder);
    await syncApprovalGateForWorkspace(managedExtensionUri, requestedMode).catch(
      (error: unknown) => {
        if (requestedMode) throw error;
      }
    );
  }
  await waitForApprovalGateSync();
}

/** Persist configuration before changing effective policy; serialize rapid clicks. */
export function toggleApprovalGateMode(
  extensionUri: vscode.Uri,
  readMode: () => boolean,
  persistMode: (enabled: boolean) => PromiseLike<void>
): Promise<void> {
  const next = toggleQueue
    .catch(() => undefined)
    .then(async () => {
      const enabled = !readMode();
      await persistMode(enabled);
      await syncApprovalGateForWorkspace(extensionUri, enabled);
    });
  toggleQueue = next;
  return next;
}

/** Sync one workspace folder's project config to match `enabled`. */
export async function syncApprovalGate(
  folder: vscode.WorkspaceFolder,
  enabled: boolean,
  gateSource: string
): Promise<void> {
  const piDir = vscode.Uri.joinPath(folder.uri, '.pi');
  const gateFile = vscode.Uri.joinPath(piDir, GATE_DIR, GATE_FILENAME);
  const settingsFile = vscode.Uri.joinPath(piDir, 'settings.json');

  let existing: string | undefined;
  try {
    existing = Buffer.from(await vscode.workspace.fs.readFile(settingsFile)).toString('utf8');
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code !== 'FileNotFound' && code !== 'ENOENT') throw error;
  }
  const next = mergeApprovalGateSetting(existing);

  await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(piDir, GATE_DIR));
  const modeFile = vscode.Uri.joinPath(piDir, MANUAL_MODE_FILENAME);
  const pendingModeFile = vscode.Uri.joinPath(piDir, `${MANUAL_MODE_FILENAME}.pending`);
  await vscode.workspace.fs.writeFile(pendingModeFile, Buffer.from(JSON.stringify({ enabled })));
  await vscode.workspace.fs.rename(pendingModeFile, modeFile, { overwrite: true });
  await vscode.workspace.fs.writeFile(gateFile, Buffer.from(gateSource, 'utf8'));

  await vscode.workspace.fs.writeFile(settingsFile, Buffer.from(next, 'utf8'));
}

/** Apply the current setting to every trusted workspace folder. */
async function syncWorkspace(extensionUri: vscode.Uri, enabled: boolean): Promise<void> {
  if (!vscode.workspace.isTrusted) {
    if (enabled) throw new Error('Manual Mode requires a trusted workspace.');
    return;
  }
  const folders = [
    ...new Map([
      ...(vscode.workspace.workspaceFolders ?? []).map(
        (folder) => [folder.uri.fsPath, folder] as const
      ),
      ...preparedFolders,
    ]).values(),
  ];
  if (folders.length === 0) {
    return;
  }
  const resource = vscode.Uri.joinPath(extensionUri, 'resources', GATE_FILENAME);
  const gateSource = Buffer.from(await vscode.workspace.fs.readFile(resource)).toString('utf8');
  const results = await Promise.allSettled(
    folders.map((folder) => syncApprovalGate(folder, enabled, gateSource))
  );
  const failed = results.find((result) => result.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
}

/** Serialize rapid toggles; a failed write must remain visible until a successful sync. */
export function syncApprovalGateForWorkspace(
  extensionUri: vscode.Uri,
  enabled: boolean
): Promise<void> {
  requestedMode = enabled;
  managedExtensionUri = extensionUri;
  const next = syncQueue
    .catch(() => undefined)
    .then(async () => {
      try {
        await syncWorkspace(extensionUri, enabled);
        syncError = undefined;
      } catch (error) {
        syncError = error instanceof Error ? error.message : String(error);
        throw error;
      }
    });
  syncQueue = next;
  return next;
}
