import * as vscode from 'vscode';
import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import type { SessionController } from '../sessions/sessionController';

/** Native first token, no shell escape decoding, trailing arguments ignored. */
export function exportPathArgument(args: string): string | undefined {
  const first = args[0];
  if (first === '"' || first === "'") {
    const end = args.indexOf(first, 1);
    return end < 0 ? undefined : args.slice(1, end) || undefined;
  }
  return args.split(/\s/, 1)[0] || undefined;
}

export async function exportCommand(
  controller: SessionController,
  args: string,
  valid: () => boolean = () => true
): Promise<boolean> {
  if (!vscode.workspace.isTrusted) throw new Error('Export requires a trusted workspace.');
  const folder = controller.folder.uri;
  if (folder.scheme !== 'file') throw new Error('Export requires a local originating folder.');
  // Capture client, session, branch and generation BEFORE any dialog or filesystem wait.
  const intent = controller.captureExportIntent();
  const source = controller.snapshot.state.sessionFile;
  const check = () => {
    if (!valid() || !intent.valid())
      throw new Error('The originating chat or branch changed; export cancelled.');
    const snapshot = controller.snapshot;
    if (
      snapshot.state.isStreaming ||
      snapshot.state.isCompacting ||
      snapshot.retry ||
      snapshot.state.pendingMessageCount ||
      snapshot.switchingSession
    )
      throw new Error(
        'Export requires an idle stable session; streaming snapshots are unsafe. No work or queues were aborted.'
      );
  };
  check();
  let path = exportPathArgument(args);
  if (!path) {
    const target = await vscode.window.showSaveDialog({
      title: 'Export locally — contains private conversation and tool content',
      defaultUri: vscode.Uri.file(resolve(folder.fsPath, 'session.html')),
      filters: { 'HTML or JSONL': ['html', 'jsonl'] },
    });
    check();
    if (!target) return false;
    if (target.scheme !== 'file') throw new Error('Choose a local file for export.');
    path = target.fsPath;
  }
  if (path.includes('\0')) throw new Error('Invalid export path.');
  path = isAbsolute(path) ? resolve(path) : resolve(folder.fsPath, path);
  // No symlink destination, directories, or silent overwrite. Parent must exist.
  // OS aliases (e.g. macOS /var -> /private/var) are legitimate local parents.
  const parent = await realpath(dirname(path));
  check();
  if (typeof source === 'string' && resolve(source) === path)
    throw new Error('Export must not overwrite the native session file.');
  let exists = false;
  let identity: string | undefined;
  const fileIdentity = (stat: Awaited<ReturnType<typeof lstat>>) =>
    `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error('Export destination must be a regular file, not a symlink or directory.');
    exists = true;
    identity = fileIdentity(stat);
    if (typeof source === 'string') {
      try {
        const sourceStat = await lstat(source);
        if (sourceStat.dev === stat.dev && sourceStat.ino === stat.ino)
          throw new Error('Export must not overwrite the native session file.');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  check();
  const choice = await vscode.window.showWarningMessage(
    'Export locally — privacy notice',
    {
      modal: true,
      detail: `This local file contains unredacted conversation, tool arguments/output, file contents and session metadata. HTML includes the full tree; .jsonl includes the current branch. Nothing is uploaded, copied or opened automatically.${exists ? '\nThe existing destination will be overwritten.' : ''}\n${path}`,
    },
    'Export locally'
  );
  check();
  if (choice !== 'Export locally') return false;
  if ((await realpath(dirname(path))) !== parent)
    throw new Error('Export parent changed; export cancelled.');
  let latest: string | undefined;
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error('Export destination changed; export cancelled.');
    latest = fileIdentity(stat);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (latest !== identity)
    throw new Error('Export destination changed; request new overwrite consent.');
  check();
  await intent.write(path, path.endsWith('.jsonl'));
  check();
  return true;
}
