import * as vscode from 'vscode';
import type { SessionController } from '../sessions/sessionController';
import { beginReadOnlyCommand } from './readOnlyCommand';
import { createRedactedDiagnosticsExport } from '../diagnostics/export';

/** Inspect immutable bytes before explicitly accepting Done, Copy or Save.
 * Cached data only: no native provider, configuration or credential lookup. */
export async function previewDiagnostics(
  controller: SessionController | undefined,
  args = '',
  valid?: () => boolean
): Promise<boolean> {
  if (args) throw new Error('/debug does not accept arguments.');
  const intent = controller && !valid ? beginReadOnlyCommand(controller) : undefined;
  const current = valid ?? intent?.valid ?? (() => true);
  const check = () => {
    if (!current()) throw new Error('The originating chat changed; diagnostics cancelled.');
  };
  try {
    if (intent) await intent.ready();
    check();
    const payload = JSON.stringify(createRedactedDiagnosticsExport(undefined, controller), null, 2);
    const action = await vscode.window.showInformationMessage(
      'Safe local diagnostics (cached metrics only)',
      { modal: true, detail: payload },
      'Done',
      'Copy JSON',
      'Save JSON'
    );
    check();
    if (action === 'Done') return true;
    if (action === 'Copy JSON') {
      await vscode.env.clipboard.writeText(payload);
      return current();
    }
    if (action !== 'Save JSON') return false;
    const target = await vscode.window.showSaveDialog({ filters: { JSON: ['json'] } });
    check();
    if (!target) return false;
    await vscode.workspace.fs.writeFile(target, Buffer.from(payload, 'utf8'));
    return current();
  } catch {
    if (!current()) throw new Error('The originating chat changed; diagnostics cancelled.');
    throw new Error('Local diagnostics could not be displayed, copied or saved.');
  } finally {
    intent?.finish();
  }
}
