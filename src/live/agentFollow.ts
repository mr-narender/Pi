// Follow the agent, Zed-style: a SIDE EDITOR acts as π's live screen. Every
// file the agent reads or edits appears there as it happens — one reused
// preview tab cycling file-to-file (chat on one side, π's working file on the
// other), with the edited region glowing ember and hover attribution of WHICH
// chat did it. Modes (piRpc.followAgent): 'open' (default) | 'status' | 'off'.
import * as path from 'node:path';
import * as vscode from 'vscode';
import { readStartLine, revealNeedle, toolActivity } from './toolActivity';

type FollowLogger = { info(message: string): void } | undefined;

interface SnapshotLike {
  messages: Array<{
    blocks?: Array<{ kind: string; name?: string; args?: string; callId?: string }>;
  }>;
}

export class AgentFollowService implements vscode.Disposable {
  public logger: FollowLogger;
  /** callId → last seen args length: streaming args re-reveal as they grow. */
  private readonly seen = new Map<string, Map<string, number>>();
  private lastEditCall: string | undefined;
  private lastActivity:
    | {
        kind: 'editing' | 'reading';
        absolute: string;
        chatTitle: string;
        args?: string;
        post?: (payload: unknown) => void;
      }
    | undefined;
  private lastReveal = 0;
  private readonly status: vscode.StatusBarItem;
  private statusTimer: ReturnType<typeof setTimeout> | undefined;

  public constructor() {
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 96);
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
    post?: (payload: unknown) => void
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
              post
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
                post
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
    post?: (payload: unknown) => void
  ): void {
    const absolute = this.resolve(filePath, workspaceRoot);
    this.logger?.info(
      `[follow] ${kind} ${absolute} (chat "${chatTitle.trim()}", visible=${isActiveChat}, mode=${this.mode()})`
    );
    if (isActiveChat) {
      // Remembered even while off/status: toggling follow ON jumps straight
      // to the file π is currently on.
      this.lastActivity = { kind, absolute, chatTitle, args, post };
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
    void this.showInSidePane(kind, absolute, chatTitle, args, post);
  }

  /** The split view lives INSIDE the chat webview — we just feed it. */
  private async showInSidePane(
    kind: 'editing' | 'reading',
    absolute: string,
    chatTitle: string,
    args: string | undefined,
    post?: (payload: unknown) => void
  ): Promise<void> {
    if (!post) {
      return;
    }
    const content = await this.readWithRetry(absolute);
    if (content === undefined) {
      this.logger?.info(`[screen] ${absolute} not on disk after retries`);
      return;
    }
    post({
      type: 'screen',
      kind,
      path: absolute,
      content: content.length > 200_000 ? content.slice(0, 200_000) : content,
      truncated: content.length > 200_000,
      revealLine: kind === 'reading' ? (readStartLine(args) ?? 1) : undefined,
      needle: kind === 'editing' ? revealNeedle(args) : undefined,
      chatTitle: chatTitle.trim(),
    });
  }

  /** Fresh writes land on disk AFTER the tool call streams — retry briefly. */
  private async readWithRetry(absolute: string): Promise<string | undefined> {
    for (const delay of [0, 800, 2200]) {
      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
      try {
        const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(absolute));
        return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
      } catch {
        /* not there yet */
      }
    }
    return undefined;
  }

  /** Toggle-ON affordance: immediately show the file π was last on.
   * Returns false when there is no remembered activity yet. */
  public replayLast(): boolean {
    if (this.mode() !== 'open' || !this.lastActivity) {
      return false;
    }
    const { kind, absolute, chatTitle, args, post } = this.lastActivity;
    void this.showInSidePane(kind, absolute, chatTitle, args, post);
    return true;
  }

  public dispose(): void {
    clearTimeout(this.statusTimer);
    this.status.dispose();
    this.seen.clear();
  }
}
