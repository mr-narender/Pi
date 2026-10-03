// Pure logic (no vscode import) so it's directly unit-testable under plain
// Node — see src/review/approvalGate.ts for the vscode-touching filesystem I/O.
export const GATE_DIR = 'extensions';
export const GATE_FILENAME = 'pi-approval-gate.ts';
const SETTINGS_ENTRY = `./${GATE_DIR}/${GATE_FILENAME}`;

/** Pure JSON merge — testable without touching the filesystem. Returns the
 * new file text, or `undefined` when the settings file should be deleted
 * entirely (we created it and nothing else uses it). */
export function mergeApprovalGateSetting(
  existingJson: string | undefined,
  enabled: boolean
): string | undefined {
  let settings: Record<string, unknown> = {};
  if (existingJson) {
    try {
      const parsed: unknown = JSON.parse(existingJson);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        settings = parsed as Record<string, unknown>;
      }
    } catch {
      settings = {};
    }
  }
  const current = Array.isArray(settings.extensions) ? (settings.extensions as unknown[]) : [];
  const withoutOurs = current.filter((entry) => entry !== SETTINGS_ENTRY);
  const next = enabled ? [...withoutOurs, SETTINGS_ENTRY] : withoutOurs;
  if (next.length > 0) {
    settings = { ...settings, extensions: next };
  } else if ('extensions' in settings) {
    settings = Object.fromEntries(Object.entries(settings).filter(([key]) => key !== 'extensions'));
  }
  return Object.keys(settings).length === 0 ? undefined : JSON.stringify(settings, null, 2) + '\n';
}
