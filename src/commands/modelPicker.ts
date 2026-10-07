// Shared guided model picker, reused by the composer's chatSettings command,
// "Retry with a different model", and "resend with a different model" on an
// edited message. Extracted so all three stay in sync — one picker.
//
// Provider-first selection keeps large model catalogs manageable. Both steps
// use our separator-agnostic fuzzy matcher so "claude 4.8" still matches an id
// like "claude-4-8" within the selected provider.
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
  /** Raw, icon-free text matched against (separate from the decorated `label`). */
  searchText: string;
}

/** A QuickPick whose visible items are decided ENTIRELY by our own
 * separator-agnostic fuzzy matcher. */
function showFuzzyQuickPick<T extends FuzzyItem>(
  items: T[],
  options: { title: string; placeHolder: string; query?: string }
): Promise<T | undefined> {
  return new Promise((resolve) => {
    const decorated = items.map((item) => ({ ...item, alwaysShow: true }));
    const qp = vscode.window.createQuickPick<T>();
    qp.title = options.title;
    qp.placeholder = options.placeHolder;
    qp.items = decorated;
    qp.onDidChangeValue((value) => {
      if (!value.trim()) {
        qp.items = decorated;
        return;
      }
      qp.items = decorated.filter((item) => fuzzyModelMatch(value, item.searchText));
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
    qp.value = options.query ?? '';
    if (options.query) {
      qp.items = decorated.filter((item) => fuzzyModelMatch(options.query!, item.searchText));
    }
    qp.show();
  });
}

export interface PickedModel {
  provider: string;
  id: string;
}

/** Guided model selection. Thinking remains an explicit, independent control.
 * Returns the picked model's identity so a
 * caller can re-assert it later (e.g. AFTER forking a session — forking may
 * reconcile controller state, and re-applying the model right before sending
 * is the robust way to guarantee the resend actually uses what was picked).
 * Returns undefined on cancel at any step. */
export async function pickChatModel(
  controller: SessionController,
  options?: {
    models?: JsonObject[];
    query?: string;
    modelOnly?: boolean;
    valid?: () => boolean;
    apply?: (provider: string, id: string) => Promise<boolean>;
  }
): Promise<PickedModel | undefined> {
  const models = options?.models ?? (await controller.getAvailableModels());
  const current = asRecord(controller.snapshot.state.model);
  const currentProvider = current ? asString(current.provider) : undefined;
  const currentKey = current ? `${asString(current.provider)}/${asString(current.id)}` : undefined;

  const byProvider = new Map<string, JsonObject[]>();
  for (const model of models) {
    const provider = String(model.provider ?? 'provider');
    (byProvider.get(provider) ?? byProvider.set(provider, []).get(provider)!).push(model);
  }
  const providers = Array.from(byProvider.keys()).sort();

  let provider = providers[0];
  if (providers.length > 1) {
    const providerPick = await showFuzzyQuickPick(
      providers.map((name) => ({
        label: `${name === currentProvider ? '$(check) ' : ''}$(server) ${name}`,
        description: `${byProvider.get(name)?.length ?? 0} model(s)`,
        searchText: name,
        name,
      })),
      {
        title: 'Chat Settings — Provider',
        placeHolder: 'Choose a model provider',
      }
    );
    if (!providerPick) return undefined;
    if (options?.valid && !options.valid()) {
      throw new Error('The originating chat changed; model selection cancelled.');
    }
    provider = providerPick.name;
  }
  if (!provider) return undefined;

  type ModelItem = FuzzyItem & { model: JsonObject };
  const modelItems: ModelItem[] = (byProvider.get(provider) ?? [])
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
    )
    .map((model) => {
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
      return {
        label: `${`${provider}/${id}` === currentKey ? '$(check) ' : ''}${id}`,
        description: name,
        detail: bits.join('  \u00b7  '),
        // Any punctuation/spacing you type — "claude 4.8", "claude-4-8",
        // "claude.4.8" — matches this the same way.
        searchText: [provider, id, name].filter(Boolean).join(' '),
        model,
      };
    });

  const modelPick = await showFuzzyQuickPick(modelItems, {
    query: options?.query,
    title: `Chat Settings — Model (${provider})`,
    placeHolder: 'Choose a model from this provider',
  });
  if (!modelPick) {
    return undefined;
  }
  if (options?.valid && !options.valid()) {
    throw new Error('The originating chat changed; model selection cancelled.');
  }
  const id = String(modelPick.model.id ?? '');
  try {
    if (options?.apply) {
      if (!(await options.apply(provider, id))) return undefined;
    } else {
      await controller.selectModel(provider, id);
    }
  } catch (error) {
    // Surfaced, not swallowed: a caller (e.g. "retry with a different
    // model") comparing before/after model keys would otherwise have no
    // idea WHY nothing changed and silently keep the old model.
    if (options?.modelOnly) throw error;
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

  await controller.refreshState();
  return { provider, id };
}
