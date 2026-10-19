import { createHash } from 'node:crypto';
import {
  lstat,
  readFile,
  writeFile,
  unlink,
  mkdtemp,
  realpath,
  mkdir,
  chmod,
} from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import * as vscode from 'vscode';

export interface UndoState {
  digest: string | null;
  mode?: number;
  inode?: number;
  path?: string;
}

async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(path) === path) throw error;
    return join(await canonicalPath(dirname(path)), basename(path));
  }
}

export async function resolveUndoUri(cwd: string, file: string): Promise<vscode.Uri> {
  const path = resolve(cwd, file);
  const root = await realpath(cwd);
  const lexical = relative(resolve(cwd), path);
  const canonical = relative(root, await canonicalPath(path));
  if (
    [lexical, canonical].some(
      (value) =>
        isAbsolute(value) || value === '..' || value.startsWith('../') || value.startsWith('..\\')
    )
  )
    throw new Error('Undo file is outside its recorded folder.');
  return vscode.Uri.file(path);
}

export async function captureUndoState(uri: vscode.Uri): Promise<UndoState> {
  try {
    const stat = await lstat(uri.fsPath);
    if (!stat.isFile()) throw new Error('Undo requires a regular file.');
    const bytes = await readFile(uri.fsPath);
    const final = await lstat(uri.fsPath);
    if (
      final.ino !== stat.ino ||
      final.mtimeMs !== stat.mtimeMs ||
      final.size !== stat.size ||
      !final.isFile()
    )
      throw new Error('File changed while recording Undo.');
    return {
      digest: createHash('sha256').update(bytes).digest('hex'),
      mode: stat.mode,
      inode: stat.ino,
      path: await realpath(uri.fsPath),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { digest: null, path: await canonicalPath(uri.fsPath) };
    throw error;
  }
}

async function dirtyDocument(uri: vscode.Uri): Promise<boolean> {
  const target = await realpath(uri.fsPath).catch(() => uri.fsPath);
  for (const document of vscode.workspace.textDocuments) {
    if (
      document.isDirty &&
      (document.uri.fsPath === uri.fsPath ||
        (await realpath(document.uri.fsPath).catch(() => document.uri.fsPath)) === target)
    )
      return true;
  }
  return false;
}

export async function matchesUndoState(
  uri: vscode.Uri,
  expected: UndoState | undefined
): Promise<boolean> {
  if (!expected?.path || !vscode.workspace.isTrusted || (await dirtyDocument(uri))) return false;
  try {
    return JSON.stringify(await captureUndoState(uri)) === JSON.stringify(expected);
  } catch {
    return false;
  }
}

/** Comparisons are opened only after an explicit click; nothing overwrites a conflict. */
export async function showUndoConflict(
  uri: vscode.Uri,
  before?: Buffer,
  after?: Buffer
): Promise<void> {
  const choice = await vscode.window.showWarningMessage(
    after === undefined
      ? 'This change has no saved Pi result. Automatic Undo cannot be verified.'
      : 'This file has changed since Pi edited it.',
    'Review changes',
    'Keep current file'
  );
  if (choice !== 'Review changes') return;
  const choices = [
    ...(before !== undefined
      ? [{ label: 'Before Pi ↔ Current file', left: before, right: undefined }]
      : []),
    ...(after !== undefined
      ? [{ label: 'Pi result ↔ Current file', left: after, right: undefined }]
      : []),
    ...(before !== undefined && after !== undefined
      ? [{ label: 'Before Pi ↔ Pi result', left: before, right: after }]
      : []),
  ];
  if (choices.length === 0) {
    await vscode.window.showTextDocument(uri, { preview: true });
    return;
  }
  const selected = await vscode.window.showQuickPick(choices, {
    title: basename(uri.fsPath),
    placeHolder: 'Compare saved versions; your current file is kept.',
  });
  if (!selected) return;
  const temporary = join(tmpdir(), 'pi-extension', 'undo');
  await mkdir(temporary, { recursive: true });
  const directory = await mkdtemp(join(temporary, 'comparison-'));
  const left = join(directory, `before-${basename(uri.fsPath)}`);
  await writeFile(left, selected.left);
  let right = uri;
  if (selected.right !== undefined) {
    const file = join(directory, `result-${basename(uri.fsPath)}`);
    await writeFile(file, selected.right);
    right = vscode.Uri.file(file);
  }
  await vscode.commands.executeCommand('vscode.diff', vscode.Uri.file(left), right, selected.label);
}

export async function restoreUndoFile(
  uri: vscode.Uri,
  expected: UndoState | undefined,
  before: Buffer | null,
  after?: Buffer,
  mode?: number,
  valid: () => boolean = () => true
): Promise<boolean> {
  if (!valid()) return false;
  if (!(await matchesUndoState(uri, expected))) {
    await showUndoConflict(uri, before ?? Buffer.alloc(0), after);
    return false;
  }
  // Recheck after all asynchronous inspection; no UI wait can bless newer content.
  if (
    !(await matchesUndoState(uri, expected)) ||
    !valid() ||
    vscode.workspace.textDocuments.some(
      (document) => document.uri.fsPath === uri.fsPath && document.isDirty
    )
  )
    return false;
  if (before === null) await unlink(uri.fsPath);
  else {
    await writeFile(
      uri.fsPath,
      before,
      expected?.digest === null ? { flag: 'wx', mode } : undefined
    );
    if (mode !== undefined) await chmod(uri.fsPath, mode);
  }
  return true;
}

/** A surgical card undo can retain unrelated edits, but never guess among matching regions. */
export function reverseEditReplacements(
  text: string,
  changes: Array<{ oldText: string; newText: string }>
): string | undefined {
  for (const change of [...changes].reverse()) {
    if (!change.newText) return undefined;
    const at = text.indexOf(change.newText);
    if (at < 0 || text.indexOf(change.newText, at + 1) >= 0) return undefined;
    text = text.slice(0, at) + change.oldText + text.slice(at + change.newText.length);
  }
  return text;
}

export async function undoTextChanges(
  uri: vscode.Uri,
  expected: UndoState | undefined,
  changes: Array<{ oldText: string; newText: string }>,
  valid: () => boolean
): Promise<boolean> {
  if (!(await matchesUndoState(uri, expected))) {
    await showUndoConflict(
      uri,
      undefined,
      expected ? Buffer.from(changes.map((change) => change.newText).join('\n')) : undefined
    );
    return false;
  }
  const current = await readFile(uri.fsPath);
  if (createHash('sha256').update(current).digest('hex') !== expected!.digest) return false;
  const text = current.toString('utf8');
  const before = Buffer.from(text).equals(current)
    ? reverseEditReplacements(text, changes)
    : undefined;
  if (before === undefined) {
    await showUndoConflict(uri, undefined, current);
    return false;
  }
  return restoreUndoFile(uri, expected, Buffer.from(before), current, undefined, valid);
}
