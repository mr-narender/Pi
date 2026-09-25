// #3 (hardening review): chat-operations command group, extracted from the
// extension.ts god file. Registers into the shared `registrations` map; the
// activation loop in extension.ts binds them to VS Code.
import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import { ensureWorkspaceAvailable, ensureTrustedForMutation } from '../security/trust';
import { formatRelativeTimestamp, readSessionLineage } from '../sessions/recentSessions';
import type { ChatTabManager } from '../editorTabs/tabManager';
import type { SessionRegistry } from '../sessions/sessionRegistry';
import type { SessionController } from '../sessions/sessionController';
import type { RecentSessionService } from '../sessions/recentSessionService';
import type { TurnReview } from '../review/turnReview';
import type { DiagnosticsLogger } from '../diagnostics/logger';

function runGit(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      resolve(error ? '' : stdout);
    });
  });
}

export interface ChatOpsDeps {
  registrations: Map<string, (value?: unknown) => unknown>;
  chatTabs: ChatTabManager;
  registry: SessionRegistry;
  recentSessions: RecentSessionService;
  turnReview: TurnReview;
  logger: DiagnosticsLogger;
  chatStatus: (controller: SessionController) => 'busy' | 'waiting' | 'idle' | 'faulted';
  subscriptions: vscode.Disposable[];
}

