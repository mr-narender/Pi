// Follow the agent, Zed-style: a SIDE EDITOR acts as π's live screen. Every
// file the agent reads or edits appears there as it happens — one reused
// preview tab cycling file-to-file (chat on one side, π's working file on the
// other), with the edited region glowing ember and hover attribution of WHICH
// chat did it. Modes (piRpc.followAgent): 'open' (default) | 'status' | 'off'.
import * as path from 'node:path';
import * as vscode from 'vscode';
import { readStartLine, revealNeedle, toolActivity } from './toolActivity';
import { PiScreen } from './screenDocument';

type FollowLogger = { info(message: string): void } | undefined;

interface SnapshotLike {
  messages: Array<{
    blocks?: Array<{ kind: string; name?: string; args?: string; callId?: string }>;
  }>;
}

export class AgentFollowService implements vscode.Disposable {
  public logger: FollowLogger;
  private readonly screen = new PiScreen();
  /** callId → last seen args length: streaming args re-reveal as they grow. */
  private readonly seen = new Map<string, Map<string, number>>();
  private lastEditCall: string | undefined;
  private lastActivity:
    | {
        kind: 'editing' | 'reading';
        absolute: string;
        chatTitle: string;
        args?: string;
        chatColumn?: number;
      }
    | undefined;
  private lastReveal = 0;
  /** Our dedicated right-of-chat group (recreated if the user closes it). */
  private followColumn: vscode.ViewColumn | undefined;
  private readonly status: vscode.StatusBarItem;
  private statusTimer: ReturnType<typeof setTimeout> | undefined;

