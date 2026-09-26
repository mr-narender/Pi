// Follow the agent, Zed-style: a SIDE EDITOR acts as π's live screen. Every
// file the agent reads or edits appears there as it happens — one reused
// preview tab cycling file-to-file (chat on one side, π's working file on the
// other), with the edited region glowing ember and hover attribution of WHICH
// chat did it. Modes (piRpc.followAgent): 'open' (default) | 'status' | 'off'.
import { spawn } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  anchorNeedle,
  readStartLine,
  revealNeedle,
  shouldTrackFsPath,
  toolActivity,
} from './toolActivity';

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
  /** When each chat key was first seen — history backfill lands inside this
   * window; everything after is genuinely live (NO count-based guessing:
   * fast agents legitimately emit 3–5 calls per streamed snapshot). */
  private readonly keyBornAt = new Map<string, number>();
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
  /** FS-truth net: chats currently BUSY (key → attribution). While any busy
   * chat is visible, ANY workspace file change is π's work — bash heredocs,
   * subagents, MCP tools — no arg-parsing can enumerate them all. */
  private readonly busyChats = new Map<string, { title: string; root: string; visible: boolean }>();
  private watcher: vscode.FileSystemWatcher | undefined;
  private watcherIdleTimer: ReturnType<typeof setTimeout> | undefined;
  /** Paths the tool-layer just acted on — the watcher skips these (dedupe). */
  private readonly recentlyActed = new Map<string, number>();
  private readonly fsDebounce = new Map<string, ReturnType<typeof setTimeout>>();
  /** Cmd/Ctrl+Enter: follow THIS turn even when the crosshair is off. */
  private readonly followOnceKeys = new Set<string>();
  private awakeProcess: import('node:child_process').ChildProcess | undefined;
  /** The moving "π is here" caret — updated every snapshot while a turn runs,
   * so you watch the agent's position travel through the file in realtime. */
  private readonly liveCaret = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: 'rgba(255, 140, 66, 0.16)',
    after: { contentText: '  ⟵ π', color: '#ff8c42', fontWeight: 'bold' },
    overviewRulerColor: '#ffbe7a',
    overviewRulerLane: vscode.OverviewRulerLane.Center,
  });
  private liveCaretEditor: vscode.TextEditor | undefined;
  private liveThrottleAt = 0;
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
  /** Arm follow for the next turn of this chat regardless of the setting. */
  public armOnce(key: string): void {
    this.followOnceKeys.add(key);
  }

  public handleSnapshot(
    key: string,
    chatTitle: string,
    snapshot: SnapshotLike,
    isActiveChat: boolean,
    workspaceRoot: string | undefined,
    post?: (payload: unknown) => void,
    busy?: boolean
  ): void {
    if (busy && workspaceRoot) {
      this.busyChats.set(key, { title: chatTitle, root: workspaceRoot, visible: isActiveChat });
      this.ensureWatcher();
      this.ensureAwake();
    } else {
      this.busyChats.delete(key);
      this.followOnceKeys.delete(key); // one turn only
      this.clearLiveCaret();
      this.scheduleWatcherIdle();
      if (this.busyChats.size === 0) {
        this.releaseAwake();
      }
    }
    let seen = this.seen.get(key);
    if (!seen) {
      seen = new Map();
      this.seen.set(key, seen);
      this.keyBornAt.set(key, Date.now());
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
    // History backfill (chat switch/reload: empty snapshot, then the full
    // transcript) lands within moments of the key being born — absorb inside
    // that grace window. AFTER it, every unseen call is genuinely live and
    // follows, no matter how many arrive per streamed snapshot (a count
    // threshold here once swallowed real scaffolding work).
    const absorbHistory = Date.now() - (this.keyBornAt.get(key) ?? 0) < 1500;
    if (absorbHistory) {
      let unseen = 0;
      for (const message of snapshot.messages) {
        for (const block of message.blocks ?? []) {
          if (block.kind === 'tool' && block.callId && !seen.has(block.callId)) {
            unseen += 1;
          }
        }
      }
      if (unseen > 0) {
        this.logger?.info(`[follow] absorbed ${unseen} historical tool calls (grace window)`);
      }
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
          if (absorbHistory) {
            continue;
          }
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
              post,
              key
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
    this.updateLiveFocus(snapshot, isActiveChat, workspaceRoot, busy === true, key);
  }

  /** Move the realtime caret to π's current position (newest file-touching call
   * in the transcript). Runs every snapshot while busy; throttled. Anchors on
   * text that exists NOW (old text mid-edit / read offset) so it tracks live,
   * before the write even lands. */
  private updateLiveFocus(
    snapshot: SnapshotLike,
    isActiveChat: boolean,
    workspaceRoot: string | undefined,
    busy: boolean,
    key: string
  ): void {
    const followForced = this.followOnceKeys.has(key);
    if (!busy || !isActiveChat || (this.mode() !== 'open' && !followForced)) {
      this.clearLiveCaret();
      return;
    }
    const now = Date.now();
    if (now - this.liveThrottleAt < 120) {
      return;
    }
    this.liveThrottleAt = now;
    // Newest tool block that targets a file.
    let focus: { name?: string; args?: string } | undefined;
    for (let m = snapshot.messages.length - 1; m >= 0 && !focus; m -= 1) {
      const blocks = snapshot.messages[m]?.blocks ?? [];
      for (let b = blocks.length - 1; b >= 0; b -= 1) {
        const block = blocks[b]!;
        if (block.kind === 'tool' && toolActivity(block.name, block.args)) {
          focus = block;
          break;
        }
      }
    }
    if (!focus) {
      return;
    }
    const activity = toolActivity(focus.name, focus.args)!;
    const absolute = this.resolve(activity.path, workspaceRoot);
    const editor = vscode.window.visibleTextEditors.find(
      (candidate) => candidate.document.uri.fsPath === absolute
    );
    if (!editor) {
      return; // act() opens it; next snapshot places the caret
    }
    let line = 0;
    if (activity.kind === 'reading') {
      line = Math.max(0, (readStartLine(focus.args) ?? 1) - 1);
    } else {
      const needle = anchorNeedle(focus.args);
      if (needle) {
        const at = editor.document.getText().indexOf(needle);
        line = at >= 0 ? editor.document.positionAt(at).line : 0;
      }
    }
    line = Math.min(line, Math.max(0, editor.document.lineCount - 1));
    const range = new vscode.Range(line, 0, line, 0);
    editor.setDecorations(this.liveCaret, [range]);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    this.liveCaretEditor = editor;
  }

  private clearLiveCaret(): void {
    this.liveCaretEditor?.setDecorations(this.liveCaret, []);
    this.liveCaretEditor = undefined;
  }

  /** macOS: hold off idle sleep while any turn runs (caffeinate -di). */
  private ensureAwake(): void {
    if (process.platform !== 'darwin' || this.awakeProcess) {
      return;
    }
    const enabled = vscode.workspace
      .getConfiguration('piRpc')
      .get<boolean>('preventSleepWhileBusy', true);
    if (!enabled) {
      return;
    }
    try {
      this.awakeProcess = spawn('caffeinate', ['-di'], { stdio: 'ignore' });
      this.awakeProcess.on('exit', () => {
        this.awakeProcess = undefined;
      });
    } catch {
      this.awakeProcess = undefined;
    }
  }

  private releaseAwake(): void {
    this.awakeProcess?.kill();
    this.awakeProcess = undefined;
  }

  private ensureWatcher(): void {
    clearTimeout(this.watcherIdleTimer);
    if (this.watcher || this.mode() === 'off') {
      return;
    }
    this.watcher = vscode.workspace.createFileSystemWatcher('**/*');
    const onEvent = (uri: vscode.Uri): void => this.onFsEvent(uri);
    this.watcher.onDidCreate(onEvent);
    this.watcher.onDidChange(onEvent);
    this.showWatchingHeartbeat();
    this.logger?.info('[follow] fs-net armed (a chat is busy)');
  }

  /** While armed with no activity yet: “watching” — so quiet ≠ broken. */
  private showWatchingHeartbeat(): void {
    if (this.mode() === 'off') {
      return;
    }
    this.status.text = '$(eye-watch) π watching files…';
    this.status.tooltip = new vscode.MarkdownString(
      'A chat is running — any file it touches (any tool, even bash) will open here. Quiet means π has not changed files yet.'
    );
    this.status.command = undefined;
    this.status.show();
  }

  private scheduleWatcherIdle(): void {
    if (this.busyChats.size > 0) {
      return;
    }
    clearTimeout(this.watcherIdleTimer);
    this.watcherIdleTimer = setTimeout(() => {
      if (this.busyChats.size === 0 && this.watcher) {
        this.watcher.dispose();
        this.watcher = undefined;
        this.status.hide();
        this.logger?.info('[follow] fs-net disarmed (all chats idle)');
      }
    }, 5000);
  }

  private onFsEvent(uri: vscode.Uri): void {
    if (uri.scheme !== 'file' || this.busyChats.size === 0 || this.mode() === 'off') {
      return;
    }
    const fsPath = uri.fsPath;
    const roots = Array.from(this.busyChats.values()).map((entry) => entry.root);
    if (!shouldTrackFsPath(fsPath, roots)) {
      return;
    }
    // The precision layer already handled it moments ago.
    const acted = this.recentlyActed.get(fsPath);
    if (acted && Date.now() - acted < 2500) {
      return;
    }
    // The USER saving their own file must not count as agent work.
    if (vscode.window.activeTextEditor?.document.uri.fsPath === fsPath) {
      return;
    }
    // Debounce per file: writes often land in quick multiples.
    clearTimeout(this.fsDebounce.get(fsPath));
    this.fsDebounce.set(
      fsPath,
      setTimeout(() => {
        this.fsDebounce.delete(fsPath);
        const attribution =
          Array.from(this.busyChats.values()).find((entry) => entry.visible) ??
          Array.from(this.busyChats.values())[0];
        if (!attribution) {
          return;
        }
        this.recentlyActed.set(fsPath, Date.now());
        this.logger?.info(`[follow] fs-net: ${fsPath} (${attribution.title.trim()})`);
        this.act(
          'editing',
          fsPath,
          attribution.title,
          attribution.visible,
          undefined,
          undefined,
          undefined
        );
      }, 250)
    );
  }

  private resolve(filePath: string, workspaceRoot: string | undefined): string {
    // Pi tools sometimes emit ~-prefixed paths; joining those onto the
    // workspace produced garbage like <root>/~/Desktop/….
    if (filePath === '~' || filePath.startsWith('~/')) {
      return path.join(os.homedir(), filePath.slice(1));
    }
    return path.isAbsolute(filePath) ? filePath : path.join(workspaceRoot ?? '', filePath);
  }

  private act(
    kind: 'editing' | 'reading',
    filePath: string,
    chatTitle: string,
    isActiveChat: boolean,
    workspaceRoot: string | undefined,
    args: string | undefined,
    post?: (payload: unknown) => void,
    key?: string
  ): void {
    const absolute = this.resolve(filePath, workspaceRoot);
    this.recentlyActed.set(absolute, Date.now());
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
    this.statusTimer = setTimeout(
      () => (this.watcher ? this.showWatchingHeartbeat() : this.status.hide()),
      kind === 'editing' ? 9000 : 5000
    );

    // The side pane follows READS and EDITS — but only for the chat you're
    // looking at; parallel background chats narrate in the status bar only.
    const followForced = key !== undefined && this.followOnceKeys.has(key);
    if ((this.mode() !== 'open' && !followForced) || !isActiveChat) {
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
        // Persistent tabs: every file π opens/edits stays open (no cycling
        // slot) so you can flip back through the whole session's files.
        preview: false,
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
    this.releaseAwake();
    this.liveCaret.dispose();
    clearTimeout(this.decorationTimer);
    clearTimeout(this.watcherIdleTimer);
    this.watcher?.dispose();
    for (const timer of this.fsDebounce.values()) {
      clearTimeout(timer);
    }
    this.decoration.dispose();
    clearTimeout(this.statusTimer);
    this.status.dispose();
    this.seen.clear();
  }
}
