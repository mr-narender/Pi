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
  private readonly decoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: 'rgba(255, 140, 66, 0.10)',
    borderColor: 'rgba(255, 140, 66, 0.85)',
    borderStyle: 'solid',
    borderWidth: '0 0 0 2px',
    overviewRulerColor: 'rgba(255, 140, 66, 0.8)',
    overviewRulerLane: vscode.OverviewRulerLane.Full,
  });
  private decorationTimer: ReturnType<typeof setTimeout> | undefined;
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

  /** Zed follow: the CENTER editor area shows the real file π is on — one
   * preview slot cycling file-to-file, ember glow on the edited region.
   * Skipped when a π chat tab owns the active group (editor-tab layout keeps
   * the transcript in front); with the sidebar chat the center is always free. */
  private async showInSidePane(
    kind: 'editing' | 'reading',
    absolute: string,
    chatTitle: string,
    args: string | undefined,
    _post?: (payload: unknown) => void
  ): Promise<void> {
    const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
    if (
      activeTab?.input instanceof vscode.TabInputCustom &&
      activeTab.input.viewType.startsWith('piRpc.')
    ) {
      this.logger?.info('[follow] center skipped: a π chat tab is active in this group');
      return;
    }
    const content = await this.readWithRetry(absolute);
    if (content === undefined) {
      this.logger?.info(`[follow] ${absolute} not on disk after retries`);
      return;
    }
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(absolute));
      const editor = await vscode.window.showTextDocument(doc, {
        preview: true, // ONE slot cycling as π moves — no tab pileup
        preserveFocus: true,
        viewColumn: vscode.ViewColumn.Active,
      });
      this.logger?.info(`[follow] center showing ${absolute}`);
      if (kind === 'reading') {
        const line = Math.max(0, (readStartLine(args) ?? 1) - 1);
        editor.revealRange(
          doc.lineAt(Math.min(line, doc.lineCount - 1)).range,
          vscode.TextEditorRevealType.AtTop
        );
        return;
      }
      const needle = revealNeedle(args);
      const attempt = (delay: number) =>
        setTimeout(() => void this.glowEdit(absolute, needle, chatTitle), delay);
      attempt(400);
      attempt(1600);
    } catch (error) {
      this.logger?.info(
        `[follow] center open failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async glowEdit(
    absolute: string,
    needle: string | undefined,
    chatTitle: string
  ): Promise<void> {
    if (!needle) {
      return;
    }
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(absolute));
      const editor = vscode.window.visibleTextEditors.find(
        (candidate) => candidate.document.uri.fsPath === absolute
      );
      if (!editor) {
        return;
      }
      const at = doc.getText().indexOf(needle);
      if (at < 0) {
        return;
      }
      const range = new vscode.Range(doc.positionAt(at), doc.positionAt(at + needle.length));
      editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      editor.setDecorations(this.decoration, [
        {
          range,
          hoverMessage: new vscode.MarkdownString(`$(edit) edited by **π — ${chatTitle.trim()}**`),
        },
      ]);
      clearTimeout(this.decorationTimer);
      this.decorationTimer = setTimeout(() => editor.setDecorations(this.decoration, []), 7000);
    } catch {
      /* editor closed between attempts */
    }
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
    clearTimeout(this.decorationTimer);
    this.decoration.dispose();
    clearTimeout(this.statusTimer);
    this.status.dispose();
    this.seen.clear();
  }
}