export function registerChatOps(deps: ChatOpsDeps): void {
  const {
    registrations,
    chatTabs,
    registry,
    recentSessions,
    turnReview,
    logger,
    chatStatus,
    subscriptions,
  } = deps;

  // π Swarm: fan one prompt template across N parallel chats on the pool.
  registrations.set('piRpc.fanOut', async () => {
    ensureWorkspaceAvailable();
    ensureTrustedForMutation();
    const template = await vscode.window.showInputBox({
      title: 'π Swarm — prompt template',
      prompt: 'Use {item} where each item should be substituted',
      placeHolder: 'e.g. Run the tests in {item} and fix any failures',
    });
    if (!template || !template.trim()) {
      return;
    }
    const itemsRaw = await vscode.window.showInputBox({
      title: 'π Swarm — items (comma or ; separated)',
      prompt: 'One chat per item, e.g. packages/api, packages/web, packages/cli',
    });
    if (!itemsRaw || !itemsRaw.trim()) {
      return;
    }
    const items = itemsRaw
      .split(/[,;\n]/)
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 6);
    if (items.length === 0) {
      return;
    }
    const base = chatTabs.getActiveContext()?.controller ?? registry.getActive();
    if (!base) {
      return;
    }
    const swarm: SessionController[] = [];
    for (const item of items) {
      const message = template.replaceAll('{item}', item);
      try {
        const draftResource = await chatTabs.openDraftForWorkspace(base, {
          focusComposer: false,
        });
        const ctx = await chatTabs.preparePromptContext(draftResource);
        if (!ctx) {
          continue;
        }
        await ctx.controller.prompt(message, 'prompt', undefined);
        swarm.push(ctx.controller);
      } catch (error) {
        logger.warn(
          `Swarm chat for “${item}” failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    if (swarm.length === 0) {
      void vscode.window.showWarningMessage('π Swarm: no chats could be started.');
      return;
    }
    void vscode.window.showInformationMessage(
      `π Swarm: ${swarm.length} chat${swarm.length === 1 ? '' : 's'} running in parallel.`
    );
    // Consolidated completion: notify once when EVERY swarm chat settles.
    const seenBusy = new Set<SessionController>();
    const done = new Set<SessionController>();
    const subs: vscode.Disposable[] = [];
    const finish = (): void => {
      for (const sub of subs) {
        sub.dispose();
      }
      void vscode.window
        .showInformationMessage(
          `π Swarm complete — all ${swarm.length} chats finished.`,
          'Show Chats'
        )
        .then((choice) => {
          if (choice === 'Show Chats') {
            void vscode.commands.executeCommand('piRpc.showRunningChats');
          }
        });
    };
    for (const controller of swarm) {
      subs.push(
        controller.onDidChangeState(() => {
          const conn = controller.snapshot.connectionState;
          if (conn === 'busy') {
            seenBusy.add(controller);
          } else if (conn === 'ready' && seenBusy.has(controller) && !done.has(controller)) {
            done.add(controller);
            if (done.size === swarm.length) {
              finish();
            }
          }
        })
      );
    }
    subscriptions.push(...subs);
  });

  // Composer context: attach git/terminal state into the draft.
  const appendDraftBlock = async (label: string, body: string): Promise<void> => {
    if (!body.trim()) {
      void vscode.window.showInformationMessage(`${label}: nothing to attach.`);
      return;
    }
    const capped = body.length > 60_000 ? `${body.slice(0, 60_000)}\n… (truncated)` : body;
    const fence = '```';
    await chatTabs.appendToActiveDraft(`\n\n${label}:\n${fence}\n${capped}\n${fence}\n`);
  };
  registrations.set('piRpcInternal.attachGitDiff', async () => {
    const folder = chatTabs.getActiveContext()?.controller.folder ?? registry.getActive()?.folder;
    if (!folder) {
      return;
    }
    const diff = await runGit(folder.uri.fsPath, ['diff']);
    await appendDraftBlock('Working tree diff', diff);
  });
  registrations.set('piRpcInternal.attachStagedDiff', async () => {
    const folder = chatTabs.getActiveContext()?.controller.folder ?? registry.getActive()?.folder;
    if (!folder) {
      return;
    }
    const diff = await runGit(folder.uri.fsPath, ['diff', '--staged']);
    await appendDraftBlock('Staged diff', diff);
  });
  registrations.set('piRpcInternal.attachTerminalSelection', async () => {
    await vscode.commands.executeCommand('workbench.action.terminal.copySelection');
    const text = await vscode.env.clipboard.readText();
    await appendDraftBlock('Terminal selection', text);
  });

  // Aggregate usage/cost across every OPEN chat (parallel sessions).
  registrations.set('piRpc.showAllChatsUsage', async () => {
    const chats = chatTabs.listOpenChats();
    if (chats.length === 0) {
      void vscode.window.showInformationMessage('No Pi chats are open.');
      return;
    }
    const lines: string[] = ['# Pi usage — open chats', ''];
    let totalCost = 0;
    let totalTokens = 0;
    for (const chat of chats) {
      try {
        const stats = await chat.controller.showSessionStats();
        const cost = typeof stats?.cost === 'number' ? stats.cost : 0;
        const tokensObj = stats?.tokens as { total?: number } | undefined;
        const tokens = typeof tokensObj?.total === 'number' ? tokensObj.total : 0;
        totalCost += cost;
        totalTokens += tokens;
        lines.push(`- **${chat.title}** — ${tokens.toLocaleString()} tokens · $${cost.toFixed(4)}`);
      } catch {
        lines.push(`- **${chat.title}** — stats unavailable (chat not started)`);
      }
    }
    lines.push('', `**Total: ${totalTokens.toLocaleString()} tokens · $${totalCost.toFixed(4)}**`);
    const doc = await vscode.workspace.openTextDocument({
      content: lines.join('\n'),
      language: 'markdown',
    });
    await vscode.window.showTextDocument(doc, { preview: true });
  });

  // Turn review: consolidated "files changed this turn" — diff/revert.
  registrations.set('piRpc.reviewLastTurn', async () => {
    const controller = chatTabs.getActiveContext()?.controller ?? registry.getActive();
    await turnReview.review(controller);
  });

  // Chat versions: every message edit forks a file; walk the lineage and let the
  // user open any earlier version of this chat.
  registrations.set('piRpc.showChatVersions', async () => {
    const controller = chatTabs.getActiveContext()?.controller ?? registry.getActive();
    const file = controller?.snapshot.state.sessionFile;
    if (!controller || typeof file !== 'string') {
      void vscode.window.showInformationMessage('Open a saved Pi chat first.');
      return;
    }
    const lineage = await readSessionLineage(file);
    if (lineage.length <= 1) {
      void vscode.window.showInformationMessage('This chat has no earlier versions.');
      return;
    }
    const picked = await vscode.window.showQuickPick(
      lineage.map((version, index) => ({
        label: `${index === 0 ? '$(circle-filled)' : '$(history)'} v${lineage.length - index}${
          index === 0 ? ' (current)' : ''
        }`,
        description: version.createdAt ? new Date(version.createdAt).toLocaleString() : '',
        version,
      })),
      { title: 'Chat versions — each edit forked a version', placeHolder: 'Open a version' }
    );
    if (!picked || picked.version.path === file) {
      return;
    }
    await vscode.commands.executeCommand('piRpcInternal.openOtherChat', {
      sessionPath: picked.version.path,
      cwd: controller.folder.uri.fsPath,
    });
  });

  // Quick switcher: fuzzy-jump to ANY chat in any project.
  registrations.set('piRpc.quickSwitchChat', async () => {
    const folder = registry.getActive()?.folder ?? vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      void vscode.window.showInformationMessage('Open a folder first.');
      return;
    }
    const state = recentSessions.getState(folder);
    if (state.items.length === 0 && !state.others?.length) {
      await recentSessions.refresh(folder);
    }
    const fresh = recentSessions.getState(folder);
    type ChatPick = vscode.QuickPickItem & {
      record?: { path: string; cwd: string };
      foreign?: boolean;
    };
    const picks: ChatPick[] = [];
    if (fresh.items.length > 0) {
      picks.push({ label: 'This workspace', kind: vscode.QuickPickItemKind.Separator });
      for (const record of fresh.items) {
        picks.push({
          label: record.displayName,
          description: [formatRelativeTimestamp(record.modifiedAt), record.modelLabel]
            .filter(Boolean)
            .join(' · '),
          record,
        });
      }
    }
    if (fresh.others && fresh.others.length > 0) {
      picks.push({ label: 'Other projects', kind: vscode.QuickPickItemKind.Separator });
      for (const record of fresh.others) {
        picks.push({
          label: record.displayName,
          description: `${record.workspaceLabel} · ${formatRelativeTimestamp(record.modifiedAt)}`,
          record,
          foreign: true,
        });
      }
    }
    if (picks.length === 0) {
      void vscode.window.showInformationMessage('No chats yet.');
      return;
    }
    const picked = await vscode.window.showQuickPick(picks, {
      title: 'Switch Pi chat',
      placeHolder: 'Type to filter across every project…',
      matchOnDescription: true,
    });
    if (!picked?.record) {
      return;
    }
    if (picked.foreign) {
      await vscode.commands.executeCommand('piRpcInternal.openOtherChat', {
        sessionPath: picked.record.path,
        cwd: picked.record.cwd,
      });
    } else {
      await vscode.commands.executeCommand('piRpc.switchSession', {
        sessionPath: picked.record.path,
      });
    }
  });

  // Mission Control: jump to any open chat, with live per-chat status.
  registrations.set('piRpc.showRunningChats', async () => {
    const chats = chatTabs.listOpenChats();
    if (chats.length === 0) {
      void vscode.window.showInformationMessage('No Pi chats are open.');
      return;
    }
    const icons = {
      busy: '$(sync~spin)',
      waiting: '$(bell-dot)',
      idle: '$(check)',
      faulted: '$(error)',
    } as const;
    const picked = await vscode.window.showQuickPick(
      chats.map((chat) => {
        const status = chatStatus(chat.controller);
        return {
          label: `${icons[status]} ${chat.title}`,
          description: status === 'waiting' ? 'needs your approval' : status,
          chat,
        };
      }),
      { title: 'Pi chats', placeHolder: 'Jump to a chat' }
    );
    if (picked) {
      chatTabs.revealController(picked.chat.controller);
    }
  });
}
