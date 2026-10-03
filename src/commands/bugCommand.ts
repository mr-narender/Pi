import * as vscode from 'vscode';
import { consentedTransfer } from './consentedTransfer';
import { open, realpath, lstat } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { SessionController } from '../sessions/sessionController';
import { createRedactedDiagnosticsExport } from '../diagnostics/export';
import { bugZip, type BugFile } from './bugArchive';

/** Narrow native-compatible multipart report, or reviewed local ZIP. No logs/env/auth/config collection. */
export async function bugCommand(
  controller: SessionController,
  description: string,
  valid: () => boolean
) {
  if (description.length > 16384) throw new Error('Bug description exceeds 16 KiB.');
  const intent = controller.captureDeliveryIntent();
  const current = () => valid() && intent.valid();
  const diagnostics = createRedactedDiagnosticsExport(undefined, controller);
  const transcript = await vscode.window.showQuickPick(
    [
      { label: 'Include current branch transcript', include: true },
      { label: 'Do not include transcript', include: false },
    ],
    { title: 'Bug report transcript privacy — transcript may contain secrets/files/tool output' }
  );
  if (!transcript || !current()) return false;
  const files: BugFile[] = [
    {
      name: 'report.json',
      contentType: 'application/json',
      data: JSON.stringify(
        {
          schemaVersion: 1,
          createdAt: new Date().toISOString(),
          hint: description || null,
          session: { included: transcript.include, summaryIncluded: false },
          gui: diagnostics.guiVersion,
        },
        null,
        2
      ),
    },
    {
      name: 'diagnostics.json',
      contentType: 'application/json',
      data: JSON.stringify(diagnostics, null, 2),
    },
  ];
  if (transcript.include) {
    const payload = await intent.payload(false);
    if (!current()) return false;
    files.push({ name: 'session.jsonl', contentType: 'application/x-ndjson', data: payload.jsonl });
  }
  const zip = bugZip(files);
  const destination = await vscode.window.showQuickPick(
    [
      { label: 'Upload anonymously to Radius bug reports', upload: true },
      { label: 'Save local ZIP (no upload)', upload: false },
    ],
    { title: 'Choose bug report delivery — no account lookup or paid summary' }
  );
  if (!destination || !current()) return false;
  const consent = await vscode.window.showWarningMessage(
    destination.upload
      ? 'Upload this bug report to https://radius.pi.dev/v1/bug-reports?'
      : 'Save reviewed bug ZIP locally?',
    {
      modal: true,
      detail: `Description and closed cached diagnostics only; raw env/auth/settings/paths/errors/logs omitted. ${transcript.include ? 'Transcript is UNREDACTED; includes cwd, files, messages and tool content.' : 'No transcript.'} No provider summary/cost. Exact files:\n${files.map((f) => `${f.name}\n${f.data}`).join('\n')}`,
    },
    destination.upload ? 'Upload' : 'Save ZIP'
  );
  if (!current() || consent !== (destination.upload ? 'Upload' : 'Save ZIP')) return false;
  if (destination.upload) {
    try {
      const body = new FormData();
      for (const file of files)
        body.append(file.name, new Blob([file.data], { type: file.contentType }), file.name);
      const { response, json } = await consentedTransfer(
        'Uploading reviewed bug report',
        current,
        async (signal) => {
          const response = await fetch('https://radius.pi.dev/v1/bug-reports', {
            method: 'POST',
            redirect: 'error',
            body,
            signal,
          });
          const json = (await response.json()) as { ok?: boolean; bug_report?: { id?: unknown } };
          return { response, json };
        }
      );
      if (
        !response.ok ||
        json.ok !== true ||
        typeof json.bug_report?.id !== 'string' ||
        !/^[\w-]{1,128}$/.test(json.bug_report.id)
      )
        throw new Error('Delivery failed.');
      if (!current()) return false;
      await vscode.window.showInformationMessage(`Bug report delivered: ${json.bug_report.id}`);
      return current();
    } catch {
      throw new Error('Bug report delivery failed/cancelled. No upload success is claimed.');
    }
  }
  const target = await vscode.window.showSaveDialog({
    title: 'Save reviewed bug ZIP',
    filters: { ZIP: ['zip'] },
  });
  if (!target || !current()) return false;
  if (target.scheme !== 'file' || target.fsPath.includes('\0'))
    throw new Error('Choose a local regular ZIP file.');
  const parent = await realpath(dirname(target.fsPath));
  // Exclusive create: existing destinations are refused, never silently overwritten.
  try {
    await lstat(target.fsPath);
    throw new Error('Destination exists; choose a new file.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (!current() || (await realpath(dirname(target.fsPath))) !== parent) return false;
  const handle = await open(target.fsPath, 'wx', 0o600);
  try {
    if (!current()) return false;
    await handle.writeFile(zip);
  } finally {
    await handle.close();
  }
  return current();
}
