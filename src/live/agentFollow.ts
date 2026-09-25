// Follow the agent, Zed-style: as π reads/edits files, surface it LIVE —
// status bar shows "π (chat): editing foo.ts", the edited file opens in a
// preview tab (never stealing focus), and the touched region glows ember.
// Modes (piRpc.followAgent): 'open' (default) | 'status' | 'off'.
import * as path from 'node:path';
import * as vscode from 'vscode';
import { revealNeedle, toolActivity } from './toolActivity';

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
            revealNeedle(block.args)
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
    needle: string | undefined
  ): void {
    const absolute = path.isAbsolute(filePath)
      ? filePath
      : path.join(workspaceRoot ?? '', filePath);
    const base = path.basename(filePath);
    const icon = kind === 'editing' ? '$(edit)' : '$(eye)';
    const shortTitle = chatTitle.replace(/\u2007+$/g, '').trim();
    this.status.text = `${icon} π · ${kind === 'editing' ? 'editing' : 'reading'} ${base}`;
    this.status.tooltip = new vscode.MarkdownString(
      `**${shortTitle}** is ${kind} \`${filePath}\`\n\n_Click to open · piRpc.followAgent controls this_`
    );
    this.status.command = {
      command: 'vscode.open',
      title: 'Open',
      arguments: [vscode.Uri.file(absolute)],
    };
    this.status.show();
    clearTimeout(this.statusTimer);
    this.statusTimer = setTimeout(() => this.status.hide(), kind === 'editing' ? 9000 : 5000);

    // Only EDITS open files, and only for the chat you're looking at —
    // parallel background chats stay in the status bar, not your tab strip.
    if (kind !== 'editing' || this.mode() !== 'open' || !isActiveChat) {
      return;
    }
    void this.openAndReveal(absolute, needle);
  }

  private async openAndReveal(absolute: string, needle: string | undefined): Promise<void> {
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(absolute));
      const column =
        vscode.window.visibleTextEditors.find((editor) => editor.viewColumn !== undefined)
          ?.viewColumn ?? vscode.ViewColumn.Beside;
      const editor = await vscode.window.showTextDocument(doc, {
        viewColumn: column,
        preview: true,
        preserveFocus: true,
      });
      // The tool call streams BEFORE the write lands on disk — give it two
      // chances to find the edited region, then decorate + reveal.
      const attempt = (delay: number) =>
        setTimeout(() => void this.reveal(editor, absolute, needle), delay);
      attempt(500);
      attempt(1800);
    } catch {
      /* file may not exist yet (fresh write) — the status bar already points at it */
    }
  }

  private async reveal(
    editor: vscode.TextEditor,
    absolute: string,
    needle: string | undefined
  ): Promise<void> {
    try {
      const fresh = await vscode.workspace.openTextDocument(vscode.Uri.file(absolute));
      const live = vscode.window.visibleTextEditors.find(
        (candidate) => candidate.document.uri.fsPath === absolute
      );
      const target = live ?? editor;
      let range: vscode.Range | undefined;
      if (needle) {
        const at = fresh.getText().indexOf(needle);
        if (at >= 0) {
          range = new vscode.Range(fresh.positionAt(at), fresh.positionAt(at + needle.length));
        }
      }
      if (!range) {
        return;
      }
      target.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      this.decoratedEditor?.setDecorations(this.decoration, []);
      target.setDecorations(this.decoration, [range]);
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
