// Follow the agent, Zed-style: a SIDE EDITOR acts as π's live screen. Every
// file the agent reads or edits appears there as it happens — one reused
// preview tab cycling file-to-file (chat on one side, π's working file on the
// other), with the edited region glowing ember and hover attribution of WHICH
// chat did it. Modes (piRpc.followAgent): 'open' (default) | 'status' | 'off'.
import * as path from 'node:path';
import * as vscode from 'vscode';
import { readStartLine, revealNeedle, toolActivity } from './toolActivity';

interface SnapshotLike {
  messages: Array<{
    blocks?: Array<{ kind: string; name?: string; args?: string; callId?: string }>;
  }>;
}

export class AgentFollowService implements vscode.Disposable {
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
      return;
    }
    try {
      // One container feel: chat on the left, π's files in the split to its
      // RIGHT — each file gets its own persistent tab there.
      const editor = await vscode.window.showTextDocument(doc, {
        viewColumn: chatColumn && chatColumn >= 1 ? chatColumn + 1 : vscode.ViewColumn.Beside,
        preview: false,
        preserveFocus: true, // NEVER steal the user's cursor
      });
      void editor;
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

  /** Toggle-ON affordance: immediately show the file π was last on. */
  public replayLast(): void {
    if (this.mode() !== 'open' || !this.lastActivity) {
      return;
    }
    const { kind, absolute, chatTitle, args, chatColumn } = this.lastActivity;
    void this.showInSidePane(kind, absolute, chatTitle, args, chatColumn);
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
