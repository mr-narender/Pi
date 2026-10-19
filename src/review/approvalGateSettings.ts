// Pure logic (no vscode import) so it's directly unit-testable under plain
// Node — see src/review/approvalGate.ts for the vscode-touching filesystem I/O.
export const GATE_DIR = 'extensions';
export const GATE_FILENAME = 'pi-approval-gate.ts';
export const MANUAL_MODE_FILENAME = 'pi-vscode-manual-mode.json';
const SETTINGS_ENTRY = `./${GATE_DIR}/${GATE_FILENAME}`;

/** Preserve project settings and keep exactly one managed hook registration. */
export function mergeApprovalGateSetting(existingJson: string | undefined): string {
  let settings: Record<string, unknown> = {};
  if (existingJson !== undefined) {
    const parsed: unknown = JSON.parse(existingJson);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Pi project settings must be a JSON object.');
    }
    settings = parsed as Record<string, unknown>;
  }
  if ('extensions' in settings && !Array.isArray(settings.extensions)) {
    throw new Error('Pi project extensions must be an array.');
  }
  const current = Array.isArray(settings.extensions) ? (settings.extensions as unknown[]) : [];
  const withoutOurs = current.filter((entry) => entry !== SETTINGS_ENTRY);
  // Keep the hook loaded so a running chat observes both toggle directions.
  const next = [...withoutOurs, SETTINGS_ENTRY];
  if (next.length > 0) {
    settings = { ...settings, extensions: next };
  } else if ('extensions' in settings) {
    settings = Object.fromEntries(Object.entries(settings).filter(([key]) => key !== 'extensions'));
  }
  return JSON.stringify(settings, null, 2) + '\n';
}
