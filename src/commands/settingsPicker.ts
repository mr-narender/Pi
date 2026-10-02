import * as vscode from 'vscode';
import type { SessionController } from '../sessions/sessionController';
import type { PreferenceValue } from '../rpc/preferences';

const text = (v: PreferenceValue) => (v === null ? '(unset / native default)' : String(v));
/** Native UI, staged one-field personal default intent. No terminal appearance
 * presets and no implied project-trust grant, dispatcher update or resource reload. */
export async function pickSettings(
  controller: SessionController,
  args: string,
  valid: () => boolean,
  mutate: (action: () => Promise<void>) => Promise<boolean>
): Promise<boolean> {
  if (args) throw new Error('/settings does not accept arguments.');
  const section = await vscode.window.showQuickPick(
    [
      {
        label: 'Engine preferences',
        detail: 'Edit native engine personal defaults; view while busy, save only when idle.',
        engine: true,
      },
      {
        label: 'Terminal-only controls — information',
        detail:
          '34 native controls (32 without terminal images). VS Code appearance remains VS Code.',
        engine: false,
      },
    ],
    { title: 'Pi /settings', ignoreFocusOut: true }
  );
  if (!section || !valid()) return false;
  if (!section.engine) {
    await vscode.window.showInformationMessage(
      'Terminal-only: inline image display/width, cursor, editor/output padding, autocomplete, shrink/progress, hide-thinking, Mermaid/cache notices, startup/changelog, Escape/tree keys, fullscreen controls and theme. These do not change this GUI. Retry limits, compaction token reserves and WebSocket timeout have no public setters.'
    );
    return false;
  }
  const snapshot = await controller.getPreferences();
  if (!valid()) return false;
  const chosen = await vscode.window.showQuickPick(
    snapshot.rows.map((row) => ({
      label: row.label,
      description: `Effective ${text(row.effective)} · active ${text(row.active)}`,
      detail: `Global ${text(row.global)} · project ${text(row.project)} · source ${row.source} · ${row.effect}`,
      row,
    })),
    { title: 'Engine preferences — choose one personal default', ignoreFocusOut: true }
  );
  if (!chosen || !valid()) return false;
  const row = chosen.row;
  let value: PreferenceValue;
  if (row.choices) {
    const picked = await vscode.window.showQuickPick(
      row.choices.map((value) => ({ label: text(value), value })),
      { title: `Stage ${row.label}`, ignoreFocusOut: true }
    );
    if (!picked || !valid()) return false;
    value = picked.value;
  } else {
    const input = await vscode.window.showInputBox({
      title: row.label,
      prompt: 'Nonnegative integer milliseconds; 0 disables. Persistence only; next start applies.',
      value: String(row.effective ?? 300000),
      ignoreFocusOut: true,
      validateInput: (v) =>
        /^\d+$/.test(v) && Number.isSafeInteger(Number(v))
          ? undefined
          : 'Enter a nonnegative safe integer.',
    });
    if (input === undefined || !valid()) return false;
    if (!/^\d+$/.test(input) || !Number.isSafeInteger(Number(input)))
      throw new Error('Invalid HTTP idle timeout.');
    value = Number(input);
  }
  const paid = row.key === 'cacheWarming' && value !== 'off';
  const confirmation = await vscode.window.showQuickPick(
    [
      {
        label: paid
          ? 'Save GLOBAL default — consent to paid cache warming'
          : 'Save GLOBAL personal default',
        save: true,
      },
      { label: 'Cancel — no change', save: false },
    ],
    {
      title: `${row.label}: ${text(value)}`,
      placeHolder: `Global only; project/startup precedence remains. ${row.effect === 'next-start' ? 'Pending runtime / next start; no reload.' : 'Explicit active queue/transport choice can differ from effective defaults.'} ${paid ? 'Cache refreshes may cost money.' : ''} Native storage is not crash-atomic.`,
      ignoreFocusOut: true,
    }
  );
  if (!confirmation?.save || !valid()) return false;
  return mutate(async () => {
    const result = await controller.savePreference(row.key, value, snapshot.revision, paid);
    const saved = result.rows.find((r) => r.key === row.key)!;
    // Save already succeeded. Notification dismissal is not a second cancellation.
    try {
      void Promise.resolve(
        vscode.window.showInformationMessage(
          `Saved global ${text(saved.global)}; effective ${text(saved.effective)}; active ${text(saved.active)} (${saved.effect}).`
        )
      ).catch(() => {});
    } catch {
      // Native persistence succeeded; notification failure is not a failed save.
    }
  });
}
