import * as vscode from 'vscode';
import type { ScopedModelRef, ScopedModelsSnapshot } from '../rpc/protocol';
import type { SessionController } from '../sessions/sessionController';

const key = (r: ScopedModelRef) => JSON.stringify([r.provider, r.id]);
/** Display order is not application order. Retained refs keep their thinking;
 * new selections append in canonical identity order. All/empty = unrestricted. */
export function orderScopedSelection(
  snapshot: ScopedModelsSnapshot,
  chosen: ScopedModelRef[]
): ScopedModelRef[] {
  if (!chosen.length || chosen.length === snapshot.models.length) return [];
  const selected = new Set(chosen.map(key));
  const retained = snapshot.scoped.filter((r) => selected.has(key(r))).map((r) => ({ ...r }));
  const prior = new Set(retained.map(key));
  return [
    ...retained,
    ...chosen
      .filter((r) => !prior.has(key(r)))
      .sort((a, b) => key(a).localeCompare(key(b)))
      .map((r) => ({ provider: r.provider, id: r.id })),
  ];
}

export async function pickScopedModels(
  controller: SessionController,
  valid: () => boolean,
  mutate: (action: () => Promise<void>) => Promise<boolean>
): Promise<boolean> {
  const snapshot = await controller.getScopedModels();
  if (!valid()) return false;
  const active = new Set(snapshot.scoped.map(key));
  const missingActive = snapshot.scoped.filter(
    (r) => !snapshot.models.some((m) => m.provider === r.provider && m.id === r.id)
  );
  const provenance = [
    missingActive.length
      ? `Applying replaces unavailable session refs: ${missingActive.map((r) => `${r.provider}/${r.id}`).join(', ')}.`
      : '',
    snapshot.startupPatterns ? `Startup CLI patterns: ${snapshot.startupPatterns.join(', ')}.` : '',
    snapshot.projectOverride
      ? 'Project enabledModels overrides global defaults; project settings will not change.'
      : '',
    snapshot.globalPatterns?.length
      ? `Saved global patterns: ${snapshot.globalPatterns.join(', ')}`
      : '',
    snapshot.diagnostics.length
      ? `Unavailable effective patterns: ${snapshot.diagnostics.map((d) => d.pattern).join(', ')}`
      : '',
  ]
    .filter(Boolean)
    .join(' ');
  const picked = await vscode.window.showQuickPick(
    snapshot.models.map((m) => ({
      label: m.name ?? m.id,
      description: `${m.provider}/${m.id}`,
      picked: !active.size || active.has(key({ provider: m.provider!, id: m.id })),
      ref: { provider: m.provider!, id: m.id },
    })),
    {
      canPickMany: true,
      title: 'Scoped models — staged selection',
      placeHolder:
        'All or none means unrestricted. Retained order/thinking is preserved; new models append by identity.',
      ignoreFocusOut: true,
    }
  );
  if (!picked || !valid()) return false;
  const refs = orderScopedSelection(
    snapshot,
    picked.map((p) => p.ref)
  );
  const decision = await vscode.window.showQuickPick(
    [
      { label: 'Apply to this session only', save: false, detail: provenance },
      {
        label: 'Apply and save GLOBAL enabledModels',
        save: true,
        detail: `${provenance} Replaces global patterns${snapshot.globalDiagnostics.length ? ', including unavailable patterns' : ''}. Empty [] is unrestricted at startup. Native locked storage is not crash-atomic.`,
      },
    ],
    {
      title: 'Apply staged scoped models?',
      placeHolder: 'Escape cancels every change. Current/default model and prompt are unchanged.',
      ignoreFocusOut: true,
    }
  );
  if (!decision || !valid()) return false;
  return mutate(() => controller.applyScopedModels(refs, snapshot.revision, decision.save, true));
}