  public constructor() {
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 96);
  }

  private syncLogger(): void {
    this.screen.logger = this.logger;
  }

  private mode(): 'open' | 'status' | 'off' {
    const raw = vscode.workspace.getConfiguration('piRpc').get<string>('followAgent', 'open');
    return raw === 'status' || raw === 'off' ? raw : 'open';
  }

  /** Feed every rendered snapshot through here; new tool calls become activity. */
  public handleSnapshot(
    key: string,
    chatTitle: string,
    snapshot: SnapshotLike,
    isActiveChat: boolean,
    workspaceRoot: string | undefined,
    chatColumn?: number
  ): void {
    let seen = this.seen.get(key);
    if (!seen) {
      seen = new Map();
      this.seen.set(key, seen);
      // First snapshot of a chat = history, not live activity. Mark, don't act.
      for (const message of snapshot.messages) {
        for (const block of message.blocks ?? []) {
          if (block.kind === 'tool' && block.callId) {
            seen.set(block.callId, (block.args ?? '').length);
          }
        }
      }
      return;
    }
    for (const message of snapshot.messages) {
      for (const block of message.blocks ?? []) {
        if (block.kind !== 'tool' || !block.callId) {
          continue;
        }
        const argsLen = (block.args ?? '').length;
        const prior = seen.get(block.callId);
        if (prior === undefined) {
          seen.set(block.callId, argsLen);
          const activity = toolActivity(block.name, block.args);
          if (activity) {
            if (activity.kind === 'editing') {
              this.lastEditCall = block.callId;
            }
            this.act(
              activity.kind,
              activity.path,
              chatTitle,
              isActiveChat,
              workspaceRoot,
              block.args,
              chatColumn
            );
          }
        } else if (
          argsLen > prior &&
          block.callId === this.lastEditCall &&
          isActiveChat &&
          this.mode() === 'open'
        ) {
          // The followed edit's args are still streaming — keep tracking the
          // line the agent is writing, Zed-cursor style (throttled).
          seen.set(block.callId, argsLen);
          const now = Date.now();
          if (now - this.lastReveal > 450) {
            this.lastReveal = now;
            const activity = toolActivity(block.name, block.args);
            if (activity?.kind === 'editing') {
              void this.showInSidePane(
                'editing',
                this.resolve(activity.path, workspaceRoot),
                chatTitle,
                block.args,
                chatColumn
              );
            }
          }
        }
      }
    }
    if (seen.size > 2000) {
      this.seen.set(key, new Map(Array.from(seen.entries()).slice(-500)));
    }
  }

  private resolve(filePath: string, workspaceRoot: string | undefined): string {
    return path.isAbsolute(filePath) ? filePath : path.join(workspaceRoot ?? '', filePath);
  }

  private act(
    kind: 'editing' | 'reading',
    filePath: string,
    chatTitle: string,
    isActiveChat: boolean,
    workspaceRoot: string | undefined,
    args: string | undefined,
    chatColumn?: number
  ): void {
    const absolute = this.resolve(filePath, workspaceRoot);
    this.logger?.info(
      `[follow] ${kind} ${absolute} (chat "${chatTitle.trim()}", visible=${isActiveChat}, mode=${this.mode()}, column=${String(chatColumn)})`
    );
    if (isActiveChat) {
      // Remembered even while off/status: toggling follow ON jumps straight
      // to the file π is currently on.
      this.lastActivity = { kind, absolute, chatTitle, args, chatColumn };
    }
    if (this.mode() === 'off') {
      return;
    }
    const base = path.basename(filePath);
    const shortTitle = chatTitle.replace(/\u2007+$/g, '').trim();
    this.status.text = `${kind === 'editing' ? '$(edit)' : '$(eye)'} π · ${kind} ${base}`;
    this.status.tooltip = new vscode.MarkdownString(
      `**${shortTitle}** is ${kind} \`${filePath}\`\n\n_Click to open · setting: piRpc.followAgent_`
    );
    this.status.command = {
      command: 'vscode.open',
      title: 'Open',
      arguments: [vscode.Uri.file(absolute)],
    };
    this.status.show();
    clearTimeout(this.statusTimer);
    this.statusTimer = setTimeout(() => this.status.hide(), kind === 'editing' ? 9000 : 5000);

    // The side pane follows READS and EDITS — but only for the chat you're
    // looking at; parallel background chats narrate in the status bar only.
    if (this.mode() !== 'open' || !isActiveChat) {
      this.logger?.info(
        `[follow] pane skipped: ${this.mode() !== 'open' ? `mode=${this.mode()}` : 'chat not visible'}`
      );
      return;
    }
    void this.showInSidePane(kind, absolute, chatTitle, args, chatColumn);
  }

  /** π's screen must sit geometrically RIGHT of the chat. ViewColumn math
   * can't guarantee that (numbers are creation order, and Beside honors
   * workbench.editor.openSideBySideDirection — 'down' opens at the bottom),
   * so we create our own right split once and reuse it. */
  private async followGroup(
    chatColumn: number | undefined
  ): Promise<vscode.ViewColumn | undefined> {
    const groups = vscode.window.tabGroups.all;
    if (
      this.followColumn !== undefined &&
      groups.some((group) => group.viewColumn === this.followColumn)
    ) {
      return this.followColumn;
    }
    if (chatColumn === undefined) {
      return undefined;
    }
    const active = vscode.window.tabGroups.activeTabGroup;
    if (active.viewColumn === chatColumn) {
      // Chat group is active: split RIGHT deterministically, hand focus back.
      await vscode.commands.executeCommand('workbench.action.newGroupRight');
      await vscode.commands.executeCommand('workbench.action.focusPreviousGroup');
      this.followColumn = (chatColumn + 1) as vscode.ViewColumn;
      this.logger?.info(`[follow] created right split at column ${String(this.followColumn)}`);
      return this.followColumn;
    }
    const existing = groups.find((group) => group.viewColumn === chatColumn + 1);
    if (existing) {
      this.followColumn = existing.viewColumn;
      return this.followColumn;
    }
    return undefined;
  }

  private async showInSidePane(
    kind: 'editing' | 'reading',
    absolute: string,
    chatTitle: string,
    args: string | undefined,
    chatColumn?: number
  ): Promise<void> {
    this.syncLogger();
    const column = (await this.followGroup(chatColumn)) ?? vscode.ViewColumn.Beside;
    await this.screen.show({
      kind,
      absolute,
      chatTitle,
      column,
      needle: kind === 'editing' ? revealNeedle(args) : undefined,
      revealLine: kind === 'reading' ? (readStartLine(args) ?? 1) : undefined,
    });
  }

  /** Toggle-ON affordance: immediately show the file π was last on.
   * Returns false when there is no remembered activity yet. */
  public replayLast(): boolean {
    if (this.mode() !== 'open' || !this.lastActivity) {
      return false;
    }
    const { kind, absolute, chatTitle, args, chatColumn } = this.lastActivity;
    void this.showInSidePane(kind, absolute, chatTitle, args, chatColumn);
    return true;
  }

  public dispose(): void {
    clearTimeout(this.statusTimer);
    this.screen.dispose();
    this.status.dispose();
    this.seen.clear();
  }
}
