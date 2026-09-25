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
  private readonly seen = new Map<string, Set<string>>();
  private readonly status: vscode.StatusBarItem;
  private readonly decoration: vscode.TextEditorDecorationType;
  private statusTimer: ReturnType<typeof setTimeout> | undefined;
  private decorationTimer: ReturnType<typeof setTimeout> | undefined;
  private decoratedEditor: vscode.TextEditor | undefined;
  /** The side group that serves as π's screen; recomputed if the user closes it. */
  private followColumn: vscode.ViewColumn | undefined;

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
    workspaceRoot: string | undefined
  ): void {
    if (this.mode() === 'off') {
      return;
    }
    let seen = this.seen.get(key);
    if (!seen) {
      seen = new Set();
      this.seen.set(key, seen);
      // First snapshot of a chat = history, not live activity. Mark, don't act.
      for (const message of snapshot.messages) {
        for (const block of message.blocks ?? []) {
          if (block.kind === 'tool' && block.callId) {
            seen.add(block.callId);
          }
        }
      }
      return;
    }
    for (const message of snapshot.messages) {
      for (const block of message.blocks ?? []) {
        if (block.kind !== 'tool' || !block.callId || seen.has(block.callId)) {
          continue;
        }
        seen.add(block.callId);
        const activity = toolActivity(block.name, block.args);
        if (activity) {
          this.act(
            activity.kind,
            activity.path,
            chatTitle,
            isActiveChat,
            workspaceRoot,
            block.args
          );
        }
      }
    }
    if (seen.size > 2000) {
      this.seen.set(key, new Set(Array.from(seen).slice(-500)));
    }
  }

  private act(
    kind: 'editing' | 'reading',
    filePath: string,
    chatTitle: string,
    isActiveChat: boolean,
    workspaceRoot: string | undefined,
    args: string | undefined
  ): void {
    const absolute = path.isAbsolute(filePath)
      ? filePath
      : path.join(workspaceRoot ?? '', filePath);
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
    void this.showInSidePane(kind, absolute, chatTitle, args);
  }

  /** π's screen: a stable side editor group, one preview tab reused per file. */
  private sideColumn(): vscode.ViewColumn {
    const groups = vscode.window.tabGroups.all;
    const stillThere =
      this.followColumn !== undefined &&
      groups.some((group) => group.viewColumn === this.followColumn);
    if (stillThere && this.followColumn !== undefined) {
      return this.followColumn;
    }
    const chatColumn = vscode.window.tabGroups.activeTabGroup.viewColumn;
    const other = groups.find((group) => group.viewColumn !== chatColumn);
    this.followColumn = other ? other.viewColumn : vscode.ViewColumn.Beside;
    return this.followColumn;
  }

  private async showInSidePane(
    kind: 'editing' | 'reading',
    absolute: string,
    chatTitle: string,
    args: string | undefined
  ): Promise<void> {
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(absolute));
      const editor = await vscode.window.showTextDocument(doc, {
        viewColumn: this.sideColumn(),
        preview: true, // one live tab, reused as π moves file-to-file
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

  public dispose(): void {
    clearTimeout(this.statusTimer);
    clearTimeout(this.decorationTimer);
    this.decoratedEditor?.setDecorations(this.decoration, []);
    this.decoration.dispose();
    this.status.dispose();
    this.seen.clear();
  }
}
