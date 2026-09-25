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
        chatColumn?: number;
      }
    | undefined;
  private lastReveal = 0;
  /** Our dedicated right-of-chat group (recreated if the user closes it). */
  private followColumn: vscode.ViewColumn | undefined;
  private readonly status: vscode.StatusBarItem;
  private readonly decoration: vscode.TextEditorDecorationType;
  private statusTimer: ReturnType<typeof setTimeout> | undefined;
  private decorationTimer: ReturnType<typeof setTimeout> | undefined;
  private decoratedEditor: vscode.TextEditor | undefined;

  public constructor() {
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 96);
    this.decoration = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: 'rgba(255, 140, 66, 0.10)',
      borderColor: 'rgba(255, 140, 66, 0.85)',
      borderStyle: 'solid',
      borderWidth: '0 0 0 2px',
      overviewRulerColor: 'rgba(255, 140, 66, 0.8)',
      overviewRulerLane: vscode.OverviewRulerLane.Full,
    });
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

  private async openWithRetry(absolute: string): Promise<vscode.TextDocument | undefined> {
    for (const delay of [0, 800, 2200]) {
      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
      try {
        return await vscode.workspace.openTextDocument(vscode.Uri.file(absolute));
      } catch {
        /* not on disk yet — try again */
      }
    }
    return undefined;
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
    // Fresh writes: the tool call streams BEFORE the file exists on disk —
    // retry a few times instead of giving up on ENOENT.
    const doc = await this.openWithRetry(absolute);
    if (!doc) {
      this.logger?.info(`[follow] gave up opening ${absolute} (not on disk after retries)`);
      return;
    }
    this.logger?.info(`[follow] opening ${absolute} in column ${String((chatColumn ?? 0) + 1)}`);
    try {
      // Chrome-split-view feel: ONE container, two panes — chat left, a single
      // live file slot right. preview:true makes the right group REUSE one tab
      // as π moves file-to-file (no 10-tab pileup; the Review panel is the
      // history). If the user edits a followed file, VS Code pins it — π's
      // slot simply continues beside it, which is the right ownership handoff.
      const column = (await this.followGroup(chatColumn)) ?? vscode.ViewColumn.Beside;
      const editor = await vscode.window.showTextDocument(doc, {
        viewColumn: column,
        preview: true,
        preserveFocus: true, // NEVER steal the user's cursor
      });
      this.followColumn = editor.viewColumn ?? this.followColumn;
      if (kind === 'reading') {
        const line = Math.max(0, (readStartLine(args) ?? 1) - 1);
        const range = doc.lineAt(Math.min(line, doc.lineCount - 1)).range;
        editor.revealRange(range, vscode.TextEditorRevealType.AtTop);
        return;
      }
      // Edits: the tool call streams BEFORE the write lands — two chances to
      // find the changed region, then glow it with chat attribution.
      const needle = revealNeedle(args);
      const attempt = (delay: number) =>
        setTimeout(() => void this.revealEdit(absolute, needle, chatTitle), delay);
      attempt(500);
      attempt(1800);
    } catch {
      /* file may not exist yet (fresh write) — status bar already points at it */
    }
  }

  private async revealEdit(
    absolute: string,
    needle: string | undefined,
    chatTitle: string
  ): Promise<void> {
    try {
      const fresh = await vscode.workspace.openTextDocument(vscode.Uri.file(absolute));
      const target = vscode.window.visibleTextEditors.find(
        (candidate) => candidate.document.uri.fsPath === absolute
      );
      if (!target || !needle) {
        return;
      }
      const at = fresh.getText().indexOf(needle);
      if (at < 0) {
        return;
      }
      const range = new vscode.Range(fresh.positionAt(at), fresh.positionAt(at + needle.length));
      target.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      this.decoratedEditor?.setDecorations(this.decoration, []);
      target.setDecorations(this.decoration, [
        {
          range,
          hoverMessage: new vscode.MarkdownString(`$(edit) edited by **π — ${chatTitle.trim()}**`),
        },
      ]);
      this.decoratedEditor = target;
      clearTimeout(this.decorationTimer);
      this.decorationTimer = setTimeout(() => {
        this.decoratedEditor?.setDecorations(this.decoration, []);
      }, 7000);
    } catch {
      /* editor closed between attempts — fine */
    }
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
    clearTimeout(this.decorationTimer);
    this.decoratedEditor?.setDecorations(this.decoration, []);
    this.decoration.dispose();
    this.status.dispose();
    this.seen.clear();
  }
}
