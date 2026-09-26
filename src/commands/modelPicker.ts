// Shared guided model+thinking picker (provider → model → thinking), reused
// by both the composer's chatSettings command and "resend with a different
// model" on an edited message. Extracted so both paths stay in sync — one
// picker, two entry points.
//
// Uses createQuickPick + alwaysShow (not showQuickPick) for the provider and
// model steps so OUR normalized fuzzy matcher fully replaces VS Code's native
// filter — otherwise "claude 4.8" can never match an id like "claude-4-8"
// (a literal space has nothing to match against a hyphen).
import * as vscode from 'vscode';
import { fuzzyModelMatch } from './modelSearch';
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
 * separator-agnostic fuzzy matcher (alwaysShow bypasses VS Code's own filter). */
function showFuzzyQuickPick<T extends FuzzyItem>(
  items: T[],
  options: { title: string; placeHolder: string }
): Promise<T | undefined> {
  return new Promise((resolve) => {
    const decorated = items.map((item) => ({ ...item, alwaysShow: true }));
    const qp = vscode.window.createQuickPick<T>();
    qp.title = options.title;
    qp.placeholder = options.placeHolder;
    qp.items = decorated;
    qp.onDidChangeValue((value) => {
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
    qp.show();
  });
}

/** Guided 1/3 provider → 2/3 model → 3/3 thinking flow. Returns whether a
 * model was actually picked (false on cancel at any step). */
export async function pickChatModel(controller: SessionController): Promise<boolean> {
  const models = await controller.getAvailableModels();
  const current = asRecord(controller.snapshot.state.model);
  const currentProvider = current ? asString(current.provider) : undefined;
  const currentKey = current ? `${asString(current.provider)}/${asString(current.id)}` : undefined;
  const currentLevel = asString(controller.snapshot.state.thinkingLevel);

  const byProvider = new Map<string, JsonObject[]>();
  for (const model of models) {
    const provider = String(model.provider ?? 'provider');
    (byProvider.get(provider) ?? byProvider.set(provider, []).get(provider)!).push(model);
  }
  const providers = Array.from(byProvider.keys()).sort();

  let provider = providers[0];
  if (providers.length > 1) {
    const pick = await showFuzzyQuickPick(
      providers.map((name) => ({
        label: `${name === currentProvider ? '$(check) ' : ''}$(server) ${name}`,
        description: `${byProvider.get(name)?.length ?? 0} model(s)`,
        searchText: name,
        name,
      })),
      {
        title: 'Chat Settings — 1/3: Provider',
        placeHolder: 'Which LLM provider? (try "claude 4.8" style spacing)',
      }
    );
    if (!pick) {
      return false;
    }
    provider = pick.name;
  }
  if (!provider) {
    return false;
  }

  const modelPick = await showFuzzyQuickPick(
    (byProvider.get(provider) ?? [])
      .slice()
      .sort((a, b) => String(a.id ?? '').localeCompare(String(b.id ?? '')))
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
      }),
    {
      title: `Chat Settings — 2/3: Model (${provider})`,
      placeHolder: 'Which model? (spaces, dots, and hyphens all match)',
    }
  );
  if (!modelPick) {
    return false;
  }
  await controller.selectModel(provider, String(modelPick.model.id ?? ''));

  if (modelPick.model.reasoning) {
    const levelPick = await vscode.window.showQuickPick(
      ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map((level) => ({
        label: `${level === currentLevel ? '$(check) ' : ''}$(lightbulb) ${level}`,
        description: level === currentLevel ? 'current' : '',
        level,
      })),
      {
        title: `Chat Settings — 3/3: Thinking (${String(modelPick.model.id ?? '')})`,
        placeHolder: 'How hard should it think?',
      }
    );
    if (levelPick) {
      await controller.setThinkingLevel(levelPick.level);
    }
  }
  await controller.refreshState();
  return true;
}
