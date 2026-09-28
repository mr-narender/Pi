// Shared guided model picker, reused by the composer's chatSettings command,
// "Retry with a different model", and "resend with a different model" on an
// edited message. Extracted so all three stay in sync — one picker.
//
// ONE combined, always-fully-visible list across every provider (grouped by
// section headers, not a forced "pick provider first" step — that hid models
// behind an extra click and made "I don't see all models" a real complaint),
// sorted highest-version-first, and searchable via our own separator-agnostic
// fuzzy matcher (createQuickPick + alwaysShow fully replaces VS Code's native
// filter — otherwise "claude 4.8" can never match an id like "claude-4-8").
import * as vscode from 'vscode';
import { compareModelRankDesc, fuzzyModelMatch } from './modelSearch';
import type { JsonObject } from '../rpc/protocol';
import type { SessionController } from '../sessions/sessionController';

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function formatTokenCount(count: number): string {
  if (count >= 1_000_000) {
    return `${(count / 1_000_000).toFixed(count % 1_000_000 === 0 ? 0 : 1)}M`;
  }
  if (count >= 1000) {
    return `${Math.round(count / 1000)}K`;
  }
  return String(count);
}

interface FuzzyItem extends vscode.QuickPickItem {
  /** Raw, icon-free text matched against (separate from the decorated `label`).
   * Absent on separators, which are never matched or filtered out. */
  searchText?: string;
}

/** A QuickPick whose visible items are decided ENTIRELY by our own
 * separator-agnostic fuzzy matcher. Empty query restores the full grouped
 * list (with section headers); typing narrows to matching models only. */
function showFuzzyQuickPick<T extends FuzzyItem>(
  items: T[],
  options: { title: string; placeHolder: string }
): Promise<T | undefined> {
  return new Promise((resolve) => {
    const decorated = items.map((item) =>
      item.kind === vscode.QuickPickItemKind.Separator ? item : { ...item, alwaysShow: true }
    );
    const qp = vscode.window.createQuickPick<T>();
    qp.title = options.title;
    qp.placeholder = options.placeHolder;
    qp.items = decorated;
    qp.onDidChangeValue((value) => {
      if (!value.trim()) {
        qp.items = decorated;
        return;
      }
      qp.items = decorated.filter(
        (item) =>
          item.kind !== vscode.QuickPickItemKind.Separator &&
          fuzzyModelMatch(value, item.searchText ?? '')
      );
    });
    let picked: T | undefined;
    qp.onDidAccept(() => {
      picked = qp.selectedItems[0];
      qp.hide();
    });
    qp.onDidHide(() => {
      resolve(picked);
      qp.dispose();
    });
    qp.show();
  });
}

export interface PickedModel {
  provider: string;
  id: string;
}

/** Guided model → thinking flow. Returns the picked model's identity so a
 * caller can re-assert it later (e.g. AFTER forking a session — forking may
 * reconcile controller state, and re-applying the model right before sending
 * is the robust way to guarantee the resend actually uses what was picked).
 * Returns undefined on cancel at any step. */
export async function pickChatModel(
  controller: SessionController
): Promise<PickedModel | undefined> {
  const models = await controller.getAvailableModels();
  const current = asRecord(controller.snapshot.state.model);
  const currentKey = current ? `${asString(current.provider)}/${asString(current.id)}` : undefined;
  const currentLevel = asString(controller.snapshot.state.thinkingLevel);

  const byProvider = new Map<string, JsonObject[]>();
  for (const model of models) {
    const provider = String(model.provider ?? 'provider');
    (byProvider.get(provider) ?? byProvider.set(provider, []).get(provider)!).push(model);
  }
  const providers = Array.from(byProvider.keys()).sort();

  type ModelItem = FuzzyItem & { model: JsonObject };
  const flatItems: ModelItem[] = [];
  for (const provider of providers) {
    flatItems.push({
      label: provider,
      kind: vscode.QuickPickItemKind.Separator,
      model: undefined as never,
    });
    const sorted = (byProvider.get(provider) ?? [])
      .slice()
      .sort((a, b) =>
        compareModelRankDesc(
          {
            id: String(a.id ?? ''),
            name: String(a.name ?? ''),
            contextWindow: Number(a.contextWindow) || 0,
          },
          {
            id: String(b.id ?? ''),
            name: String(b.name ?? ''),
            contextWindow: Number(b.contextWindow) || 0,
          }
        )
      );
    for (const model of sorted) {
      const id = String(model.id ?? 'model');
      const name = String(model.name ?? '');
      const inputs = Array.isArray(model.input) ? model.input.map(String) : [];
      const bits = [
        model.reasoning ? '$(lightbulb) thinking' : 'no thinking',
        typeof model.contextWindow === 'number'
          ? `ctx ${formatTokenCount(model.contextWindow)}`
          : undefined,
        typeof model.maxTokens === 'number'
          ? `out ${formatTokenCount(model.maxTokens)}`
          : undefined,
        inputs.includes('image') ? 'images' : undefined,
      ].filter(Boolean);
      flatItems.push({
        label: `${`${provider}/${id}` === currentKey ? '$(check) ' : ''}${id}`,
        description: name,
        detail: bits.join('  \u00b7  '),
        // Any punctuation/spacing you type — "claude 4.8", "claude-4-8",
        // "claude.4.8" — matches this the same way, across every provider.
        searchText: [provider, id, name].filter(Boolean).join(' '),
        model,
      });
    }
  }

  const modelPick = await showFuzzyQuickPick(flatItems, {
    title: 'Chat Settings — Model (all providers)',
    placeHolder: 'Every model, highest version first — type to search across all of them',
  });
  if (!modelPick) {
    return undefined;
  }
  const provider = String(modelPick.model.provider ?? '');
  const id = String(modelPick.model.id ?? '');
  try {
    await controller.selectModel(provider, id);
  } catch (error) {
    // Surfaced, not swallowed: a caller (e.g. "retry with a different
    // model") comparing before/after model keys would otherwise have no
    // idea WHY nothing changed and silently keep the old model.
    const detail = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`Pi: couldn't switch to ${provider}/${id} — ${detail}`);
    return undefined;
  }
  // Confirm the switch actually took, rather than assuming selectModel()
  // resolving means it applied. If the session reports something other
  // than what was just picked, surface that instead of silently
  // proceeding as if the pick worked — reported once as "it still uses
  // the old model" with no visible way to tell whether that was true.
  const applied = asRecord(controller.snapshot.state.model);
  const appliedKey = applied ? `${asString(applied.provider)}/${asString(applied.id)}` : undefined;
  if (appliedKey && appliedKey !== `${provider}/${id}`) {
    void vscode.window.showWarningMessage(
      `Pi: asked for ${provider}/${id}, session reports ${appliedKey} — the switch may not have applied.`
    );
  }

  if (modelPick.model.reasoning) {
    const levelPick = await vscode.window.showQuickPick(
      ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map((level) => ({
        label: `${level === currentLevel ? '$(check) ' : ''}$(lightbulb) ${level}`,
        description: level === currentLevel ? 'current' : '',
        level,
      })),
      { title: `Chat Settings — Thinking (${id})`, placeHolder: 'How hard should it think?' }
    );
    if (levelPick) {
      await controller.setThinkingLevel(levelPick.level);
    }
  }
  await controller.refreshState();
  return { provider, id };
}
